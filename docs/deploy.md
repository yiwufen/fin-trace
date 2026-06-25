# 部署指南

将 fin-trace 部署到 baidu 服务器（182.61.1.77，已装 Docker），对外通过 **https://fin.182-61-1-77.nip.io** 访问。HR 通过分享链接（带使用次数限制）查看演示会话并发起有限次对话。

## 架构

```
GitHub (源码)
  │  git push main
  ▼
GitHub Actions (CI)
  │  docker build → push 到私有 Registry
  ▼
baidu 服务器 (182.61.1.77)
  ├── Caddy (knowledge-caddy, 外部项目)
  │     ├── https://fin.182-61-1-77.nip.io/*        → fin-trace:3001
  │     └── https://registry.fin.182-61-1-77.nip.io/* → fin-trace-registry:5000
  ├── Docker: fin-trace 容器 (:3001)     ← 本项目
  ├── Docker: fin-trace-registry (:5000)  ← CI 构建产物存储
  └── KG MCP 服务 (:443, nip.io)         ← 已有，容器内通过 MCP 调用
```

日常部署仅传输增量 Docker 镜像层（通常几 MB），秒级完成。

## 初次部署（一次性操作）

### 1. 在服务器上初始化 Registry

```bash
ssh deployer@182.61.1.77
cd ~/fin-trace
bash scripts/setup-registry.sh
```

脚本会：
- 生成 Registry 用户名/密码（Basic Auth）
- 创建 `registry-data/` 和 `registry-auth/htpasswd`
- 打印需配置的 GitHub Secrets 和 Caddy 路由片段

### 2. 更新 Caddy 配置

在 knowledge-caddy 项目的 Caddyfile 中添加 Registry 路由（脚本会打印完整片段）：

```
registry.fin.182-61-1-77.nip.io {
    basic_auth { ... }
    reverse_proxy fin-trace-registry:5000
}
```

然后 reload Caddy。

### 3. 配置 GitHub Secrets

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中添加：

| Secret | 值 |
|--------|-----|
| `REGISTRY_USER` | setup-registry.sh 输出的用户名 |
| `REGISTRY_PASSWORD` | setup-registry.sh 输出的密码 |
| `SSH_HOST` | `182.61.1.77` |
| `SSH_USER` | `deployer` |
| `SSH_PRIVATE_KEY` | `~/.ssh/id_rsa` 的完整内容 |

### 4. 启动 Registry 并触发首次部署

```bash
# 在服务器上启动 Registry 容器
cd ~/fin-trace && docker compose up -d registry

# 本地推送代码触发 CI 部署
git push origin main
```

CI 会自动构建镜像、推送到私有 Registry，然后 SSH 到服务器拉取并启动。

### 5. 获取 admin_token

首次启动后从容器日志获取管理令牌：

```bash
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose logs' | grep admin_token
```

用输出的深链 `https://fin.182-61-1-77.nip.io/?admin=<token>` 登录管理后台。

## 配置（管理后台）

登录后点右上角 **设置**：

1. **LLM**：填入 API Key（provider / model 等基础设施已在 config.json 中配置，只读展示）
2. **Knowledge Graph**：确认 endpoint（从 config.json 读取），可点「测试连接」，如需填 API Key
3. **公开访问**：管理令牌已自动生成，可在此更新

## 创建 HR 分享链接

管理后台点右上角 **分享**：

1. 输入标签（如 `HR-张三`）+ 使用次数（如 `5`）
2. 点「创建」 → 列表里出现一条，点「复制链接」得到 `https://fin.182-61-1-77.nip.io/s/<token>`
3. 把链接发给 HR

**配额语义**：
- 查看演示会话 / 接收 SSE **不计次数**
- HR **每发送一条消息消耗 1 次**
- 用完或被禁用后，链接显示「已失效」，HR 无法再发消息（仍可看演示）

## 日常运维

```bash
# 推送代码即可自动部署（GitHub Actions）
git push origin main

# 手动部署（跳过 CI，在服务器上直接拉取最新镜像）
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose pull && docker compose up -d --remove-orphans'

# 查看实时日志
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose logs -f'

# 重启
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose restart'

# 停止 / 删除
ssh deployer@182.61.1.77 'cd ~/fin-trace && docker compose down'
```

## 数据备份

所有运行时数据在服务器 `~/fin-trace/data/`：

```
data/
├── settings.json        # LLM + MCP 凭据 + admin_token + demo_session_id
├── share-tokens.json    # 所有分享令牌
└── sessions/            # 会话记录（含 demo）
```

备份示例：

```bash
ssh deployer@182.61.1.77 'tar czf - ~/fin-trace/data' > fin-trace-data-backup-$(date +%F).tar.gz
```
