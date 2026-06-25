# State — 数据模型设计

> 三层架构详见: [three-tier-architecture.md](three-tier-architecture.md)

---

## ExplorationState

探索过程的全局状态，贯穿整个 EXPLORING + FINALIZE 生命周期。

### 探索图状态

| 字段 | 说明 | 设计理由 |
|------|------|---------|
| visited | 已探索实体的摘要（key=实体名） | 不是简单的名称集合，需要按类型/事件数聚合（State View 依赖） |
| frontier | 待探索实体（按 priority 排序） | priority 驱动探索策略选择 |
| paths | 已发现的关系路径（key="entityA→entityB"） | 避免重复追溯同一条路径 |

### 三层存储

| 字段 | 层级 | 说明 |
|------|------|------|
| event_buffer | 温层 | 容量 100，带优先级驱逐。被 finding 引用的事件标记 protected，永不驱逐 |
| event_archive | 冷层 | 被驱逐的事件按实体索引。recall_buffer 可回查（标注 archived） |
| key_findings | 热层 | 探索中逐步积累的关键发现 |
| low_confidence_findings | 温层 | 无 evidence 的低优先级 finding，不进入热层 |

### 预算（分池）

| 池 | 占比 | 说明 |
|----|------|------|
| EXPLORING 上限 | 78% (100k/128k) | EXPLORING 阶段的 token 总预算 |
| FINALIZE 预留 | 16% (20k/128k) | 保证 FINALIZE 有足够 token 构建 Thread |
| 机动 | 6% (8k/128k) | 缓冲 |

EXPLORING 触达 100k → 强制进入 FINALIZE。预算检查在每步工具调用后执行。

### 循环控制

| 字段 | 说明 |
|------|------|
| phase | EXPLORING / FINALIZE |
| step_count / depth | 步数和深度计数 |
| budget.used_tokens | 累计 token 消耗 |
| mcp_degraded | MCP 降级标记 |
| force_strategy | 代码强制策略（预算紧张时覆盖 LLM 决策） |
| force_sufficient | 代码强制终止（预算耗尽时） |

### 决策历史

| 字段 | 说明 |
|------|------|
| last_n_decisions | 最近 N 步的 effective decision（expand/deep_dive/verify/sufficient/stalemate）。其中 sufficient/stalemate 由独立的 `stop` 字段经 `extractStopSignal` 合成，非 LLM 的 decision 字段直接产出 |
| last_n_finding_counts | 最近 N 步的 finding 增量（检测边际递减） |

### 工具调用状态

| 字段 | 说明 |
|------|------|
| known_clusters | 已知的 cluster_id 集合（避免重复 expand） |
| last_tool_results_compressed | 当前步的压缩视图（注入 LLM 的版本） |
| last_tool_results_raw | 当前步原始结果（代码侧用，不入 LLM） |
| tool_call_failures | 连续失败次数 |
| token_warnings | 预算警告次数 |

### 输出阶段

| 字段 | 说明 |
|------|------|
| final_findings | FINALIZE 输出的去重 findings |
| event_threads | FINALIZE 输出的事件脉络 |
| reliability_note | 可靠性说明（降级时标注原因） |

---

## EntitySummary — visited 中每个实体的摘要

| 字段 | 说明 |
|------|------|
| name / type | 实体名称和类型（company/person/organization/product/unknown） |
| related_events_count | 相关事件数 |
| event_types | 已见事件类型（去重） |
| clusters_count | 涉及的聚类数 |
| discovered_at_step | 首次发现的步骤 |
| key_relations | 关键关系（格式："→供应商: SupplierA"） |

---

## EventBufferEntry — 温层条目

| 字段 | 说明 |
|------|------|
| ku_id / entity / event_type / timestamp / description | 事件基本信息 |
| cluster_id | 所属聚类 |
| source_step | 产生此事件的步骤 |
| protected | 被 finding 引用则 true，永不驱逐 |
| priority | 1-3（3=最高），根据 frontier 关联度和时效性计算 |
| linked_finding_ids | 关联的 finding 列表（空 = 背景事件） |

### 驱逐优先级规则

优先级根据三个因素计算：
1. **是否被 finding 引用** → protected=true，永不驱逐
2. **是否在 frontier 中** → 近期 + near-frontier = 3，非近期但 frontier = 2
3. **时效性** → 近 3 步的事件优先级更高

每次驱逐 priority 最低的 5 条，进入 archive。

---

## FrontierEntity

| 字段 | 说明 |
|------|------|
| name | 实体名称 |
| priority | 1=低 / 2=中 / 3=高 |
| source | 来源实体名称（谁引出的） |
| source_reason | 为什么引入 |
| type | 实体类型 |

---

## Finding

| 字段 | 说明 |
|------|------|
| id | 唯一标识 |
| category | pattern_violation / concentration / chain / absence |
| statement | 一句话自然语言描述 |
| confidence | high / medium / low |
| evidence | 证据 KU ID 列表（代码从 tool result 提取，非 LLM 填写） |
| entities_involved | 涉及的实体列表 |
| relation_to_goal | 对 Goal 的贡献说明 |
| discovered_at_step | 发现步骤（代码填写） |
| conflict_with | 与另一个 finding 矛盾时标注 |

---

## EventThread, ThreadEvent, ThreadRelation

### EventThread

| 字段 | 说明 |
|------|------|
| id / title / summary / narrative | 标识和描述 |
| thread_events | 事件列表（每个引用 ku_id，可溯源） |
| relationships | 事件间关系边 |
| time_span | 时间跨度 |
| confidence | 整条 Thread 的信心评级 |
| source_finding_ids | 来源的 finding 列表 |

### ThreadRelation

| 字段 | 说明 |
|------|------|
| from_idx / to_idx | 关系两端的事件索引 |
| type | causal / temporal / entity_shared / contradiction |
| reasoning | 为什么认为是这个关系 |

---

## ToolResult — 工具返回格式

工具返回分两部分：
- **原始数据**（代码侧用，不入 LLM 上下文）：完整的 KU、Cluster、Entity 数据
- **压缩视图**（注入 LLM）：摘要行 + 前 N 条标题行 + "更多用 recall 工具读取"

压缩策略根据预算使用率动态调整：
- 预算宽裕（<50%）：前 5 条标题
- 预算正常（50-70%）：前 3 条标题
- 预算紧张（>70%）：仅摘要行
- 硬上限：单步注入不超过 4k token

---

## 变化总结（v1→v2）

| 字段 | 旧 | 新 | 原因 |
|------|-----|-----|------|
| visited | Set\<string\> | Map\<string, EntitySummary\> | 需要按类型/事件数聚合 |
| event_buffer | EventRecord[] | EventBufferEntry[]（带 priority/protected） | 分层驱逐 |
| event_archive | 无 | Map\<string, EventBufferEntry[]\> | 冷层归档 |
| budget | 单一 max_tokens | 分池: exploring_limit + finalize_reserved + headroom | FINALIZE 保证预算 |
| last_tool_results_compressed | 无 | CompressedResults | 工具返回压缩视图 |
