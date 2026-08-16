# 基于镜像的 tag 触发部署 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把部署从"服务器端构建"迁移为"CI 构建镜像推 GHCR + tag 触发 + 服务器只拉取"。

**Architecture:** push tag `v*.*.*` 触发 `deploy.yml`：typecheck → buildx 构建镜像 → 推 `ghcr.io/yiwufen/fin-trace:vX.Y.Z` + `:latest` → SSH 服务器写 `.env` 固定 `IMAGE_TAG` → `docker compose pull` + `up -d` → 健康检查重试循环。push main / PR 只跑验证（`ci.yml`：typecheck + docker build）。本地 registry 及其脚本全部移除。

**Tech Stack:** GitHub Actions（docker/build-push-action v6 + buildx + gha cache、appleboy/ssh-action v1）、GHCR、docker compose（`.env` 变量插值）。

**设计 spec:** `docs/superpowers/specs/2026-08-16-image-based-deploy-design.md`（含背景动机与决策依据，实现时不必重读）

## Global Constraints

- 分支：`chore/image-based-deploy`（已存在，spec 已提交）。所有 task 在此分支继续，commit message 用英文。
- 镜像名固定 `ghcr.io/yiwufen/fin-trace`（spec 原文），tag 格式 `vX.Y.Z`，首个 release `v1.0.0`。
- compose 镜像插值：`ghcr.io/yiwufen/fin-trace:${IMAGE_TAG:-latest}`，`.env` 写 `IMAGE_TAG`。
- 本机 node 经 nvm 管理：**执行任何 node/npm/npx 命令前先 `source ~/.nvm/nvm.sh`**。
- 本项目无单元测试框架。验证手段：`npm run typecheck`、`docker build`、yaml 语法校验（`npx --yes js-yaml <file>`）、`docker compose config`。
- 文档语言：中文 + 英文技术术语；风格对齐现有 `docs/deploy.md`（表格、代码块、无废话）。
- 5 个 KG 工具、agent 核心代码在本计划中**零改动**——只动 CI/容器/文档。

---

### Task 1: Dockerfile 移除 BUILD_PROXY

**Files:**
- Modify: `Dockerfile`（第 1-24 行的注释头 + 代理段）

**Interfaces:**
- Consumes: 无
- Produces: 一个不依赖代理参数的多阶段 Dockerfile，构建环境为 GitHub Actions runner（有外网）。Task 3/4 的 workflow 直接 `docker build`/buildx 此文件，不传任何 build-arg。

- [ ] **Step 1: 替换 Dockerfile 头部与构建阶段**

将 `Dockerfile` 第 1-24 行（从 `# 多阶段构建` 注释到 `echo "no build proxy"; fi` 的整个 RUN 块）替换为：

```dockerfile
# 多阶段构建：构建阶段装依赖 + 编译 TS + 构建 web；运行阶段只含产物
#
# 构建在 GitHub Actions 中执行（runner 有外网，无需代理），推送 GHCR；
# 服务器只 docker compose pull，不再本地构建。本地验证直接 docker build。

# ─── 构建阶段 ───
FROM node:20-slim AS builder

WORKDIR /app

```

第 25 行起（`# 先拷包描述以利用 docker 层缓存` 到文件尾）**保持不变**。替换后完整文件应为：

