# 部署指南

## 架构

```
GitHub Actions (美国)              百度服务器 (北京)
┌─────────────────────┐           ┌──────────────────────────┐
│ CI: 代码验证         │           │ CD: 构建 + 部署           │
│                     │   SSH     │                          │
│ 1. checkout         │──触发──→  │ 1. git pull              │
│ 2. npm ci           │           │ 2. docker build (代理)    │
│ 3. typecheck        │           │ 3. docker push localhost  │
│                     │           │ 4. docker compose up -d   │
│ 成功 → 触发 CD      │           │ 5. health check          │
│ 失败 → 阻断         │           │                          │
└─────────────────────┘           └──────────────────────────┘
```

**核心原则**：CI 在美国做（验证代码），CD 在北京做（只有北京有代理、有本地 Registry）。

Registry 仅监听 `127.0.0.1:5000`，不对外暴露。

## 初次部署

### 1. 初始化 Registry（服务器上运行一次）

```bash
ssh deployer@182.61.1.77
cd ~/fin-trace
bash scripts/setup-registry.sh
```

### 2. 配置 GitHub Secrets

在仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 值 |
|--------|-----|
| `REGISTRY_USER` | `fin-trace` |
| `REGISTRY_PASSWORD` | setup-registry.sh 输出的密码 |
| `SSH_HOST` | `182.61.1.77` |
| `SSH_USER` | `deployer` |
| `SSH_PRIVATE_KEY` | CI 专用密钥对的私钥内容（建议 `ssh-keygen -t ed25519 -C "fin-trace-ci"` 生成，公钥加入服务器 `~/.ssh/authorized_keys`） |

### 3. 启动服务

```bash
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose up -d registry && docker compose up -d'
```

### 4. 获取 admin_token

首次启动时服务会自动生成 `admin_token` 并写入 `data/settings.json`（**不会打印到日志**）：

```bash
ssh deployer@182.61.1.77 'grep admin_token ~/fin-trace/data/settings.json'
```

浏览器访问 `https://fin.182-61-1-77.nip.io/admin`，输入令牌登录管理后台。

## 日常部署

推送 main 分支即可自动触发：

```bash
git push origin main
```

CI 自动完成：类型检查 → SSH 触发服务器自构建 → 部署 → 健康检查。

### 手动部署（CI 不可用时）

```bash
ssh deployer@182.61.1.77
cd ~/fin-trace
git pull origin main

docker build --network host --build-arg BUILD_PROXY=http://127.0.0.1:7890 \
  -t localhost:5000/fin-trace:latest .

# 推送前临时移除代理
mv ~/.docker/config.json ~/.docker/config.json.bak 2>/dev/null || true
echo '{}' > ~/.docker/config.json
echo "<密码>" | docker login localhost:5000 -u fin-trace --password-stdin
docker push localhost:5000/fin-trace:latest
mv ~/.docker/config.json.bak ~/.docker/config.json 2>/dev/null || true

docker compose up -d --remove-orphans   # 用本机刚构建的镜像；不要 pull（本地 registry 需认证，且凭据不持久化）
docker image prune -f
```

## 运维

```bash
# 查看容器状态
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose ps'

# 查看日志
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose logs -f fin-trace'

# 重启
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose restart fin-trace'
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
| 代理 | 127.0.0.1:7890 |
| 项目路径 | ~/fin-trace/ |
| Registry | localhost:5000 (仅本机) |
| Registry 用户 | fin-trace |
| Registry 密码 | 见服务器 `~/fin-trace/registry-auth/`（**不要写入文档/git**） |
| Admin token | 见服务器 `~/fin-trace/data/settings.json`（**不要写入文档/git**） |

> ⚠️ **安全**: 早期版本的本文档曾明文写入过 Registry 密码与 admin token（已进入 git 历史）。若使用 2026-08 之前部署的环境，请轮换这两项凭据：重新运行 `scripts/setup-registry.sh` 生成新密码（并同步 GitHub Secrets），删除 `data/settings.json` 中的 `admin_token` 字段让服务重新生成。

## Web 前端与账户系统

- **无独立前端服务**：镜像构建已包含 web 前端（Dockerfile 多阶段构建中执行 `npm run build -w web`），由同一容器托管
- **账户注册需邀请码**：邀请码在管理后台（`/admin`）维护，存于 `data/settings.json` 的 `web.invite_codes`
- **用户数据**：`data/users.json`；备份 `data/` 目录即覆盖会话、设置（admin_token/邀请码）、分享令牌与用户
- **健康检查**：CI 部署后 `curl http://localhost:3001/`（Dockerfile HEALTHCHECK 同源）

## 踩坑记录

### Docker Hub 不可达 → 代理

`~/.docker/config.json` 中配置代理拉取基础镜像；推送本地镜像时**必须移除**代理，否则 localhost 流量也被劫持。

### npm install 需要代理 → `--network host`

`docker build --network host --build-arg BUILD_PROXY=...` 让构建容器共享宿主机网络访问代理。
