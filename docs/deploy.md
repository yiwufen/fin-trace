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

> 本节为一次性迁移 / 全新服务器初始化指南，**已于 2026-08-16 全部执行完毕**（v1.0.0 上线）；日常操作见下方"日常发布"。勿无脑重跑 §1——下方 drop-in 是覆盖写，会抹掉服务器现有 `NO_PROXY` 中的 `baidubce.com` 项。

### 1. 服务器一次性配置

dockerd 代理（拉取 ghcr.io 用）+ 下线旧本地 registry。

本服务器现状（2026-08-15 已配）：`/etc/systemd/system/docker.service.d/http-proxy.conf` 已存在且生效，`NO_PROXY=localhost,127.0.0.1,baidubce.com`——代理部分**无需执行**；下方片段仅用于全新服务器：

```bash
ssh deployer@182.61.1.77

# dockerd 代理（仅全新服务器需要；本服务器已配置，勿覆盖）
sudo mkdir -p /etc/systemd/system/docker.service.d
sudo tee /etc/systemd/system/docker.service.d/proxy.conf > /dev/null <<'EOF'
[Service]
Environment="HTTP_PROXY=http://127.0.0.1:7890"
Environment="HTTPS_PROXY=http://127.0.0.1:7890"
Environment="NO_PROXY=localhost,127.0.0.1"
EOF
sudo systemctl daemon-reload
sudo systemctl restart docker   # ⚠ 所有容器短暂中断，选低峰执行

# 下线本地 registry（镜像分发已迁移 GHCR；已执行）
# git 走代理（服务器无法直连 GitHub）
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
export no_proxy=localhost,127.0.0.1
cd ~/fin-trace
git pull origin main
docker rm -f fin-trace-registry
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

首次启动需在首个 release tag 推送之后执行（此前 GHCR 上尚无 latest 镜像）；存量服务器迁移无需此步。

### 4. 获取 admin_token

首次启动自动生成，写入 `data/settings.json`（不打印到日志）：

```bash
ssh deployer@182.61.1.77 'grep admin_token ~/fin-trace/data/settings.json'
```

浏览器访问 `https://fin.yiyiyiwufeng.cn/admin`，输入令牌登录管理后台。

## 日常发布

**push main 对所有人禁止**（见 AGENTS.md「git 工作流拦截」）：改动一律经分支 + PR 合并进 main，再打 tag。

```bash
# 1. 改动在 feature 分支提交 → PR 合并进 main（GitHub UI 或 gh pr merge）
# 2. 同步本地 main，打 tag 触发部署
git checkout main && git pull origin main
git tag vX.Y.Z main && git push origin vX.Y.Z
```

CI 自动完成：typecheck → 构建镜像推 GHCR → SSH 部署该 tag → 健康检查（重试 ~1 分钟）。

**package 可见性**：公开仓库经 Actions 推送的 GHCR package **自动 public**（2026-08-16 v1.0.0 首发实测），服务器匿名拉取，无需手动设置。仅当仓库转为私有后，才需在 GitHub UI 将 package 保持 public（或给服务器配置 ghcr 登录）。

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

### 服务器 checkout 必须保持干净

deploy 脚本的 `git pull origin main` 会因本地未提交修改而中止（2026-08-16 首次部署实际遇到：服务器上手工改过的 `docker-compose.yml` 阻塞 pull，报 `Your local changes ... would be overwritten by merge`）。服务器上的配置修改一律提交进仓库、随 release 下发；如遇此错，`git status` 确认改动已被仓库内容覆盖后 `git checkout -- <file>`，再 re-run 失败的 deploy job。

### 历史遗留：本地 Registry（已于 2026-08 下线）

早期部署使用 `localhost:5000` 本地 registry + htpasswd 认证 + 服务器端构建（`--network host` + `BUILD_PROXY`）。迁移 GHCR 后相关复杂度全部移除；服务器上 `registry-data/`、`registry-auth/` 目录与 `docker-compose.yml.bak.20260815` 手改备份待清理。

### 历史遗留：凭据轮换

2026-08 之前的文档版本曾明文写入 Registry 密码与 admin token（已进 git 历史）。若使用旧环境，请轮换：删除 `data/settings.json` 中的 `admin_token` 字段让服务重新生成。
