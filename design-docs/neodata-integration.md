# Graph Explorer — neodata Financial Search 集成设计

> 日期: 2026-06-04
> 状态: 设计阶段
> 依赖: neodata-financial-search skill (sky-lv/neodata-financial-search)

---

## 集成动机

### 问题

v2 Graph Explorer 只有一个数据源——knowledge-graph MCP。KG 是事件级关系数据（制裁、并购、供应链），不适合回答实时行情问题（"今天A股发生了什么"、"科创50 ETF 现价"）。

Agent 拿到"今天A股"的查询时，用 KG 的数据（盘中快照 + 不同时间点的碎片事件）硬答，导致数据不一致和错误结论。

### 解法

引入 neodata 作为第二个数据源，在外层对话循环（v3）中作为独立工具暴露。LLM 根据用户意图自主判断用哪个数据源。

---

## 数据源对比

| 维度 | knowledge-graph MCP | neodata |
|------|--------------------|---------|
| 数据性质 | 事件级关系数据（制裁、并购、供应链中断、高管变动） | 实时报价、财报、资金流向、研报、板块指标 |
| 时效能 | 天到月级更新 | 实时（行情）到季（财报） |
| 典型查询 | "追踪美国制裁对宁德时代欧洲供应链的影响" | "今天科技板块涨了多少" |
| 查询延迟 | lookup: ~2s, exploration: 30-120s | 1-3s |
| 返回结构 | entities + knowledge_units + clusters + graph_data | apiData（结构化）+ docData（资讯/研报） |
| 分析深度 | 多跳关系推理 | 单次查询，无关系推理 |

**两个数据源互补。** KG 做"深度"（多跳关系链），neodata 做"广度"（全面的实时金融数据）。

---

## 集成架构

```
v3 外层 LLM 可用工具：
  ├─ graph_explore(goal, entities)       → KG 多跳关系推理
  └─ query_financial_data(query)         → neodata 实时金融数据

LLM 数据源路由：
  "今天A股发生了什么"                    → query_financial_data
  "制裁对宁德时代供应链的影响"            → graph_explore
  "科技板块涨了，什么原因？哪些产业链受益" → 先 query_financial_data
                                             → 提取关键实体
                                             → graph_explore(实体)
```

### 为什么不把 neodata 放进内层探索循环

内层循环的 System Prompt 是为 KG 探索优化的（5个 MCP 工具、hops、cluster 展开、Event Thread 构建）。如果加一个"实时行情查询"工具，会让内层 LLM 的决策空间变大且混乱。

更好的做法是**外层 LLM 做数据源路由**：
1. 理解用户意图
2. 判断需要实时数据还是深度推理
3. 调用对应工具
4. 如果同时需要：先查行情，提取实体，再探索关

内层保持纯粹——只做 KG 多跳推理。这符合 v3 双层循环的设计原则。

---

## 工具定义

### query_financial_data

**语义**: 查询实时金融数据，包括股票行情、财报、基金、板块、宏观经济、外汇、大宗商品。

**何时用**:
- 用户问"今天/最近/当前"的行情、价格、涨跌、资金流向
- 用户需要财报数据、研报、基金净值
- 用户对比多个标的的市场表现
- 用户问板块异动、宏观经济指标

**不用**:
- 多跳关系推理（用 graph_explore）
- 事件历史追溯（KG 更适合）
- 供应链分析

### 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| query | string (必填) | 自然语言查询，如"今天A股科技板块表现" |
| data_type | string (可选) | all=全部, api=仅结构化数据, doc=仅文章。默认 all |

### 返回

结构化金融数据（行情、财务、资金流向等）和金融类文本（资讯、研报、公告）。

---

## 实现说明

neodata 后端是一个 HTTP 代理：

```
POST localhost:{AUTH_GATEWAY_PORT}/proxy/api
Header: Remote-URL: https://jprx.m.qq.com/aizone/skillserver/v1/proxy/teamrouter_neodata/query
Body: { query, request_id, data_type }
```

Graph Explorer 的 `query_financial_data` 工具实现为对此端点的 HTTP 客户端调用。

### 与 knowledge-graph MCP 的一致性

两个工具都遵循同一个模式：
- 相同的参数风格（自然语言 query）
- 相同的结果注入方式（tool_result 进入外层对话历史）
- 外层 LLM 对两个工具一视同仁

这保证了 LLM 的决策简单——它只需要在"深度关系推理"和"实时市场数据"之间做选择，而工具调用方式完全一致。

---

## 对 v3 设计的影响

| 维度 | 之前 | 现在 |
|------|------|------|
| 外层工具数量 | 1（graph_explore） | 2（+ query_financial_data） |
| 外层 System Prompt | 只需描述探索 | 增加数据源路由规则 |
| 上下文 | 只处理 KG 结果 | 需要同时处理两种数据源的结果 |
| P0 开发 | 外层循环 + graph_explore | 外层循环 + graph_explore + query_financial_data |

增量不大——加一个新工具就是加一个 HTTP 调用 + tool definition，模式跟 graph_explore 完全一样。

---

## 回答刚才的问题

> 为什么 Agent 回答"今天A股"用了错误数据？

因为它只有一个锤子（KG），看什么都是钉子。当用户问"今天A股"，KG 里确实有一些带今天时间戳的数据——但是是盘中快照、不同时间点的碎片事件。Agent 取到了，拼成叙事，但没有感知到这些数据不适合回答这个问题。

有了 neodata 之后，外层 LLM 的判断链：

```
用户: "今天A股发生了什么"
LLM: "这是实时行情问题 → 用 query_financial_data"
query_financial_data: "沪指 -0.43%, 科创50 +0.72%, 银行跌, AI涨"
LLM: 直接展示，不需要探索
```

这才对。

---

## 后续：何时可能需要 neodata 进入内层

目前的设计是 neodata 不进内层。但有一个场景值得关注：

> 用户: "今天市场风格从传统板块切换到科技板块，帮我分析这个切换背后的供应链传导逻辑"

这时外层可以：
1. `query_financial_data` → 拿到涨跌数据，提取关键实体
2. `graph_explore(entities=[...])` → KG 深挖这些实体间的关系链

不需要 neodata 进内层，只需要外层 LLM 能把 neodata 的输出翻译成 graph_explore 的输入（提取实体、构造 goal）。
