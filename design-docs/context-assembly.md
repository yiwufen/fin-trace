# 上下文组装 — 热层注入策略与 Token 分池

> 三层架构根因分析详见: [three-tier-architecture.md](three-tier-architecture.md)

---

## 核心策略

**工具返回全文不入 LLM 上下文。** 工具返回存入温层 State，LLM 只看到压缩摘要。需要细节时通过 recall_* 内存工具按需读取。

---

## Token 预算分池

| 池 | 占比 | Token 数 | 说明 |
|----|------|---------|------|
| System Prompt | 固定 | ~3k | 角色 + 工具说明 + 决策框架 |
| Goal + Seed | 固定 | ~0.1k | 探索目标和起始实体 |
| State View | 每步 | ~0.5k | 按类型聚合的统计视图 |
| 当前步 tool result | 每步 | ~2-4k | 压缩摘要 + 前 N 条标题 |
| 对话历史 | 累计 | ~1-3k | 仅决策摘要，不保留 tool result 原文 |
| LLM reasoning 输出 | 预留 | ~2k | |
| 温层按需读取 | 动态 | ~0-10k | LLM 主动调 recall 工具 |
| **EXPLORING 上限** | **78%** | **100k** | 触达强制 FINALIZE |
| **FINALIZE 预留** | **16%** | **20k** | 保证 Thread 构建 |
| **机动** | **6%** | **8k** | 缓冲 |

---

## 热层: State View 格式（每步注入）

State View 是代码从 ExplorationState 按固定 schema 聚合的统计摘要。**不是 LLM summarization，是代码级无损聚合。**

包含：
- 已探索实体（按类型分组，每个实体标注关键事件数和类型）
- event_buffer 统计（按事件类型分组计数）
- 最近 findings 列表（每条一行）
- frontier top 5（按 priority 排序）
- 预算使用率和步数

---

## 热层: 当前步 tool result 注入

工具返回存入温层后，LLM 看到的版本包含：
- 摘要行（entity + event_type + timestamp）
- 前 N 条的标题行（非全文）
- 超量部分提示"更多用 recall 工具读取"

### 注入量随预算动态调整

| 预算使用率 | 注入策略 |
|-----------|---------|
| < 50% | 前 5 条标题 |
| 50-70% | 前 3 条标题 |
| > 70% | 仅摘要行 |

### 特殊处理

- **expand 工具**: 返回的 cluster 事件清单直接给 LLM（因为这是深挖，LLM 需要看细节）
- **硬截断**: 单步注入不超过 4k token

---

## 热层: 对话历史

仅保留每步的决策摘要（策略 + 工具 + 结果一行），不保留原始 tool result。

格式示例：
```
Step 1: expand  → lookup(宁德时代)         → +5 frontier, +1 cluster
Step 2: expand  → expand(cluster_abc)      → +2 findings, +3 frontier
Step 3: deep_dive → trace(宁德, 比亚迪)      → 1 关系路径, 共享 3 供应商
```

---

## 温层: 内存读取工具

LLM 通过 3 个工具按需访问温层数据：

| 工具 | 返回 | Token 估算 |
|------|------|-----------|
| recall_entity(name) | 该实体在 visited+buffer 中的所有已知信息 | ~500-2000 |
| recall_buffer(event_type?, entity?) | event_buffer 中匹配条件的事件摘要 | ~300-1000 |
| recall_finding(finding_id) | finding 的完整证据链（关联 KU 全文） | ~1000-5000 |

---

## 温层: event_buffer 驱逐策略

| 优先级 | 条件 | 说明 |
|--------|------|------|
| protected | 被 finding 引用 | 永不驱逐 |
| 3 | near-frontier 实体 + 近期事件 | 最高优先 |
| 2 | frontier 实体但非近期，或近期但非 frontier | |
| 1 | 背景事件（未被 finding 引用） | 最先驱逐 |

每次驱逐 priority 最低的 5 条 → 进入 archive（按实体索引）。

---

## 冷层: 归档

被驱逐的事件按实体索引存储。recall_buffer 可回查（标注 "archived"）。FINALIZE 阶段可用完整 archive 构建 Thread。

---

## FINALIZE 上下文组装

注入：
- System Prompt Layer 3+（FINALIZE 指令）
- Goal
- 完整 key_findings 列表（brief 格式）
- event_buffer 摘要（按实体分组统计）
- exploration_log 摘要（每步 decision + 关键发现）

温层 recall 工具仍然可用。保证至少 20k token 预算。

降级：FINALIZE LLM 失败 → 跳过 Thread 构建 → 代码直接输出 findings + 空 threads。

---

## 与竞品对比

| 维度 | OpenClaw LCM | Claude Code | Graph Explorer |
|------|-------------|-------------|----------------|
| 压缩方式 | LLM summarization | 截断 + 文件 | 代码聚合（领域感知，无损） |
| 信息丢失 | 有（summarization 失真） | 有（截断丢尾部） | 极低（统计无损，原文在温层） |
| 按需展开 | lcm_expand | read_file | recall_entity / recall_buffer |
| 存储粒度 | 轮次级 | 文件级 | 实体级 + 事件级 |
