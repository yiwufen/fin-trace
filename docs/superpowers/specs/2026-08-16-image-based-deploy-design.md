# 基于镜像的 tag 触发部署 — 设计文档

- 日期：2026-08-16
- 状态：已批准（待实现）
- 分支：`chore/image-based-deploy`

## 背景与动机

当前部署方式（`deploy.yml` v1）：GitHub Actions 仅做 typecheck，SSH 触发生产服务器 `git pull` → 在服务器上 `docker build`（走代理）→ 推 `localhost:5000` 本地 registry → `docker compose up -d`。

存在的问题：

| # | 问题 | 症状 |
|---|------|------|
| 1 | 构建发生在生产服务器（3.8 GB 内存） | `npm ci` + `vite build` 与线上服务抢资源；`--network host` / `BUILD_PROXY` 等构建期网络开口永久留在生产机 |
| 2 | CI 验证 ≠ 部署产物 | typecheck 在 GitHub runner 跑，镜像在服务器从 `git pull` 结果构建；Dockerfile/lockfile 破损到部署时刻才暴露；服务器 checkout 与运行容器可能漂移 |
| 3 | 本地 registry 只写不读 | compose 不做 `docker compose pull`（见 compose 注释），registry 仅作 tag 备份；为它付出 htpasswd 认证、`config.json` 备份/恢复等全部复杂度 |
| 4 | 回滚无闭环 | SHA tag 推了但无对应流程 |
| 5 | 代理复杂度泄漏进部署脚本 | `BUILD_PROXY`、`--network host`、客户端代理移除均源于"在服务器上构建" |

## 目标

- **Build once, deploy many**：镜像只在 CI 构建一次，服务器只拉取运行
- **tag 即发布**：`git push tag vX.Y.Z` 一步完成构建 → 推送 → 部署
- 删除本地 registry 及其全部配套复杂度
- 回滚文档化为一行命令

## 非目标

- 自动回滚（单机产品、部署频次低，手动 + 文档足够）
- 多环境（staging 等）部署
- Kubernetes / 多服务器编排

## 触发模型

| 事件 | 工作流 | 行为 |
|------|--------|------|
| PR / push main | `ci.yml`（新建） | typecheck + `docker build`（验证构建，不推送不部署） |
| push tag `v*.*.*` | `deploy.yml`（重写） | typecheck → buildx 构建 → 推 GHCR → SSH 部署该 tag → 健康检查 |

- main 分支从此只验证，不部署
- 版本号约定 `vX.Y.Z`：X 破坏性变更、Y 功能、Z 修复
- 首个 release：`v1.0.0`
- **tag 必须打在 main 分支的提交上**（部署时服务器 `git pull origin main` 同步 compose/脚本，tag 指向非 main 提交会导致 compose 与镜像不一致）

## 镜像构建与分发

- 镜像：`ghcr.io/yiwufen/fin-trace`
- release 时推两个 tag：`:vX.Y.Z` + `:latest`
- CI 侧认证：`GITHUB_TOKEN` + `permissions: packages: write`（`docker/login-action`），**零新增 secret**
- 缓存：buildx `cache-from/to: type=gha`
- GH runner 有外网，`Dockerfile` 的 `BUILD_PROXY` 段整体删除
- 仓库为 public，package 首推后在 GitHub UI 切为 public（一次性），服务器即可**匿名拉取**，无需 ghcr 登录与 PAT

## 服务器部署流程（deploy job）

```
ssh → cd ~/fin-trace
   → git pull（仅同步 compose/脚本等配置，不再构建）
   → echo "IMAGE_TAG=vX.Y.Z" > .env
   → docker compose pull fin-trace（dockerd 走代理）
   → docker compose up -d --remove-orphans
   → 健康检查（curl 重试循环 ~60s，替代原 sleep 10 单次探测）
   → docker image prune -f
```

- `docker-compose.yml` 镜像改为 `ghcr.io/yiwufen/fin-trace:${IMAGE_TAG:-latest}`
- `.env` 固定当前版本；服务器上 `docker compose restart` 等运维操作读取 `.env`，不受影响
- 服务器 checkout 从"构建源"降级为"配置载体"

## 一次性迁移步骤（人工，写入 deploy.md）

1. **dockerd 配代理**：
   `/etc/systemd/system/docker.service.d/proxy.conf` 设 `HTTP_PROXY`/`HTTPS_PROXY=http://127.0.0.1:7890`、`NO_PROXY=localhost,127.0.0.1`，然后 `systemctl daemon-reload && systemctl restart docker`。
   ⚠ 重启 docker 会短暂中断所有容器，选低峰执行。此后客户端 `config.json` 代理与备份/恢复舞蹈不再需要。
2. **首次 release**：第一次推包后 package 默认 private，deploy job 的 pull 会失败——在 GitHub UI 把 package 切 public，re-run deploy job（仅首次需要）。
3. **下线本地 registry**：见下节。

## 本地 registry 下线

- `docker-compose.yml` 删除 `registry` 服务（`knowledge-net` 外部网络保留，fin-trace 仍需）
- 删除 `scripts/setup-registry.sh`
- 服务器执行 `docker rm -f fin-trace-registry`；`registry-data/`、`registry-auth/` 目录暂保留，日后清理
- GitHub Secrets 删除 `REGISTRY_USER` / `REGISTRY_PASSWORD`

## 回滚（手动，一行命令）

```bash
ssh deployer@182.61.1.77 'cd ~/fin-trace && echo "IMAGE_TAG=<旧版本>" > .env && docker compose pull && docker compose up -d'
```

GHCR 保留全部历史 tag 镜像。

## 文件改动清单

| 文件 | 改动 |
|------|------|
| `.github/workflows/deploy.yml` | 重写：tag 触发、buildx + gha 缓存、GHCR 推送、新部署脚本 |
| `.github/workflows/ci.yml` | 新建：PR/main 验证（typecheck + docker build） |
| `Dockerfile` | 删 `BUILD_PROXY` 段及"服务器构建"注释头 |
| `docker-compose.yml` | 镜像改 GHCR + `IMAGE_TAG` 插值，删 registry 服务 |
| `scripts/setup-registry.sh` | 删除 |
| `docs/deploy.md` | 重写：新架构图、迁移步骤、打 tag 发布、回滚命令 |
| `AGENTS.md` | 更新 Deployment Architecture 章节与部署关键约束 |

## 风险与边界

| 风险 | 评估与对策 |
|------|-----------|
| ghcr.io 代理不可达 | git pull GitHub 走代理已验证可行，ghcr.io 同属 GitHub CDN，预计可达；首次 pull 失败则排查代理规则（写入 troubleshooting） |
| docker restart 中断 | 一次性、可控、选低峰 |
| compose 文件更新 | 随 release 的 `git pull` 同步 |
| Actions 分钟配额 | public 仓库免费 |
| 镜像公开 | 仓库代码本就公开；镜像不含密钥（config.json / data 均为 volume 挂载，.dockerignore 已排除） |
