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
| `fintrace_explore_start` | 提交探索任务（goal + seed_entities，可选 max_depth / time_range），立即返回 `task_id`（与后台 `job_id`）；任务同时注册为宿主后台 job，完成时自动通知唤醒 agent |
| `fintrace_explore_status` | 单次查询任务状态/进度/终态结果（findings、event_threads、exploration_meta 含 tokens_used）——按需调用，不是轮询手段 |
| `fintrace_explore_cancel` | 取消运行中任务；循环优雅收尾，已产出的 findings 保留在结果里 |

耗时参考：depth=1 约 3-5 分钟，depth=2 约 5-12 分钟，depth=3 约 10-20 分钟。
任务在插件内后台运行，不阻塞单次工具调用。**推荐 agent 侧流程：start → 直接结束回合
（告知用户任务已启动）→ 完成通知自动唤醒 → status 或 job_output 一次性读取结果**；
status 只在用户明确要中途进度、或通知丢失后恢复时单次调用。工具描述与运行中响应
均内置"请勿轮询"引导，避免无谓的 LLM 轮询开销。

## 后台任务与 UI 展示

自 0.2.0 起，每次探索同时注册为宿主后台 job（`ctx.jobs`，kind=`fintrace`），用户安装插件即得：

- **会话头部任务徽标/弹层**（web profile）：运行行显示任务 label、状态、逐秒耗时；终态行保留
  status detail（如 `8 findings · 23 实体 · 51000 tokens`）
- **完成通知**：探索结束（或失败/取消）时 agent 自动收到后台任务通知（忙碌时注入下一步、空闲时唤醒开新 turn），
  无需密集轮询——提交后可直接结束回合，通知会唤醒 agent 汇报；可用宿主 `job_output` 一次性读取最终结果
  JSON（64KB 截断），也可继续用 `fintrace_explore_status` 读取结构化结果
- **宿主 `job_kill` 通道**：与 `fintrace_explore_cancel` 等效（都会触发优雅收尾，保留已产出 findings）
- **工具卡片**：三件套经 `presentCall`/`presentResult` 声明渲染意图 —— status 卡片按阶段显示
  `探索进行中 · step N · X 实体 · Y findings` / `探索完成 · Y findings · Z threads · K tokens`
  及最近步骤、主要发现概览；历史会话回放渲染一致（`presentationMeta` 随会话日志持久化）

说明：job 的 `detail` 为终态字段，运行中的实时进度仍经 `fintrace_explore_status` 卡片刷新；
`ctx.jobs` 不可用的宿主上自动降级为纯 taskStore 模式（行为同 0.1.x）。

### 实时探索面板（自 0.3.0，自带客户端半边）

包内携带 web 客户端 bundle（`dsh.client` 双面包，`exports["./client"]` → `dist/client.js`），
宿主启动时自动发现并入 boot 图，无需用户注册。三件套工具的会话卡片由插件自有 React 组件渲染
（`tool.call.toolview` keyed slot）：

- **`fintrace_explore_start` 卡片 = 实时过程面板**：任务运行中每 3 秒轮询宿主
  `GET /fintrace/task?id=<task_id>`，展示 step/当前决策、实体与 findings 计数、token 预算条、
  最近步骤时间线；任务 settle 后停止轮询、定格终态摘要（counts + 主要 findings + 完成原因）
- **`fintrace_explore_status` 卡片**：按该次调用的 presentationMeta 快照渲染四态
  （进行中/完成/失败/取消），历史会话回放一致；卡片不自动刷新
- **`fintrace_explore_cancel` 卡片**：取消结果

宿主重启或 headless 提交的历史会话回放时无实时数据，面板回退为静态"已提交"视图。
客户端代码只依赖平台基线（React 由宿主 shell 种子提供），不新增 profile 依赖。

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
logLevel: info                # debug | info | warn | error —— agent 循环日志级别
```

日志不写宿主进程 stdout（dsh 自身不打 stdout，插件同样不打）：agent 循环的 pino 日志在
`apply()` 内整体改道进宿主 `ctx.logger`（cordis LoggerService，logger 名 `fintrace`），
与 dsh 自身日志同通道（内存环形缓冲 + 宿主注册的 exporter）；排查问题时调高
`logLevel: debug` 即可在宿主日志里看到完整循环轨迹。

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

web profile 下插件还会在本机 webServer 上注册 `GET /fintrace/task` 只读轮询端点
（返回探索任务进度 JSON：status/progress/最近步骤/终态摘要），供客户端实时面板使用。
该端点与 `/plugins` 静态下发同级、无鉴权——服务器绑定非 localhost 时，同网段可读取探索进度；
请按部署环境自行注意暴露面。

## 与 fin-trace 服务器版的关系

同一 Agent Loop 核心的两种宿主形态：服务器版（Docker 部署，含 Web UI / 账号 / A2A / MCP server）
与本插件（纯推理内核 + 异步任务壳，内存 taskStore，dsh 重启即失）。工具行为对齐
`src/mcp-server.ts` 的 `graph_explore_*` 三件套，差异两处：工具名加 `fintrace_` 前缀；
cancel 真正接线 AbortSignal（服务器版 MCP 的 cancel 仅翻转状态位）。

## License

AGPL-3.0（与 fin-trace 主仓库一致）

## 发布（维护者）

发布走主仓库 CI：push tag `plugin-vX.Y.Z`（与 package.json 版本一致、打在 main 提交上）触发
`plugin-release.yml`，以 `NPM_TOKEN` + npm provenance 发布；**不支持本地 `npm publish`**（账号
2FA）。发布前的 npm 安装路径真机验证纪律与守卫细节见 [docs/plugin-release.md](../../docs/plugin-release.md)。
