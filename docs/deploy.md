# 部署指南（公开访问 / HR 分享）

将 fin-trace 部署到 baidu 服务器（182.61.1.77，已装 Docker），对外通过 **https://fin.182-61-1-77.nip.io** 访问。HR 通过分享链接（带使用次数限制）查看演示会话并发起有限次对话。

## 架构

```
HR 浏览器
  │  https://fin.182-61-1-77.nip.io/s/<token>   ← 分享链接（限次）
  │  https://fin.182-61-1-77.nip.io/?admin=<token>  ← 管理后台深链
  ▼
baidu 服务器 (182.61.1.77)
  ├── Docker: fin-trace 容器 (:3001)   ← 本项目
  └── KG MCP 服务 (:443, nip.io)       ← 已有，容器内通过 MCP 调用
```

## 一次部署

### 1. 同步并启动

在本机（Git Bash / WSL）执行：

```bash
bash deploy.sh
```

脚本会用 rsync 把源码同步到 `baidu:~/fin-trace/`，再 `docker compose up -d --build`。
`data/` 不同步 —— 运行时数据（sessions / settings / share-tokens）持久化在服务器。

### 2. 首次启动日志里有 admin_token

首次启动时若未配置 `admin_token`，会自动生成并打印到容器日志：

```bash
ssh baidu 'cd ~/fin-trace && docker compose logs' | grep admin_token
```

日志形如：

```
首次部署：已自动生成 admin_token ...（用于管理端访问）
管理端深链：/?admin=<token>     复制此链接登录管理后台
```

> 用这个深链 `https://fin.182-61-1-77.nip.io/?admin=<token>` 登录管理后台（token 会存入 localStorage）。

## 配置（管理后台）

登录后点右上角 **设置**：

1. **LLM**：填 provider / base_url / model / api_key（DeepSeek / OpenAI / Anthropic）
2. **Knowledge Graph**：确认 endpoint（默认 `https://182-61-1-77.nip.io/mcp`），可点「测试连接」
3. **公开访问**：
   - **展示会话（Demo）**：下拉选一个已完成的会话（如「分析今天A股人工智能方面的事件脉络」），HR 可只读查看（不计次数）
   - **管理令牌**：已自动生成，可在此更新

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
# 更新部署（本地有改动后）
bash deploy.sh

# 查看实时日志
ssh baidu 'cd ~/fin-trace && docker compose logs -f'

# 重启
ssh baidu 'cd ~/fin-trace && docker compose restart'

# 停止 / 删除
ssh baidu 'cd ~/fin-trace && docker compose down'
```

## 数据备份

所有运行时数据在服务器 `~/fin-trace/data/`：

```
data/
├── settings.json        # LLM + MCP + admin_token + demo_session_id
├── share-tokens.json    # 所有分享令牌
└── sessions/            # 会话记录（含 demo）
```

备份示例：

```bash
ssh baidu 'tar czf - ~/fin-trace/data' > fin-trace-data-backup-$(date +%F).tar.gz
```