```dockerfile
# 多阶段构建：构建阶段装依赖 + 编译 TS + 构建 web；运行阶段只含产物
#
# 构建在 GitHub Actions 中执行（runner 有外网，无需代理），推送 GHCR；
# 服务器只 docker compose pull，不再本地构建。本地验证直接 docker build。

# ─── 构建阶段 ───
FROM node:20-slim AS builder

WORKDIR /app

# 先拷包描述以利用 docker 层缓存
COPY package.json package-lock.json ./
COPY web/package.json web/package-lock.json ./web/

# 装依赖（含 devDependencies，构建需要 tsx/tsc/vite）
RUN npm ci --include-workspace-root

# 拷全部源码（.dockerignore 已排除 node_modules/dist/data/config.json）
COPY . .

# 编译后端 TS → dist/，构建前端 → web/dist/
RUN npm run build

# ─── 运行阶段（slim）───
FROM node:20-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HEADLESS=true
ENV PORT=3001

# 只装运行时依赖
COPY package.json package-lock.json ./
COPY web/package.json ./web/

# 用构建阶段的依赖树（只装 production 依赖）
RUN npm ci --omit=dev --include-workspace-root || npm install --omit=dev --include-workspace-root

# 拷构建产物
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/config.example.json ./config.example.json

# data/ 通过 volume 挂载，持久化 sessions / settings / share-tokens
RUN mkdir -p data

# node:20-slim 自带 uid 1000 的 node 用户。
# 让 /app 整体归 node 用户，使以 user 1000 运行时能写 config.json / data 卷。
RUN chown -R node:node /app

EXPOSE 3001

# 健康检查：命中 web 根路径
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 以非 root 用户运行（uid 1000，匹配宿主机 deployer，使 data 卷文件 deployer 可读写）
USER node

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: 本地构建验证**

Run: `docker build -t fin-trace:verify .`（在仓库根目录；需外网拉 npm 依赖，约 5-10 分钟）
Expected: 构建成功，最后输出 `naming to docker.io/library/fin-trace:verify`。若 `npm ci` 失败先检查本机网络。

- [ ] **Step 3: 容器冒烟（可选但推荐）**

```bash
docker run -d --rm --name fin-trace-verify -p 30099:3001 fin-trace:verify
sleep 8
curl -fsS -o /dev/null http://localhost:30099/ && echo "SMOKE OK"
docker stop fin-trace-verify
```
Expected: 输出 `SMOKE OK`（web 静态根路径可访问）。

- [ ] **Step 4: Commit**

```bash
git add Dockerfile
git commit -m "build: drop BUILD_PROXY, images are built in CI only"
```

---

### Task 2: compose 切 GHCR 镜像，移除本地 registry

**Files:**
- Modify: `docker-compose.yml`（整文件替换）
- Delete: `scripts/setup-registry.sh`

**Interfaces:**
- Consumes: Task 1 的 Dockerfile 不影响本文件；镜像由 Task 4 的 workflow 推送。
- Produces: compose 期望镜像 `ghcr.io/yiwufen/fin-trace:${IMAGE_TAG:-latest}`（Task 4 部署脚本写 `.env` 里的 `IMAGE_TAG=<tag>`）；registry 服务不再存在；`knowledge-net` 外部网络保留（fin-trace 仍接入，Caddy 反代依赖）。

- [ ] **Step 1: 整体替换 docker-compose.yml**

```yaml
# fin-trace
#
# 部署流程（CI，push tag v*.*.* 触发）:
#   GitHub Actions: docker build → push ghcr.io/yiwufen/fin-trace:vX.Y.Z (+ latest)
#   → SSH 服务器: git pull（同步配置）→ 写 .env (IMAGE_TAG)
#     → docker compose pull → up -d → 健康检查
#
# IMAGE_TAG 由部署脚本写入 .env（gitignored）；缺省 latest。
# GHCR package 为 public，服务器匿名拉取（dockerd 走代理）。

services:
  # ─── 应用 ───
  fin-trace:
    image: ghcr.io/yiwufen/fin-trace:${IMAGE_TAG:-latest}
    container_name: fin-trace
    restart: unless-stopped
    user: "1000:1000"
    ports:
      - "3001:3001"
    environment:
      - BASE_URL=https://fin.yiyiyiwufeng.cn
      - HEADLESS=true
      - PORT=3001
    volumes:
      - ./data:/app/data
      - ./config.json:/app/config.json
    networks:
      - default
      - knowledge-net

networks:
  knowledge-net:
    external: true
    name: repo_knowledge-net
```

- [ ] **Step 2: 删除 registry 初始化脚本**

```bash
git rm scripts/setup-registry.sh
```

- [ ] **Step 3: 验证 compose 语法与插值**

```bash
docker compose config --quiet && echo "default OK"
IMAGE_TAG=v9.9.9 docker compose config | grep 'image: ghcr.io'
```
Expected: 第一条输出 `default OK`；第二条输出 `image: ghcr.io/yiwufen/fin-trace:v9.9.9`。

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): switch to GHCR image, remove local registry"
```

