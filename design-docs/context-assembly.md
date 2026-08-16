# 上下文组装 — State View 注入策略与 Token 分池

> 状态: 已实现（v3 五意图架构） | 已对齐: 33f02f7 (2026-08-16)
>
> 源码: `src/agent/context.ts`（组装与压缩）、`src/agent/loop.ts`
> （checkContextBudget / buildLlmMessages）。v3 删除了分段压缩体系
> （HistoryStep/RawStep/CondensedStep）与 recall 按需读取，拆为
> EXPLORING / FINALIZE 两条组装路径。

---

## 核心策略

**工具返回全文不入 LLM 上下文**：原始数据存入 state（`raw_event_archive`），
LLM 每步只看到**代码级聚合的 State View + 当前步压缩视图**；FINALIZE 时
`raw_event_archive` **全量注入**。工具返回压缩仅用于当前轮，不跨轮保留。

---

## Token 预算分池（config 驱动）

总预算 = `input.max_tokens ?? llm.max_tokens ?? 128k`（见 [state.md](state.md)）。

| 池 | 占比 | 说明 |
|----|------|------|
| EXPLORING 上限 | 78% | 触达强制 FINALIZE |
| FINALIZE 预留 | 16% | 保证 Thread 构建 |
| 机动 | 6% | 缓冲 |

---

## EXPLORING 路径: State View（每步注入）

代码从 ExplorationState 按固定 schema 聚合的统计摘要——**不是 LLM
summarization，是代码级无损聚合**。包含：

- visited 实体摘要（按类型分组，标注事件数/类型）
- frontier + 每个候选的 source_reason
- entity_flags（代码保障注入的告警）
- key_insights 列表
- 预算使用率与步数

## EXPLORING 路径: 当前步工具结果压缩

| 预算使用率 | 注入策略 |
|-----------|---------|
| < 50% | 摘要行 + 前 5 条事件标题 |
| 50-70% | 摘要行 + 前 3 条 |
| > 70% | 仅摘要行（计数统计） |

- **expand 例外**: 返回的 cluster 事件清单直接给 LLM（深挖场景需要细节）
- **硬截断**: 单步注入不超过 4k token（超长截断 + 标注）

---

## 消息序列（buildLlmMessages）

- 首轮: goal + State View 作为首条 user 消息
- 后续轮: **追加**新 State View，历史消息全量回放（不删改）
- 上下文膨胀不靠删历史，靠下述压缩阶梯处置

## 四级压缩阶梯（checkContextBudget，每步检查）

上下文估算 / exploring_limit 的比值：

| 比值 | 动作 |
|------|------|
| ≥ 85% | 压缩 `exploration_log`（决策历史瘦身）；压缩后仍 > 95% → FINALIZE |
| ≥ 90% | 警告（token_warnings 计数，State View 注入"建议尽快 conclude"） |
| ≥ 95% | （压缩后仍超标）→ FINALIZE |
| ≥ 100% | 强制 FINALIZE |

`BudgetStatus`（供 Prompt 提示）: `isTight ≥ 0.8` / `isSevere ≥ 0.9`。

---

## FINALIZE 路径: 全量注入（buildFinalizeStateView）

| 注入块 | 内容 |
|--------|------|
| key_insights 全部 | 完整 finding 列表 |
| raw_event_archive 全部 | 按实体分组的原始事件，带类型标注 `[事实]/[指标]/[快照]` |
| exploration_log | 每步 decision + 策略切换记录 |
| entity_flags / cluster_flags | 告警与数据质量标记（如有） |

降级：FINALIZE LLM 失败 → 跳过 Thread 构建 → 代码直接输出 findings + 空
threads（见 [error-handling.md](error-handling.md)）。
