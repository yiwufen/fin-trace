# 三层上下文架构 — 根本解决上下文膨胀

---

## 问题根因

Agent Loop 每步将 MCP 工具返回**全量注入 LLM 上下文**。工具返回的最大价值是信息，但不需要全文都在上下文中。

---

## 解法：热/温/冷三层 + State-centric

```
热层: LLM 上下文（~20k tokens）
  只保留:
  - 当前步 tool result 的摘要
  - State View（按 schema 聚合的统计视图）
  - 对话历史（仅决策摘要）
  - 当前步关键事件的原文（至多 3 条 KU 全文）
       │ LLM 可通过 recall_* 工具读取
       ▼
温层: 代码侧结构化 State
  ExplorationState:
    visited, frontier, event_buffer(带优先级驱逐),
    key_findings, exploration_log, ...
  内存读取工具:
    recall_entity(name)
    recall_buffer(filter?)
    recall_finding(id)
       │ 驱逐的事件
       ▼
冷层: 归档（被驱逐的事件）
  按实体索引存储
  recall_buffer 可回查（标注 archived）
  保留到探索结束（FINALIZE 用）
```

---

## 关键改动（v1→v2）

### 1. 工具返回不再全量注入

旧: 代码调 lookup → 结果全文注入 LLM 上下文
新: 代码调 lookup → 结果存入温层 → LLM 上下文注入摘要+标题行

### 2. 新增 3 个内存读取工具

不调 MCP，纯代码侧读取，0 网络延迟。

### 3. State View 按 Schema 聚合

旧: 已访问实体 = 纯字符串列表，信息密度极低
新: 按类型 + 事件类型做 COUNT + GROUP BY，**无损的统计摘要**

### 4. event_buffer 优先级驱逐

旧: FIFO，满 50 踢最早的事件
新: 分层驱逐（protected → priority 3/2/1），被 finding 引用的事件永不驱逐

### 5. 并行调用的 Token 预检

旧: 允许至多 4 个并行调用，不检查总返回量
新: 调用前预估总 token cost，超预算降级为串行或强制 FINALIZE

### 6. FINALIZE 预算分池

旧: EXPLORING 和 FINALIZE 共享 128k
新: EXPLORING 100k / FINALIZE 20k / 机动 8k。EXPLORING 触 100k 强制 FINALIZE。

---

## 与竞品对比

| 维度 | OpenClaw LCM | Claude Code | Graph Explorer |
|------|-------------|-------------|----------------|
| 压缩方式 | LLM summarization（通用） | 截断 + 文件（通用） | **代码聚合**（领域感知） |
| 信息丢失 | 有（summarization 失真） | 有（截断丢尾部） | **极低**（统计无损，原文在温层） |
| 按需展开 | lcm_expand | read_file | recall_entity / recall_buffer |
| 存储粒度 | 轮次级 | 文件级 | **实体级 + 事件级** |

**核心差异**: OpenClaw 和 Claude Code 都是**通用压缩**（对自然语言做 summarization），Graph Explorer 的数据**有 schema**——可以做到代码级的无损聚合，比任何 LLM summarization 都精确。

---

## 改动清单

| 文档 | 改动 |
|------|------|
| state.md | 新增 EntitySummary, EventBufferEntry（priority/protected）, Archive |
| tools.md | 新增 3 个内存读取工具 |
| context-assembly.md | 热层注入策略、State View 聚合、Token 分池 |
| agent-loop.md | 工具返回处理流程 + 并行预检 + FINALIZE 降级 |
| error-handling.md | 内存读取失败 + 预算分池告警 + FINALIZE 降级 |