---

### Task 3: 新建 ci.yml（PR / main 验证）

**Files:**
- Create: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 1 的 Dockerfile（纯 `docker build`，不传 build-arg）。
- Produces: 名为 `CI` 的 workflow，PR 与 push main 触发；不推送、不部署（部署归 Task 4 的 `Release` workflow）。

- [ ] **Step 1: 写入 ci.yml**

```yaml
name: CI

# PR / push main: 代码验证。typecheck + docker build（只验证构建，不推送不部署）。
# 发布走 deploy.yml（push tag v*.*.* 触发）。

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Typecheck
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci --include-workspace-root && npm run typecheck

      - name: Docker build (validation only)
        run: docker build -t fin-trace:ci .
```

- [ ] **Step 2: 语法校验**

Run: `source ~/.nvm/nvm.sh && npx --yes js-yaml .github/workflows/ci.yml > /dev/null && echo "YAML OK"`
Expected: `YAML OK`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add PR/main validation workflow"
```

---

### Task 4: 重写 deploy.yml（tag 触发 release + 部署）

**Files:**
- Modify: `.github/workflows/deploy.yml`（整文件替换）

**Interfaces:**
- Consumes: Task 1 Dockerfile、Task 2 compose（`IMAGE_TAG` 插值）、GitHub Secrets `SSH_HOST` / `SSH_USER` / `SSH_PRIVATE_KEY`（沿用现有值）、`GITHUB_TOKEN`（packages: write，无需配置）。
- Produces: 名为 `Release` 的 workflow：job `release`（构建推送 GHCR，产出 `ghcr.io/yiwufen/fin-trace:vX.Y.Z` + `:latest`）→ job `deploy`（SSH 部署该 tag）。服务器侧脚本依赖一次性人工配置（dockerd 代理，见 Task 5 文档），首次发布前未配置会 pull 失败。

- [ ] **Step 1: 整体替换 deploy.yml**

```yaml
name: Release

# 发布流程：push tag v*.*.* 触发（tag 必须打在 main 分支提交上，
# 部署时服务器 git pull origin main 同步 compose/脚本）。
#   1. typecheck + docker build → 推 GHCR（:vX.Y.Z 和 :latest）
#   2. SSH 服务器：写 .env → compose pull → up -d → 健康检查重试
# 服务器 dockerd 已配代理（127.0.0.1:7890）；GHCR package 为 public，匿名拉取。

on:
  push:
    tags: ['v*.*.*']

concurrency:
  group: deploy
  cancel-in-progress: false

permissions:
  contents: read
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Typecheck
        uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci --include-workspace-root && npm run typecheck

      - name: Set up Buildx
        uses: docker/setup-buildx-action@v3

      - name: Login to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Build and push image
        uses: docker/build-push-action@v6
        with:
          context: .
          push: true
          tags: |
            ghcr.io/yiwufen/fin-trace:${{ github.ref_name }}
            ghcr.io/yiwufen/fin-trace:latest
          cache-from: type=gha
          cache-to: type=gha,mode=max

  deploy:
    needs: release
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - name: Deploy on server
        uses: appleboy/ssh-action@v1
        env:
          TAG: ${{ github.ref_name }}
        with:
          host: ${{ secrets.SSH_HOST }}
          username: ${{ secrets.SSH_USER }}
          key: ${{ secrets.SSH_PRIVATE_KEY }}
          timeout: 10m
          command_timeout: 10m
          envs: TAG
          script: |
            set -euo pipefail
            cd ~/fin-trace

            # git 走代理（服务器无法直连 GitHub）；仅同步 compose/脚本，不构建。
            # no_proxy 必须在 git pull 前设置，避免后续 curl localhost 被代理劫持。
            export http_proxy=http://127.0.0.1:7890
            export https_proxy=http://127.0.0.1:7890
            export no_proxy=localhost,127.0.0.1
            git pull origin main

            # 固定本次部署版本（compose 用 IMAGE_TAG 插值镜像 tag）
            echo "IMAGE_TAG=${TAG}" > .env

            # 拉取镜像 + 部署（pull 走 dockerd 代理，无需 shell 代理）
            docker compose pull fin-trace
            docker compose up -d --remove-orphans

            docker image prune -f

            # 健康检查：最多重试 30 次 × 2s（约 1 分钟）
            healthy=0
            for i in $(seq 1 30); do
              if curl -fsS -o /dev/null http://localhost:3001/; then
                healthy=1
                break
              fi
              sleep 2
            done
            if [ "$healthy" != "1" ]; then
              echo "FAIL: fin-trace health check failed"
              docker compose logs --tail 30
              exit 1
            fi

            echo "OK: fin-trace ${TAG} is healthy"
            docker compose ps
