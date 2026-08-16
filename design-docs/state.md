# State — 数据模型设计

> 状态: 已实现（v3 五意图架构） | 已对齐: 33f02f7 (2026-08-16)
>
> 源码: `src/agent/state.ts`。v2 三层架构（温层/冷层/recall 工具）已删除，
> 演进记录见 [archive/graph-agent-v2-changelog-2026-06-02.md](archive/graph-agent-v2-changelog-2026-06-02.md)
> 与 [three-tier-architecture.md](three-tier-architecture.md)（DEPRECATED）。

---

## v3 数据模型总览

```
ExplorationState
├── 探索图:  visited · frontier · paths
├── 三层发现存储（v3 拆分，替代 v2 的单一 key_findings）:
│     entity_flags    基础设施告警 — 代码保障，注入 Prompt
│     cluster_flags   数据质量标记 — 随 cluster 数据绑定
│     key_insights    跨轮合成洞察 — LLM 自由消费（Finding 结构）
├── raw_event_archive   原始事件归档（仅 FINALIZE 注入，替代 v2 event_buffer/archive）
├── exploration_log · budget · 循环控制 · 决策历史 · 工具调用状态
└── 输出阶段: final_findings · event_threads · reliability_note
```

**v3 核心变化**（`state.ts:1-8`）:
- 删除 `event_buffer` / `event_archive`，改为 `raw_event_archive`（仅 FINALIZE 注入）
- 拆解 `key_findings` 为 `entity_flags` / `cluster_flags` / `key_insights` 三层
- FrontierEntity 从优先级排序改为准入控制（去 `priority`，`source_reason` 必填）
- 删除 recall 工具类型、`CompressedResults` / `HistoryStep` 等分段压缩类型

---

## ExplorationState

探索过程的全局状态，贯穿 EXPLORING + FINALIZE 生命周期。

### 探索图状态

| 字段 | 类型 | 说明 |
|------|------|------|
| visited | Map\<string, EntitySummary\> | 已探索实体摘要（key=实体名），按类型/事件数聚合（State View 依赖） |
| frontier | FrontierEntity[] | 待探索实体。**准入控制**：上限 `MAX_FRONTIER_SIZE=10`，新增按 `mention_count` 加权淘汰 |
| paths | Map\<string, EntityPath\> | 已发现关系路径（key="entityA→entityB"），避免重复追溯 |

### 三层发现存储

| 字段 | 结构 | 定位 |
|------|------|------|
| entity_flags | EntityFlag[] | 基础设施告警（如 unreliable_mapping），**代码保障注入 Prompt** |
| cluster_flags | ClusterFlag[] | 数据质量标记（如 data_conflict），**随 cluster 数据绑定** |
| key_insights | Finding[] | 跨轮合成洞察（Finding 结构），**LLM 自由消费** |

### raw_event_archive

RawEvent[] — 每步工具结果中的事件经 LLM 批量分类（EventDataType，见
[data-taxonomy.md](data-taxonomy.md)）后归档。**EXPLORING 阶段不注入 LLM，
仅 FINALIZE 全量注入**（v2 的优先级驱逐/protected 机制已随温层删除）。

### 预算（分池，config 驱动）

总预算 `total = input.max_tokens ?? config.llm.max_tokens ?? 128_000`
（`loop.ts:145`；三个调用方 A2A handler / chat loop / eval runner 均不传
input.max_tokens，实际由 config 决定）。

| 池 | 占比 | 说明 |
|----|------|------|
| exploring_limit | 78% | EXPLORING 阶段 token 总预算 |
| finalize_reserved | 16% | 保证 FINALIZE 有足够 token 构建 Thread |
| headroom | 6% | 缓冲 |

触达 exploring_limit → 强制进入 FINALIZE。预算检查在每步工具调用后执行。

### 循环控制

| 字段 | 说明 |
|------|------|
| phase | EXPLORING / FINALIZE |
| step_count / depth | 步数与深度计数。步数上限 `MAX_EXPLORING_STEPS=20`、`MAX_FINALIZE_STEPS=2`；**depth 仅计数，max_depth 输入当前不构成终止条件**（已知缺口，见 [agent-loop.md](agent-loop.md)） |
| budget.used_tokens | 累计 token 消耗 |
| mcp_degraded | MCP 降级标记 |
| force_strategy | 代码强制策略（预算紧张时覆盖 LLM 决策：expand/deep_dive/verify） |
| force_sufficient | 代码强制终止（预算耗尽时） |
| injectHint | 注入提示 |

### 决策历史

| 字段 | 说明 |
|------|------|
| last_n_decisions | 最近 N 步 effective decision（expand/deep_dive/verify/sufficient/stalemate）。sufficient/stalemate 由独立的 `stop` 字段经 `extractStopSignal` 合成，非 LLM decision 直接产出 |
| last_n_finding_counts | 最近 N 步 finding 增量（检测边际递减） |

### 工具调用状态

| 字段 | 说明 |
|------|------|
| known_clusters | 已知 cluster_id 集合（避免重复 expand） |
| nameIndex | 别名→规范名映射 |
| last_tool_results_raw | 当前步原始结果（代码侧用；v2 的 `last_tool_results_compressed` 已删除，注入视图由 context.ts 现算） |
| tool_call_failures | 连续失败次数 |
| token_warnings | 预算警告次数 |

### 时间上下文（运行时注入）

`temporal_context: TemporalContext` — 启动时计算：`current_time`、
`is_trading_day`、`market_session`（pre_market/open/closed/holiday，按上交所
时段+上海节假日表）、`weekday`。解决"今天"数据的时效性对齐。

