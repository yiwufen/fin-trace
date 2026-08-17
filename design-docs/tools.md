# Tools — 5 个 KG 工具

> 状态: 已实现（v3 五意图架构 + v3.1 KG 服务契约对齐 + v3.2 event_types 定向过滤） | 已对齐: 3392100 (2026-08-16)
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

## time_range 契约（v3.1）

KG 服务端要求 `time_range` 为**双端 ISO 日期** `'YYYY-MM-DD:YYYY-MM-DD'`，
不支持开放区间。映射层 `validateToolArgs` 在发请求前校验（非法直接返回
失败 ToolResult，不发网络请求），错误信息注入 LLM 上下文供下一轮自纠。

---

## 服务端错误载荷（v3.1）

KG 服务把参数校验类错误作为 `{"error": "..."}` 放在**正常 content**返回
（`isError=false`）。`mcp-client.ts` 的 `extractErrorPayload` 识别该形态并转为
`McpDeterministicError`——**不重试、不计入 consecutiveErrors**（确定性错误重试
必然失败；两次传参失误不应触发 degraded 废掉会话级 MCP 通道）。瞬态错误
（超时/5xx/网络）仍走 L1/L2/L3 重试与降级链（见 [error-handling.md](error-handling.md)）。

---

## event_types 定向过滤（v3.2）

服务端支持在**任意 intent** 上叠加 `event_types` 过滤（32 类闭集同 scan）。
映射层对 lookup / trace / timeline 透传该参数，LLM 按以下指引使用:

- **首轮摸底 / 陌生实体不过滤**——先看全貌，避免过早收窄
- **定向子目标带过滤**——制裁暴露、债务风险、监管动态等场景
  传 `['sanction','regulatory_action']` 一类窄集

实测动机（宁德时代 hops=1）: 无过滤 ~112k tok 响应 / 137 聚类 / 延迟 21-55s
（间歇性击穿 MCP 30s 超时）；加风险类过滤后 ~4.7k tok / 1 聚类 / 7-23s。
过滤同时命中 token、延迟、针对性三个瓶颈，也是热点实体超时的主要缓解手段。

---

## 逐工具参数（LLM 可见 schema）

### 1. lookup — 查实体信息和事件

**何时用**: 第一次接触一个实体、需要了解"这是谁"、"近期有什么事"；多实体对比
**返回**: entities(实体画像) + knowledge_units(事件摘要) + event_clusters(事件聚类) + graph_data.clusters_overview

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| entities | string[] | ✓ | | 实体中文名列表，如 `['宁德时代', '比亚迪']` |
| intent | enum | | ENTITY_OVERVIEW | ENTITY_OVERVIEW=综合概览 / ENTITY_TIMELINE=时间线 |
| event_types | string[] | | | 定向子目标过滤（见"event_types 定向过滤"） |
| time_range | string | | | 如 `'2024-01-01:2024-12-31'`（双端必填） |
| top_k | int | | 20 | 1-100 |

**MCP 映射**: `search_knowledge(entities, intent, hops=1, event_types, time_range, top_k)`

### 2. trace — 追踪两实体间关系路径

**何时用**: 想知道"A 和 B 怎么关联的"、"中间经过哪些实体和事件"
**限制**: 一次只追一对实体，多对多次调用
**返回**: 关系路径（中间实体 + 关联事件）+ graph_data.clusters_overview

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| entity_a / entity_b | string | ✓ | 一对实体的中文名 |
| hops | int | | 固定 2（见二部图换算；映射层收口，LLM 不可调） |
| event_types | string[] | | 只追某类事件关联时过滤 |
| time_range | string | | 可选（双端必填） |

**MCP 映射**: `search_knowledge(entities=[entity_a], target_entity=entity_b, intent=RELATIONSHIP_QUERY, hops=2, event_types, time_range)`

### 3. timeline — 拉取实体事件时间线

**何时用**: 发现一个实体有多个事件，需要按时间排列、找发展脉络
**返回**: 按时间排列的事件列表 + 聚类概览。排完时序后由 LLM 判断事件发展链 → key_insight；发展链触发源为外部实体 → frontier

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| entity | string | ✓ | | 单实体中文名 |
| event_types | string[] | | | 只看某类事件脉络时过滤 |
| time_range | string | | | 如 `'2024-01-01:2024-12-31'`（双端必填） |
| top_k | int | | 20 | |

**MCP 映射**: `search_knowledge(entities=[entity], intent=ENTITY_TIMELINE, event_types, time_range, top_k)`（不传 hops）

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
| event_types | string[] | | 事件类型过滤（32 类闭集，见下方） |
| time_range | string | | 可选，双端 ISO 必填 |

**event_types 32 类闭集**（canonical 英文值或中文别名均可，服务端归一化；
未知类型服务端报错并列出合法值）:

| 分组 | canonical 值 |
|------|--------------|
| 公司资本类 | restructuring(重组/并购)、ipo(上市/增发)、shareholding_change(增减持/大宗交易)、equity_pledge(股权质押)、dividend(分红/派息)、company_establishment(企业设立)、investment(投资/融资) |
| 公司经营类 | financial_performance(财报/业绩)、product_launch(产品发布)、business_strategy(企业战略)、executive_change(高管变动/实控人变动) |
| 公司风险类 | debt_default(债务违约)、legal_proceeding(诉讼)、risk_warning(风险提示) |
| 市场分析类 | stock_price_change(股价)、price_change(商品价格)、sector_performance(板块表现)、market_analysis(市场分析)、industry_analysis(行业分析)、rating_change(评级调整/目标价) |
| 监管类 | regulatory_action(监管处罚)、sanction(制裁)、policy_announcement(政策发布) |
| 宏观类 | economic_data(经济数据)、trade_data(贸易数据) |
| 影响因素类 | diplomatic_event(外交)、military_action(军事)、political_statement(政治声明) |
| 关系/披露类 | strategic_cooperation(战略合作/签约)、disclosure(澄清/回应/停牌)、meeting(会议)、non_financial(明确非金融内容) |

枚举源码: `src/agent/tools.ts` 的 `EVENT_TYPES`（与服务端契约一致，单测锁定数量）。

**MCP 映射**: `search_knowledge(entities, intent=EVENT_ANALYSIS, event_types, time_range)`（不传 hops/top_k，KG 服务端默认值兜底）

---

## 工具选择优先级（Agent Loop 侧）

工具间无互斥，但 Agent Loop 在预算紧张时按以下优先级建议：
**expand > trace > lookup = timeline > scan**（详见 [agent-loop.md](agent-loop.md)）。