```

- [ ] **Step 2: 语法校验**

Run: `source ~/.nvm/nvm.sh && npx --yes js-yaml .github/workflows/deploy.yml > /dev/null && echo "YAML OK"`
Expected: `YAML OK`

- [ ] **Step 3: 确认旧流程引用已全部清除**

Run: `grep -rn "BUILD_PROXY\|localhost:5000\|REGISTRY_" --include="*.yml" --include="*.yaml" --include="Dockerfile" --include="*.sh" .github/ Dockerfile docker-compose.yml scripts/ 2>/dev/null; echo "exit=$?"`
Expected: 无匹配输出（`scripts/` 下 setup-registry.sh 已删，`echo` 显示 exit=1 即 grep 无结果）。

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci(deploy): tag-triggered release via GHCR"
```

---

### Task 5: 重写部署文档（deploy.md + AGENTS.md）

**Files:**
- Modify: `docs/deploy.md`（整文件替换）
- Modify: `AGENTS.md`（Deployment Architecture 章节 + 部署关键约束）

**Interfaces:**
- Consumes: Task 1-4 的最终行为。
- Produces: 与新流程一致的运维文档；"首次发布（人工执行）"章节是 release runbook 的权威来源。

- [ ] **Step 1: 整体替换 docs/deploy.md**

````markdown
# 部署指南

## 架构

```
GitHub Actions (美国)                       百度服务器 (北京)
┌─────────────────────────────┐            ┌─────────────────────────┐
│ 发布: push tag vX.Y.Z 触发   │            │ 运行                    │
│  1. typecheck               │    SSH     │  1. git pull（同步配置） │
│  2. docker build (buildx)   │──触发──→   │  2. 写 .env IMAGE_TAG   │
│  3. push ghcr.io/...:vX.Y.Z │            │  3. compose pull (代理)  │
│     + :latest               │            │  4. compose up -d       │
│                             │            │  5. health check        │
│ 验证: push main / PR        │            │                         │
│   typecheck + docker build  │            │ 镜像: GHCR public       │
└─────────────────────────────┘            └─────────────────────────┘
```

**核心原则**：build once, deploy many —— 镜像只在 CI 构建一次，服务器只拉取运行。**打 tag 即发布**。

- 镜像：`ghcr.io/yiwufen/fin-trace`（GHCR package 为 public，服务器匿名拉取）
- 服务器 dockerd 走代理（`127.0.0.1:7890`）拉取 ghcr.io
- **tag 必须打在 main 分支的提交上**（部署时服务器 `git pull origin main` 同步 compose/脚本）
- 版本号 `vX.Y.Z`：X 破坏性变更、Y 功能、Z 修复

## 初次部署

### 1. 服务器一次性配置

dockerd 代理（拉取 ghcr.io 用）+ 下线旧本地 registry：

```bash
ssh deployer@182.61.1.77

# dockerd 代理
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/proxy.conf > /dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:7890"
Environment="HTTPS_PROXY=http://127.0.0.1:7890"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker   # ⚠ 所有容器短暂中断，选低峰执行

# 下线本地 registry（镜像分发已迁移 GHCR）
cd ~/fin-trace
git pull origin main
docker compose rm -sf registry
# registry-data/ registry-auth/ 目录暂保留，确认稳定后可手动清理
```

