# dsh-fin-trace

[DeepSeek Harness (dsh)](https://deepseek.com/harness/en/) 插件：将 [fin-trace](https://github.com/yiwufen/fin-trace)
的金融知识图谱多跳关系推理 Agent Loop（EXPLORING → FINALIZE 状态机）嵌入 dsh 宿主进程，
以异步工具三件套暴露给 dsh agent。

## 安装

```bash
dsh plugin --profile web add @lihangcz/dsh-fin-trace
```

安装后重启 dsh 生效（bundle 补丁层需重启激活）。卸载：Settings → Plugins 管理，或按
`cordis.patch.yml` 中 `fin-trace-explore` 行自行覆盖/禁用。

> 兼容性标注：实测 dsh 版本 `0.1.1-rc.2`（`--profile headless` 真机验证：插件加载、
> 三工具注册与调用、异步任务全链路、优雅降级路径）。dsh 处于 rc 阶段，API 可能变动。

## 工具

| 工具 | 说明 |
|------|------|
| `fintrace_explore_start` | 提交探索任务（goal + seed_entities，可选 max_depth / time_range），立即返回 `task_id` |
| `fintrace_explore_status` | 轮询任务：status / progress / 最近步骤 / 终态结果（findings、event_threads、exploration_meta 含 tokens_used） |
| `fintrace_explore_cancel` | 取消运行中任务；循环优雅收尾，已产出的 findings 保留在结果里 |

耗时参考：depth=1 约 3-5 分钟，depth=2 约 5-12 分钟，depth=3 约 10-20 分钟。
任务在插件内后台运行，不阻塞单次工具调用；agent 侧 start → 干别的 → 隔步 status 轮询即可。

产出结构（与 fin-trace 服务器版完全一致，同一份核心代码）：

- **findings** 三层路由：`entity_flags` / `cluster_flags` / `key_insights`，四类
  （pattern_violation / concentration / chain / absence），每条带 KU ID 证据
- **event_threads**：事件线程（thread_events 的 ku_id 经原始事件归档校验），含因果/时序/共实体/矛盾关系
- **exploration_meta**：completion_reason、统计（steps / entities / findings / tokens_used）、探索日志、reliability_note

## 配置

dsh 插件配置面板（Config schema），代码内另有同值默认值兜底：

```yaml
llm:
  provider: openai            # openai | anthropic
  base_url: https://api.deepseek.com
  model: deepseek-v4-pro
  max_tokens: 128000          # 兼作探索 token 预算
  api_key: ""                 # 留空则依次取 OPENAI_API_KEY / DEEPSEEK_API_KEY 环境变量
kg:
  url: https://kg.yiyiyiwufeng.cn/mcp
  transport: streamable-http  # streamable-http | sse
  api_key: ""                 # 默认端点需要鉴权，务必填写（否则任务以 mcp_unavailable 结束）
maxConcurrentTasks: 2         # 并发上限（每任务占一条 3-20 分钟的 KG 长连接）
taskTtlMinutes: 60            # 终态任务保留时长
runningTimeoutMinutes: 30     # 运行超时（超时中止并标记 failed）
```

在 profile 的用户 patch 层（`~/.dsh/profiles/<name>/cordis.patch.yml`）可按 id 覆盖本插件配置，
无需改包：

```yaml
- id: fin-trace-explore
  config:
    kg:
      api_key: <your-kg-key>
    llm:
      api_key: <your-llm-key>
```

## 网络出口（egress）披露

插件进程内直连两个外部端点：

1. LLM API：默认 `https://api.deepseek.com`（按 `llm.base_url` 配置），消耗你自己账户的 token
2. 知识图谱 MCP：默认 `https://kg.yiyiyiwufeng.cn/mcp`（按 `kg.url` 配置）

除这两个端点与 dsh 自身行为外，本插件不发起其他网络请求、不读写宿主文件系统
（核心循环的 config.json / data/settings.json 文件路径已通过依赖注入旁路）。

## 与 fin-trace 服务器版的关系

同一 Agent Loop 核心的两种宿主形态：服务器版（Docker 部署，含 Web UI / 账号 / A2A / MCP server）
与本插件（纯推理内核 + 异步任务壳，内存 taskStore，dsh 重启即失）。工具行为对齐
`src/mcp-server.ts` 的 `graph_explore_*` 三件套，差异两处：工具名加 `fintrace_` 前缀；
cancel 真正接线 AbortSignal（服务器版 MCP 的 cancel 仅翻转状态位）。

## License

AGPL-3.0（与 fin-trace 主仓库一致）
