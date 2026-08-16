# Graph Explorer Agent — 主文档

## 是什么

Graph Explorer Agent 是金融知识图谱上的多跳关系推理专用 Agent。

## 架构约束

- **运行时**: 独立 TypeScript 进程，不跑在任何 Agent 框架里
- **数据层**: knowledge-graph MCP（neodata 双数据源为**未实现**的设计提案，见 [neodata-integration.md](neodata-integration.md)）
- **对外接口**: A2A Agent（`graph_explore` skill，Agent Card 在 `/.well-known/agent-card.json`）+ MCP 服务（`/mcp`，`graph_explore_start/status/cancel`）+ Web/HTTP API（`/api/*`，详见根 README）
- **核心原则**: Agent Loop 全在自己代码里，"库优于框架"

## v3 架构（双层循环）

```
外层 Loop（对话循环，面向用户）       ← src/chat/
  用户消息 → LLM 判断意图
    ├─ 多跳关系推理 → graph_explore (KG)
    ├─ 直接回复（澄清/闲聊/追问回答）
    └─ 追问用户（参数不足）
         ↓
       内层 Loop（探索循环）          ← src/agent/
         EXPLORING: Think → Act(MCP) → Observe × N轮
         FINALIZE: Build Threads → 返回结构化结果
         ↓
       结果返回外层，LLM 翻译成自然语言回复
```

详见 [agent-loop-redesign-v3.md](agent-loop-redesign-v3.md)

> 注：v3 已按"五意图重构"落地（删除温层与 recall 工具，findings 分流为
> entity_flags / cluster_flags / key_insights，见
> [archive/graph-agent-v2-changelog-2026-06-02.md](archive/graph-agent-v2-changelog-2026-06-02.md)）。

## ⚠️ 文档漂移警告

`state.md`、`tools.md`、`context-assembly.md`、`error-handling.md`、`findings.md`、
`system-prompt.md`、`event-threads.md`、`agent-loop.md`、`agent-card.md` 中仍有
v2 遗留内容（温层/event_buffer/recall 工具/低置信暂存等），**与现行代码有漂移，重写待办**。
冲突时以 `src/` 实现为准。

## 文档索引

| 文件 | 内容 |
|------|------|
| [agent-loop-redesign-v3.md](agent-loop-redesign-v3.md) | v3 双层循环架构（部分实现，见文首状态注） |
| [neodata-integration.md](neodata-integration.md) | neodata 金融数据集成设计（**未实现**，设计阶段） |
| [system-prompt.md](system-prompt.md) | 内层 System Prompt 六层完整文本（含 FINALIZE 段） |
| [tools.md](tools.md) | 5 个 KG 工具 schema（⚠️ 文中"3 个内存读取工具"章节已废弃） |
| [state.md](state.md) | 数据模型（State/Finding/EventThread 等；⚠️ v2 漂移） |
| [agent-loop.md](agent-loop.md) | 内层 Agent Loop Phase 状态机与流程 |
| [findings.md](findings.md) | Key Findings 提取规则（触发、去重、confidence） |
| [event-threads.md](event-threads.md) | FINALIZE Prompt + Thread 构建规则 + 验证 |
| [error-handling.md](error-handling.md) | 恢复动作 + 预算分池 + FINALIZE 降级（⚠️ v2 漂移） |
| [context-assembly.md](context-assembly.md) | State View + Token 分池（⚠️ 温层/recall 章节已废弃） |
| [agent-card.md](agent-card.md) | A2A Agent Card + JSON-RPC 接口契约 |
| [data-taxonomy.md](data-taxonomy.md) | 事件数据分类（EventDataType 权重 / LLM 批量分类 / 流式过滤）— 已实现 |
| [three-tier-architecture.md](three-tier-architecture.md) | 三层热/温/冷架构根因分析（**DEPRECATED**，仅作演进记录） |

### 归档（archive/，历史记录，非现行规范）

| 文件 | 内容 |
|------|------|
| [archive/a2a-analysis.md](archive/a2a-analysis.md) | 早期 A2A 选型分析 |
| [archive/graph-agent-design-2026-06-01.md](archive/graph-agent-design-2026-06-01.md) | v1 设计 |
| [archive/graph-agent-v2-changelog-2026-06-02.md](archive/graph-agent-v2-changelog-2026-06-02.md) | v2 修正记录（删除温层/recall 工具的出处） |
| [archive/frontend-design.md](archive/frontend-design.md) | v2 纯探索 UI 设计（已被 v3 聊天式取代） |
| [archive/evaluation.md](archive/evaluation.md) | 早期评测设计（已被 `docs/superpowers/specs/` 取代） |

## 快速导航

- 想知道整体架构 → [agent-loop-redesign-v3.md](agent-loop-redesign-v3.md)
- 想知道 Agent 怎么思考 → [system-prompt.md](system-prompt.md)
- 想知道有什么工具可用 → [tools.md](tools.md)
- 想知道循环怎么跑 → [agent-loop.md](agent-loop.md)
- 想知道事件怎么分类 → [data-taxonomy.md](data-taxonomy.md)
- 想知道 Finding 怎么提取 → [findings.md](findings.md)
- 想知道 Thread 怎么构建 → [event-threads.md](event-threads.md)
- 想出问题了怎么办 → [error-handling.md](error-handling.md)
- 想知道上下文怎么管理 → [context-assembly.md](context-assembly.md)（three-tier 已废弃，现行看 `src/agent/context.ts`）
