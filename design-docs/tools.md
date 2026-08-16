# Tools — 5 个 KG 工具

> 状态: 已实现（v3 五意图架构） | 已对齐: 33f02f7 (2026-08-16)
>
> 源码: `src/agent/tools.ts`。v3 删除了 v2 的 3 个 recall 内存读取工具
> （recall_entity/recall_buffer/recall_finding）——温层已随五意图重构移除，
> 事件统一归档进 `raw_event_archive`（见 [state.md](state.md)）。

---

## 设计原则

- **仅 5 个工具**: lookup / trace / timeline / expand / scan，固定不可增删
- **单语义跳**: 每次调用只获取一层邻接信息；多跳由 Agent Loop 组合调用涌现
- **映射层收口**: LLM 只见 5 个工具；底层仅 **2 个 MCP 方法**
  （`search_knowledge` + `expand_graph_detail`），由 `mapToMcpCall` 换算

---

## 五工具一览

| 工具 | 用途 | 底层 MCP | intent |
|------|------|----------|--------|
| lookup | 实体概览/对比/时间线 | search_knowledge | ENTITY_OVERVIEW / ENTITY_TIMELINE |
| trace | 两实体间关系路径（一次一对） | search_knowledge | RELATIONSHIP_QUERY |
| timeline | 单实体事件时间线 | search_knowledge | ENTITY_TIMELINE |
| expand | 展开事件聚类全详情 | expand_graph_detail | — |
| scan | 批量筛选实体是否有特定类型事件 | search_knowledge | EVENT_ANALYSIS |

---

## 二部图 hops 换算

KG 是**实体-事件二部图**：实体不直连实体，一切关系经事件中介——

```
实体 A ──1 边──→ 事件 ──1 边──→ 实体 B      （1 语义跳 = 2 条原始边）
```

- **"单语义跳"原则**指语义层：一次调用取一层邻接（实体的直接事件，或穿过
  事件到相邻实体），不是指原始边数
- **lookup 传 `hops: 1`**: ENTITY_OVERVIEW 只需实体→自身事件（1 边）
- **trace 传 `hops: 2`**: RELATIONSHIP_QUERY 要实体→事件→对端实体（2 边）。
  LLM 可见的 hops 参数固定为 2（schema default/min/max 均 2），映射层
  不接受 LLM 修改——深度控制是 Agent Loop 的职责
- **timeline / scan 不传 hops**: 时序与事件筛选不涉及图扩展

---

## 逐工具参数（LLM 可见 schema）

### 1. lookup — 查实体信息和事件

**何时用**: 第一次接触一个实体、需要了解"这是谁"、"近期有什么事"；多实体对比
**返回**: entities(实体画像) + knowledge_units(事件摘要) + event_clusters(事件聚类) + graph_data.clusters_overview

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| entities | string[] | ✓ | | 实体中文名列表，如 `['宁德时代', '比亚迪']` |
| intent | enum | | ENTITY_OVERVIEW | ENTITY_OVERVIEW=综合概览 / ENTITY_TIMELINE=时间线 |
| time_range | string | | | 如 `'2024-01-01:2024-12-31'` |
| top_k | int | | 20 | 1-100 |

**MCP 映射**: `search_knowledge(entities, intent, hops=1, time_range, top_k)`

### 2. trace — 追踪两实体间关系路径

**何时用**: 想知道"A 和 B 怎么关联的"、"中间经过哪些实体和事件"
**限制**: 一次只追一对实体，多对多次调用
**返回**: 关系路径（中间实体 + 关联事件）+ graph_data.clusters_overview

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| entity_a / entity_b | string | ✓ | 一对实体的中文名 |
| hops | int | | 固定 2（见二部图换算；映射层收口，LLM 不可调） |
| time_range | string | | 可选 |

**MCP 映射**: `search_knowledge(entities=[entity_a], target_entity=entity_b, intent=RELATIONSHIP_QUERY, hops=2, time_range)`

### 3. timeline — 拉取实体事件时间线

**何时用**: 发现一个实体有多个事件，需要按时间排列、找发展脉络
**返回**: 按时间排列的事件列表 + 聚类概览。排完时序后由 LLM 判断事件发展链 → key_insight；发展链触发源为外部实体 → frontier

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| entity | string | ✓ | | 单实体中文名 |
| time_range | string | | | 如 `'2024-01-01:2024-12-31'` |
| top_k | int | | 20 | |

**MCP 映射**: `search_knowledge(entities=[entity], intent=ENTITY_TIMELINE, time_range, top_k)`（不传 hops）

### 4. expand — 展开事件聚类详情

**何时用**: lookup/trace 返回的聚类摘要看起来重要，需要看里面具体有哪些事件
**返回**: 聚类中的完整节点（实体 + KU）、边（关系）、路径。新实体 → frontier

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| cluster_ids | string[] | ✓ | 来自之前工具返回的 clusters_overview，建议一次 ≤5 个 |

**MCP 映射**: `expand_graph_detail(cluster_ids)`

### 5. scan — 批量扫描实体验证假设

**何时用**: 快速验证"这些实体是否都有某类事件"（如"这些供应商有多少被制裁过"）→ 比例确认 → concentration 类 finding
**注意**: 批量调用，token 成本随实体数量线性增长

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| entities | string[] | ✓ | 要检查的实体中文名列表 |
| event_types | string[] | | 事件类型过滤（见下方枚举） |
| time_range | string | | 可选 |

可用事件类型: 政策制裁/出口管制、股市波动/市场异动、企业并购/重组、
供应链中断/调整、财报发布/业绩预告、监管处罚/合规调查、关税调整/贸易协定、
高管变动/人事调整、IPO/融资事件、地缘政治影响。

**MCP 映射**: `search_knowledge(entities, intent=EVENT_ANALYSIS, event_types, time_range)`（不传 hops/top_k，KG 服务端默认值兜底）

---

## 工具选择优先级（Agent Loop 侧）

工具间无互斥，但 Agent Loop 在预算紧张时按以下优先级建议：
**expand > trace > lookup = timeline > scan**（详见 [agent-loop.md](agent-loop.md)）。