### 2. GitHub Secrets

仓库 **Settings → Secrets and variables → Actions**：

| Secret | 值 |
|--------|-----|
| `SSH_HOST` | `182.61.1.77` |
| `SSH_USER` | `deployer` |
| `SSH_PRIVATE_KEY` | CI 专用密钥对的私钥内容（`ssh-keygen -t ed25519 -C "fin-trace-ci"` 生成，公钥在服务器 `~/.ssh/authorized_keys`） |

GHCR 推送用 `GITHUB_TOKEN`（workflow 内置 `packages: write`），无需配置。**删除** 旧的 `REGISTRY_USER` / `REGISTRY_PASSWORD`。

### 3. 启动服务（首次）

```bash
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose up -d'
```

### 4. 获取 admin_token

首次启动自动生成，写入 `data/settings.json`（不打印到日志）：

```bash
ssh deployer@182.61.1.77 'grep admin_token ~/fin-trace/data/settings.json'
```

浏览器访问 `https://fin.yiyiyiwufeng.cn/admin`，输入令牌登录管理后台。

## 日常发布

```bash
git tag vX.Y.Z main && git push origin vX.Y.Z
```

CI 自动完成：typecheck → 构建镜像推 GHCR → SSH 部署该 tag → 健康检查（重试 ~1 分钟）。

**首次发布特殊步骤**（仅一次）：GHCR package 首次推送后默认 private，deploy job 的 `docker compose pull` 会失败。到 GitHub 个人页 → Packages → `fin-trace` → Package settings → Change visibility → **Public**，然后 re-run 失败的 deploy job。

## 回滚

```bash
ssh deployer@182.61.1.77 'cd ~/fin-trace && echo "IMAGE_TAG=vX.Y.旧版" > .env && docker compose pull && docker compose up -d'
```

GHCR 保留全部历史 tag。回滚后下一个正常 release 会覆盖 `.env`，无需手动恢复。

## 运维

```bash
# 查看容器状态 / 日志 / 重启
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose ps'
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose logs -f fin-trace'
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose restart fin-trace'

# 当前运行版本
ssh deployer@182.61.1.77 'cat ~/fin-trace/.env'
```

## 数据备份

```bash
ssh deployer@182.61.1.77 'tar czf - ~/fin-trace/data' > fin-trace-data-backup-$(date +%F).tar.gz
```

## 环境参考

| 项目 | 值 |
|------|-----|
| 服务器 | 182.61.1.77 (百度云, 3.8 GB) |
| 用户 | deployer (uid 1000) |
| 代理 | 127.0.0.1:7890（dockerd systemd drop-in） |
| 项目路径 | ~/fin-trace/（compose/配置载体，不再构建） |
| 镜像 | ghcr.io/yiwufen/fin-trace（public） |
| Admin token | 见服务器 `~/fin-trace/data/settings.json`（**不要写入文档/git**） |

## Web 前端与账户系统

- **无独立前端服务**：镜像构建已包含 web 前端（Dockerfile 多阶段构建中执行 `npm run build -w web`），由同一容器托管
- **账户注册需邀请码**：邀请码在管理后台（`/admin`）维护，存于 `data/settings.json` 的 `web.invite_codes`
- **用户数据**：`data/users.json`；备份 `data/` 目录即覆盖会话、设置（admin_token/邀请码）、分享令牌与用户
- **健康检查**：CI 部署后 curl 重试循环（Dockerfile HEALTHCHECK 同源 `/`）

## 踩坑记录

### ghcr.io 拉取失败

pull 走 dockerd 代理（systemd drop-in）。失败时依次检查：`systemctl show docker --property=Environment`（代理是否生效）、`curl -x http://127.0.0.1:7890 -sI https://ghcr.io/v2/`（代理规则是否放行 GitHub CDN）。

### 历史遗留：本地 Registry（已于 2026-08 下线）

早期部署使用 `localhost:5000` 本地 registry + htpasswd 认证 + 服务器端构建（`--network host` + `BUILD_PROXY`）。迁移 GHCR 后相关复杂度全部移除；`registry-data/`、`registry-auth/` 目录在服务器上待清理。

