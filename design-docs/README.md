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

## 术语基线（v2 → v3，所有文档统一）

| v2 术语（废除） | v3 现实 |
|---|---|
| event_buffer / event_archive | `raw_event_archive`（仅 FINALIZE 注入） |
| key_findings 单一列表 | `entity_flags` / `cluster_flags` / `key_insights` 三分流 |
| frontier priority 1-3 | 准入控制 + `mention_count`（上限 10） |
| low_confidence_findings 暂存 | 无此容器（无证据 finding 直接丢弃） |
| 固定 128k 预算 | config 驱动（`llm.max_tokens`，兜底 128k），78/16/6 分池不变 |
| 80/90/100 预算阶梯 | 85% 压缩 / 90% 警告 / 95% 再压缩 / 100% 强制收敛 |

九份核心 spec 已于 2026-08 对齐 v3 代码，每份带状态头（已对齐 SHA）；
改 agent 核心行为的 PR 须同 PR 更新对应文档并刷新 SHA（AGENTS.md 约束）。

## 文档索引

| 文件 | 内容 |
|------|------|
| [agent-loop-redesign-v3.md](agent-loop-redesign-v3.md) | v3 双层循环架构（部分实现，见文首状态注） |
| [neodata-integration.md](neodata-integration.md) | neodata 金融数据集成设计（**未实现**，设计阶段） |
| [system-prompt.md](system-prompt.md) | System Prompt 六层结构 + 设计意图 + prompt.ts 源码锚点 |
| [tools.md](tools.md) | 5 个 KG 工具 schema + MCP 映射 + 二部图 hops 换算 |
| [state.md](state.md) | 数据模型（State/三分流 Finding/EventThread 等） |
| [agent-loop.md](agent-loop.md) | 内层 Agent Loop Phase 状态机与 P0-P5 终止链 |
| [findings.md](findings.md) | Finding 提取规则（触发、flag_target 路由、去重、加权 confidence） |
| [event-threads.md](event-threads.md) | FINALIZE Prompt + Thread 构建规则 + 验证 |
| [error-handling.md](error-handling.md) | 四类恢复动作 + 预算阶梯 + FINALIZE 降级 |
| [context-assembly.md](context-assembly.md) | State View 注入 + 四级压缩阶梯 + Token 分池 |
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
- 想知道上下文怎么管理 → [context-assembly.md](context-assembly.md)（three-tier 已废弃，仅作演进记录）
