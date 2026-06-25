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

```bash
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose logs' | grep admin_token
```

用输出的深链 `https://fin.182-61-1-77.nip.io/?admin=<token>` 登录管理后台。

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

docker compose pull && docker compose up -d --remove-orphans
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
| Registry 密码 | kI7psKGk6hVZWPtzb/IE+dw3wuQiKQI0 |
| Admin token | yNlMWVeB-K3md6T0cS3eIcum |

## 踩坑记录

### Docker Hub 不可达 → 代理

`~/.docker/config.json` 中配置代理拉取基础镜像；推送本地镜像时**必须移除**代理，否则 localhost 流量也被劫持。

### npm install 需要代理 → `--network host`

`docker build --network host --build-arg BUILD_PROXY=...` 让构建容器共享宿主机网络访问代理。

### Caddy bcrypt hash 格式

Apache htpasswd 的 `$2y$` 格式与 Caddy basic_auth 不兼容。不再需要（Registry 仅 localhost）。

### caddy reload 不生效

修改 Caddyfile 后必须 `docker restart knowledge-caddy`，reload 有缓存。

### rsync --delete 误删

排除 `data/`、`registry-data/`、`registry-auth/`、`config.json`。
