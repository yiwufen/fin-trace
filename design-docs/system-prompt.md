# System Prompt — 六层结构与设计意图

> 状态: 已实现（v3 五意图架构） | 已对齐: 33f02f7 (2026-08-16)
>
> **逐字正文以 `src/agent/prompt.ts` 为唯一事实源**（本文件曾被全文复制，
> 已改为结构 + 意图 + 源码锚点，避免双份维护漂移）。

---

## 概述

总 token ~3000，注入到 LLM API 的 system 角色。组装函数
`buildSystemPrompt(state)`（prompt.ts:274-305）按 phase 激活不同段：

- **EXPLORING**: Layer 1 → 时间上下文 → entity_flags 警告 → Layer 2 → 3 → 3A → 4 → 5 → 6
- **FINALIZE**: Layer 1 → 时间上下文 → Layer 2 → Layer 3+（替换 3/3A/4/5/6）

---

## 结构总览

| 段 | 源码锚点（均在 prompt.ts） | 激活 | 内容 |
|----|---------|------|------|
| Layer 1 身份与边界 | `LAYER_1_IDENTITY` (prompt.ts:9-15) | 始终 | KG-only 认知边界、Goal 指向、每步自检 |
| 时间上下文注入 | `buildTimeContextText` (prompt.ts:34-61) | 始终（运行时计算） | 当前时刻/交易日/盘前盘中收盘的时效性提醒 |
| entity_flags 警告 | `buildEntityFlagsWarning` (prompt.ts:17-32) | 仅 EXPLORING 且有 flag | 代码检测的消歧警告，工具说明前必读 |
| Layer 2 工具说明 | `LAYER_2_TOOLS` (prompt.ts:63-94) | 始终 | 5 工具语义/时机/参数（hops 用默认值的规则在此） |
| Layer 3 决策框架 | `LAYER_3_DECISION` (prompt.ts:115-156) | 仅 EXPLORING | 每步 JSON 输出协议 |
| Layer 3A 状态字段说明 | `LAYER_3A_STATE_FIELDS` (prompt.ts:96-113) | 仅 EXPLORING | State View 三层字段（entity_flags/cluster_flags/key_insights）的消费规则 |
| Layer 3+ FINALIZE 段 | `LAYER_3_PLUS_FINALIZE` (prompt.ts:158-225) | 仅 FINALIZE | findings 整理 + Thread 构建指令 |
| Layer 4 策略指导 | `LAYER_4_STRATEGY` (prompt.ts:227-253) | 仅 EXPLORING | expand/deep_dive/verify 三策略与切换触发 |
| Layer 5 输出格式 | `LAYER_5_FORMAT` (prompt.ts:255-261) | 仅 EXPLORING | JSON 纯净输出、并行/串行规则、中文实体名 |
| Layer 6 硬约束 | `LAYER_6_CONSTRAINTS` (prompt.ts:263-270) | 仅 EXPLORING | 不推测/不重复查/frontier 空必停等 6 条 |

---

## 各段设计意图

### Layer 1 — 身份与边界

确立"你看到的就是全部"的认知边界：知识只来自 KG，禁用预训练知识与
推测。每步自检"离 Goal 更近了吗"驱动收敛意识。

### 时间上下文注入（v3 新增）

解决"今天"数据的时效性对齐：非交易日/盘前/盘中/收盘四种状态下，
KG 中 timestamp 为"今日"的数据含义不同（收盘数据 vs 盘中快照）。
由 `computeTemporalContext`（loop.ts:92-136，上交所时段+节假日表）计算。

### entity_flags 警告（v3 新增，代码保障）

entity_flags 非空时，在 Layer 2 之前注入"实体消歧警告"——LLM 必须
避开被标记实体。这是代码对 LLM 行为的硬性引导，非建议。

### Layer 3 — 每步决策协议

输出 JSON: `reasoning`（结构化：方向→Goal 关联→数据→打算）、
`decision`（仅探索策略 expand/deep_dive/verify）、独立的 `stop`/
`stop_reason` 终止信号（含 stale/block/no_progress 关键词判僵局）、
`tool_calls`（无依赖并行）、`new_findings`（可选，含 `flag_target`
路由提示，见 findings.md）。关键规则：终止与策略解耦；hops 永远用
默认值；frontier 是提醒清单不是约束。

### Layer 3A — 状态字段消费规则（v3 新增）

向 LLM 解释 State View 中三层发现存储的定位差异：entity_flags 代码
验证过、不可覆盖；cluster_flags 随数据可见、不做高信心推理；
key_insights 自由消费（引用/合并/推翻），数量多 → 考虑 FINALIZE。

### Layer 3+ — FINALIZE 指令

三任务: ① 整理最终 key_findings（合并/矛盾保留/剔除低置信/按
relevance 排序；evidence 必须取自 raw_event_archive 真实 ku_id）；
② 从 raw_event_archive 构建 Event Threads（`[事实]` 为主体、
`[指标]` 仅作终结节点、`[快照]` 不入因果链）；③ 输出 finalize JSON。
验证规则见 event-threads.md。

### Layer 4 — 三策略

expand（扩大面）/ deep_dive（追线索）/ verify（验证假设），各配典型
动作、判断标准、切换触发。行为准则压制过早终止："犹豫够不够就是不够"。

### Layer 5 / 6 — 格式与硬约束

纯 JSON 输出、1-4 个 tool_calls、中文名实体；六条不可违反项
（不推测、不重复查询、frontier 空必停、合法 JSON、聚焦 Goal、
矛盾标注不强行统一）。

---

## 维护约定

修改任何层的措辞 = 修改 `src/agent/prompt.ts` 对应常量；本文件只更新
锚点行号与设计意图，不复制正文。按 AGENTS.md 约束，改 agent 核心行为
的 PR 须同 PR 更新本文件的锚点。