### 输出阶段

| 字段 | 说明 |
|------|------|
| final_findings | FINALIZE 输出的去重 findings |
| event_threads | FINALIZE 输出的事件脉络 |
| reliability_note | 可靠性说明（降级时标注原因） |

---

## ExplorationInput / ExplorationOutput

输入: `goal`、`seed_entities`、可选 `session_id`/`time_range`/`max_depth`/
`max_steps`/`max_tokens`/`relation_filters`。

输出 `exploration_meta.completion_reason` — **7 值枚举**（`state.ts:38`）:

`sufficient` | `depth_exhausted` | `token_budget` | `frontier_empty` |
`diminishing_returns` | `cancelled` | `mcp_unavailable`

> 注: `depth_exhausted` 在步数上限触发（step_count ≥ 20），命名为历史遗留，
> 与图深度无关；`max_depth` 输入当前不构成终止条件（已知缺口，见 agent-loop.md）。

stats 含 `events_buffered`（历史命名，实指 raw_event_archive 计数）。

---

## 三层发现的接口

### EntityFlag

| 字段 | 说明 |
|------|------|
| entity_name / flag_type / description / source_step | 告警实体、类型（unreliable_mapping）、描述、产生步骤 |

### ClusterFlag

| 字段 | 说明 |
|------|------|
| cluster_id / flag_type / description / source_step | 数据冲突所在 cluster、类型（data_conflict）、描述、步骤 |

### Finding（key_insights 与 final_findings 的结构）

| 字段 | 说明 |
|------|------|
| id | 唯一标识 |
| category | pattern_violation / concentration / chain / absence |
| statement | 一句话自然语言描述 |
| confidence | high / medium / low |
| evidence | 证据 KU ID 列表（代码从 tool result 提取，非 LLM 填写）。**无证据的 finding 直接丢弃**——与"无证据=无效发现"约束一致 |
| entities_involved / relation_to_goal / discovered_at_step / conflict_with | 涉及实体、对 Goal 的贡献、发现步骤、矛盾标注 |

---

## EventThread, ThreadEvent, ThreadRelation

### EventThread

| 字段 | 说明 |
|------|------|
| id / title / summary / narrative | 标识和描述 |
| thread_events | 事件列表（每个引用 ku_id，可溯源） |
| relationships | 事件间关系边 |
| time_span | **`{ earliest, latest }`**（非 v2 的 start/end） |
| confidence | 整条 Thread 的信心评级 |
| source_finding_ids | 来源 finding 列表 |

### ThreadRelation

| 字段 | 说明 |
|------|------|
| from_idx / to_idx | 关系两端事件索引 |
| type | causal / temporal / entity_shared / contradiction |
| reasoning | 为什么认为是这个关系 |

---

## FrontierEntity — 准入控制（v3）

| 字段 | 说明 |
|------|------|
| name / type | 实体名称与类型 |
| source / source_reason | 来源实体与**必填**引入理由 |
| mention_count | 被提及次数（准入排序依据） |
| ~~priority~~ | **已删除**（v2 按 1-3 排序的模型废弃） |

frontier 上限 `MAX_FRONTIER_SIZE=10`：候选超限时按 mention_count 与来源加权
淘汰（详见 [agent-loop.md](agent-loop.md)）。

---

## 其他结构

- **EntitySummary**（visited 值）: name/type/aliases、related_events_count、
  event_types、clusters_count、discovered_at_step、key_relations
- **RawEvent**: ku_id/entity/event_type/timestamp/description/cluster_id/
  source_step/**event_data_type**（分类规则见 data-taxonomy.md）
- **ToolResult**: tool_name/args/success/error/data/knowledge_units/clusters/
  entities/total_count
- **MCP 工具名**: `lookup | trace | timeline | expand | scan`（仅 5 个，v2 的
  recall_* 已删除）
- **EntityPath**: from/to/hops/intermediate_entities/intermediate_events/
  discovered_at_step
- **LogEntry**: step/phase/decision/tool_calls_count/new_findings_count +
  可选 exception（mcp_timeout/mcp_empty/mcp_error/llm_format/llm_hallucination/
  llm_loop × recovery: retry/fallback/skip/abort）+ strategy_switch
- **StepEvent**: loop 向前端推送的事件（step_complete/finding/analyzing_events/
  extracting_findings/building_threads/validating/finalize/error），供 SSE 流式
- **序列化**: `serializeState`/`deserializeState` — Map/Set → JSON-safe 平面
  结构（用于会话持久化）

---

## 变化总结（v2→v3）

| 项 | v2 | v3 | 原因 |
|----|----|----|------|
| 事件存储 | event_buffer(100,优先级驱逐) + event_archive | raw_event_archive（无驱逐，仅 FINALIZE 注入） | 温层维护成本高、收益低 |
| 发现存储 | key_findings + low_confidence_findings | entity_flags / cluster_flags / key_insights 三分流 | 不同消费者需要不同保障级别 |
| frontier | priority 1-3 排序 | 准入控制 + mention_count（上限 10） | 优先级计算不可靠，提及频次更稳 |
| 无证据 finding | 暂存 low_confidence_findings | 直接丢弃 | "无证据=无效发现"约束的严格执行 |
| 预算 | 固定 128k 分池 | config 驱动（llm.max_tokens）分池，比例不变 | 预算应随部署配置伸缩 |
| 工具返回压缩 | CompressedResults 持久态 | context.ts 现算注入视图 | 消除状态/视图双份维护 |
