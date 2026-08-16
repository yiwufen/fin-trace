# Key Findings — 提取规则与质量控制

> 状态: 已实现（v3 五意图架构） | 已对齐: 33f02f7 (2026-08-16)
>
> 源码: `src/agent/findings.ts`。v3 变化: LLM 的 new_findings 可携带
> `flag_target` 路由到三层存储；无证据 finding 从"暂存"改为**直接丢弃**；
> confidence 调整改用**事件类型加权**的 evidence 计数。

---

## 四种 Finding 类型

| 类型 | 触发 | 示例 |
|------|------|------|
| pattern_violation | 预期 X 但找到了 Y（意外发现） | "预期欧盟供应商都有制裁记录，但 Supplier C 零制裁" |
| concentration | 某实体/事件类型集中出现（统计显著） | "15 个供应商中 12 个有 supply_chain_disruption" |
| chain | 散落事件能串成逻辑链（结构发现） | "A 发布新品 → B 降价 → C 退市" |
| absence | 预期有但没找到（有意义的空白） | "尽管公开宣称合作，A 和 B 之间无直接投资证据" |

---

## 提取时机（`shouldExtractFindings`，代码判断）

| 触发条件 | 规则 |
|---------|------|
| 步数阈值 | 第 3 步、第 5 步必提取；第 5 步后每 3 步一次（`(step−5)%3==0`） |
| 策略切换 | expand→deep_dive 或 deep_dive→verify 的那一步 |
| 终止触发 | 最后决策为 sufficient 时（保证收尾前最后一轮提取） |

触发后，System Prompt 相应层的 `new_findings` 字段被激活，LLM 在
reasoning 中附带发现。

---

## LLM 输出格式（RawFinding）

```json
{
  "category": "chain",
  "statement": "…",
  "confidence": "high",
  "entities_involved": ["A", "B"],
  "relation_to_goal": "…",
  "flag_target": "entity | cluster | （缺省）",
  "cluster_id": "（flag_target=cluster 时必填）"
}
```

`evidence` 与 `discovered_at_step` 由代码填充，LLM 不输出。

---

## flag_target 三分流路由（`processNewFindings`）

| 路由 | 条件 | 目的地 | 去重 |
|------|------|--------|------|
| 1 | `flag_target="entity"` | `entity_flags`（flag_type=unreliable_mapping，代码保障注入 Prompt） | entity_name + description 相同则跳过 |
| 2 | `flag_target="cluster"` + cluster_id | `cluster_flags`（flag_type=data_conflict，随 cluster 数据绑定） | cluster_id + description 相同则跳过 |
| 3 | 缺省 | `key_insights`（走下述 evidence/去重/置信度全流程） | 见去重规则 |

前两条路由不要求 evidence（告警/标记语义），第三条严格执行证据链。

---

## Evidence 提取（仅路由 3）

代码按实体名匹配提取 KU ID，两级来源：
1. `last_tool_results_raw` — 当前步工具结果中，KU 的 entities 与
   `entities_involved` 有子串重叠
2. 为空时回退 `raw_event_archive` 全量匹配

---

## 去重与合并规则（仅路由 3）

| 情况 | 判断标准 | 处理 |
|------|---------|------|
| 语义重复 | entities 交集/并集 ≥ 50% + 同 category + statement 关键词重叠 ≥ 60%（按较短方计） | 合并：evidence 取并集，confidence 取高 |
| 矛盾 | 实体重叠 + 同 category + 一个含否定词（没有/无/零/未/不存在/缺失）一个肯定 | 双保留，互相标记 conflict_with |
| 无证据 | evidence 为空 | **直接丢弃**（不暂存——"无证据=无效发现"约束的严格执行） |

---

## Confidence 调整规则（事件类型加权）

LLM 初始自评，代码按**加权 evidence 数量**调整（非简单计数）。
权重按 `event_data_type`（见 [data-taxonomy.md](data-taxonomy.md)）:
structural_fact ×1.0 · aggregate_metric ×0.8 · unknown ×0.6 ·
streaming_snapshot ×0.4。

| LLM 自评 | 加权 evidence 数 | 调整后 |
|---------|----------------|--------|
| high | ≥ 3 | high |
| high | < 3 | medium |
| medium | ≥ 5 | high |
| medium | < 2 | low |
| low | ≥ 5 | medium |
| 其他 | - | 不变 |

合并时取两者中较高的 confidence。

---

## FINALIZE 阶段的最终整理

LLM 收到全部 key_insights 后：合并语义重复（保留更精确的 statement）、
矛盾双保留、移除 irrelevant、按对 Goal 的 directness 排序。

代码侧（`deduplicateFindings`）：按 statement 精确去重后写入
`final_findings`；evidence 的 ku_id 存在性由 Thread 验证链保证
（见 [event-threads.md](event-threads.md)）。