### 历史遗留：凭据轮换

2026-08 之前的文档版本曾明文写入 Registry 密码与 admin token（已进 git 历史）。若使用旧环境，请轮换：删除 `data/settings.json` 中的 `admin_token` 字段让服务重新生成。
````

- [ ] **Step 2: 更新 AGENTS.md 部署章节**

将 AGENTS.md 中 `## Deployment Architecture` 到 `### 部署关键约束` 列表结束（即 `config.json` 引用行之前的整块）替换为：

````markdown
## Deployment Architecture

```
GitHub Actions                       百度服务器 182.61.1.77
push tag vX.Y.Z ─→ typecheck         git pull（仅同步配置）
                    buildx 构建镜像    写 .env IMAGE_TAG
                    push GHCR ──SSH──→ compose pull + up -d
                                      health check (curl localhost:3001/)
push main / PR ─→ CI 仅验证（typecheck + docker build）

镜像: ghcr.io/yiwufen/fin-trace:vX.Y.Z（+ latest，package public）
环境: deployer@182.61.1.77, ~/fin-trace/（配置载体，不构建）, 3.8 GB 内存
```

### 部署关键约束

- **build once, deploy many** — 镜像只在 GitHub Actions 构建，服务器不构建；服务器 `git pull` 仅同步 compose/脚本
- **tag 打在 main 提交上** — 部署时服务器 `git pull origin main`，tag 指向非 main 提交会导致 compose 与镜像不一致
- **服务器无法直连外网** — dockerd 走代理 `127.0.0.1:7890` 拉取 ghcr.io（systemd drop-in，一次性配置）；重启 docker 会中断所有容器
- **GHCR package 为 public** — 服务器匿名拉取，无服务器侧凭据；镜像不含密钥（config/data 均为 volume 挂载，`.dockerignore` 排除）
- **回滚 = 重部署旧 tag** — `echo "IMAGE_TAG=<旧版>" > .env && docker compose pull && docker compose up -d`
- **旧 Registry 数据目录不可 `--delete` 同步** — `registry-data/`、`registry-auth/` 需排除（本地 registry 已于 2026-08 下线，目录待清理）
- **Caddy 修改后必须 `docker restart`** — `caddy reload` 有 bind mount 缓存（Caddy 属外部 knowledge-net 部署，不在本仓库）
- **CI 用独立 SSH 密钥对** — `ssh-keygen -t ed25519 -C "fin-trace-ci"` 生成，公钥写入 `authorized_keys`，私钥存 GitHub Secrets
- 完整部署文档：`docs/deploy.md`
````

其后原有的 `config.json` / `data/` 两行说明保留不动。

- [ ] **Step 3: 交叉检查文档与实际文件一致**

Run: `grep -c "ghcr.io/yiwufen/fin-trace" docs/deploy.md AGENTS.md docker-compose.yml .github/workflows/deploy.yml`
Expected: 四个文件均有 ≥1 处匹配（`grep -c` 逐文件计数，无 0）。

- [ ] **Step 4: Commit**

```bash
git add docs/deploy.md AGENTS.md
git commit -m "docs: rewrite deployment guide for image-based deploys"
```

---

## 首次发布（人工执行，合并 PR 后）

代码任务全部完成并合并 main 后，按 `docs/deploy.md` "初次部署"章节执行：

1. 服务器：dockerd 代理 drop-in + `systemctl restart docker`（低峰）→ `docker compose rm -sf registry`
2. GitHub：删除 Secrets `REGISTRY_USER` / `REGISTRY_PASSWORD`
3. `git tag v1.0.0 main && git push origin v1.0.0`
4. deploy job 首次会因 package private 而失败 → GitHub UI 将 package `fin-trace` 切为 **Public** → re-run deploy job
5. 验证：`ssh deployer@182.61.1.77 'cat ~/fin-trace/.env'`（应显示 `IMAGE_TAG=v1.0.0`）+ 线上 `/` 可访问
6. 回归：确认聊天/登录/分享功能正常（容器已换镜像源）
