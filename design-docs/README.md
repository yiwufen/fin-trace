# Graph Explorer Agent — 主文档

## 是什么

Graph Explorer Agent 是金融知识图谱上的多跳关系推理专用 Agent。

## 架构约束

- **运行时**: 独立 TypeScript 进程，不跑在任何 Agent 框架里
- **数据层**: 双数据源 — knowledge-graph MCP（关系推理）+ neodata（实时金融数据）
- **对外接口**: A2A Agent，暴露 `graph_explore` skill（Agent Card 在 `/.well-known/agent-card.json`）
- **核心原则**: Agent Loop 全在自己代码里，"库优于框架"

## v3 架构（双层循环 + 双数据源）

```
外层 Loop（对话循环，面向用户）
  用户消息 → LLM 判断意图 → 选择数据源
    ├─ 实时行情/财报/板块/宏观 → query_financial_data (neodata)
    ├─ 多跳关系推理 → graph_explore (KG)
    ├─ 两者都需要 → 先查行情 → 提取实体 → 再探索关系
    ├─ 直接回复（澄清/闲聊/追问回答）
    └─ 追问用户（参数不足）
         ↓
       内层 Loop（探索循环）
         EXPLORING: Think → Act(MCP) → Observe × N轮
         FINALIZE: Build Threads → 返回结构化结果
         ↓
       结果返回外层，LLM 翻译成自然语言回复
```

详见 [agent-loop-redesign-v3.md](agent-loop-redesign-v3.md)

## 文档索引

| 文件 | 内容 |
|------|------|
| [agent-loop-redesign-v3.md](agent-loop-redesign-v3.md) | v3 双层循环 + 双数据源架构 |
| [neodata-integration.md](neodata-integration.md) | neodata 金融数据搜索集成设计 |
| [system-prompt.md](system-prompt.md) | 内层 System Prompt 六层完整文本（含 FINALIZE 段） |
| [tools.md](tools.md) | 5 个 MCP 工具 + 3 个内存读取工具 |
| [state.md](state.md) | 数据模型设计（State/Finding/EventBuffer/Thread 等） |
| [agent-loop.md](agent-loop.md) | 内层 Agent Loop Phase 状态机与流程 |
| [findings.md](findings.md) | Key Findings 提取规则（触发、去重、confidence） |
| [event-threads.md](event-threads.md) | FINALIZE Prompt + Thread 构建规则 + 验证 |
| [error-handling.md](error-handling.md) | 四类恢复动作 + 预算分池 + FINALIZE 降级 |
| [context-assembly.md](context-assembly.md) | 热层注入策略 + State View + Token 分池 |
| [agent-card.md](agent-card.md) | A2A Agent Card + JSON-RPC 接口契约 |
| [three-tier-architecture.md](three-tier-architecture.md) | 三层热/温/冷架构根因分析 |

## 快速导航

- 想知道整体架构变化 → [agent-loop-redesign-v3.md](agent-loop-redesign-v3.md)
- 想知道两个数据源怎么分工 → [neodata-integration.md](neodata-integration.md)
- 想知道 Agent 怎么思考 → [system-prompt.md](system-prompt.md)
- 想知道有什么工具可用 → [tools.md](tools.md)
- 想知道循环怎么跑 → [agent-loop.md](agent-loop.md)
- 想知道 Finding 怎么提取 → [findings.md](findings.md)
- 想知道 Thread 怎么构建 → [event-threads.md](event-threads.md)
- 想出问题了怎么办 → [error-handling.md](error-handling.md)
- 想知道上下文怎么管理 → [context-assembly.md](context-assembly.md) + [three-tier-architecture.md](three-tier-architecture.md)
