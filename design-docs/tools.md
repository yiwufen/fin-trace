# 工具系统 — 5 个 MCP 工具 + 3 个内存读取工具

---

## 概述

5 个 MCP 工具映射到 knowledge-graph MCP。Agent 内部 hops=1，深度控制由 Agent Loop 做。

---

## MCP 工具

### 1. lookup — 查实体信息和事件

**语义**: 查一个或多个实体的基本信息和相关事件
**何时用**: 第一次接触一个实体、需要了解"这是谁"、"近期有什么事"
**返回**: entities(实体画像) + knowledge_units(事件摘要) + event_clusters(事件聚类) + graph_data.clusters_overview

| 参数 | 类型 | 说明 |
|------|------|------|
| entities | string[] (必填) | 实体中文名列表，如 ['宁德时代', '比亚迪'] |
| intent | string (可选) | ENTITY_OVERVIEW(默认)=综合概览, ENTITY_TIMELINE=时间线 |
| time_range | string (可选) | 格式 '2024-01-01:2024-12-31' |
| top_k | integer (可选) | 1-100，默认 20 |

**MCP 映射**: search_knowledge(entities, intent, hops=1, time_range, top_k)
**注意**: hops 固定 1。不要设更高——深度由后续步骤控制。想深入了解某个 cluster → 记下 cluster_id → 下一步用 expand。

---

### 2. trace — 追踪两实体间关系路径

**语义**: 追踪两个实体间的关系路径
**何时用**: 想知道"A 和 B 怎么关联的"、"中间经过哪些实体和事件"
**限制**: 一次只追一对实体。需要追多对就多次调用。

| 参数 | 类型 | 说明 |
|------|------|------|
| entity_a | string (必填) | 实体中文名 |
| entity_b | string (必填) | 实体中文名 |
| hops | integer (可选) | 默认 2 |

**MCP 映射**: search_knowledge(entities=[entity_a], target_entity=entity_b, intent=RELATIONSHIP_QUERY, hops)

---

### 3. timeline — 拉取实体事件时间线

**语义**: 拉取一个实体的事件时间线
**何时用**: 发现一个实体有多个事件，需要按时间排列、找发展脉络

| 参数 | 类型 | 说明 |
|------|------|------|
| entity | string (必填) | 实体中文名 |
| time_range | string (可选) | 格式 '2024-01-01:2024-12-31' |

**MCP 映射**: search_knowledge(entities=[entity], intent=ENTITY_TIMELINE, hops=1)

---

### 4. expand — 展开事件聚类详情

**语义**: 展开事件聚类的完整详情（节点、边、路径）
**何时用**: lookup/trace 返回的聚类摘要看起来重要，需要看里面具体有哪些事件

| 参数 | 类型 | 说明 |
|------|------|------|
| cluster_ids | string[] (必填) | 从 search_knowledge 返回的 graph_data.clusters_overview 中取 |

**MCP 映射**: expand_graph_detail(cluster_ids)
**返回**: 聚类中的完整节点、边、路径信息

---

### 5. scan — 批量扫描实体验证假设

**语义**: 批量查多个实体的某一类事件，用于验证模式
**何时用**: 需要快速验证"这些实体是否都有某类事件"

| 参数 | 类型 | 说明 |
|------|------|------|
| entities | string[] (必填) | 实体列表（建议 ≤ 5 个） |
| event_types | string[] (可选) | 筛选事件类型 |
| time_range | string (可选) | 时间范围 |

**MCP 映射**: search_knowledge(entities, event_types, hops=1, top_k=10)
**注意**: 批量调用，每个实体的返回独立处理。token 成本按实体数量线性增长。

---

## 内存读取工具（不调 MCP）

3 个纯代码侧读取工具，0 网络延迟。从 ExplorationState 的温层读取数据。

### recall_entity(name)

返回该实体在 visited + buffer 中的所有已知信息。
Token cost: ~500-2000

### recall_buffer(event_type?, entity?)

返回 event_buffer 中匹配条件的事件摘要。
Token cost: ~300-1000

### recall_finding(finding_id)

展开一条 finding 的完整证据链（关联的 KU 全文）。
Token cost: ~1000-5000
