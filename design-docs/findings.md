# Key Findings — 提取规则与质量控制

---

## 四种 Finding 类型

| 类型 | 触发 | 示例 |
|------|------|------|
| pattern_violation | 预期 X 但找到了 Y（意外发现） | "预期欧盟供应商都有制裁记录，但 Supplier C 零制裁" |
| concentration | 某实体/事件类型集中出现（统计显著） | "15 个供应商中 12 个有 supply_chain_disruption" |
| chain | 散落事件能串成逻辑链（结构发现） | "A 发布新品 → B 降价 → C 退市" |
| absence | 预期有但没找到（有意义的空白） | "尽管公开宣称合作，A 和 B 之间无直接投资证据" |

---

## Finding 字段

| 字段 | 说明 |
|------|------|
| id | 唯一标识 |
| category | 四种类型之一 |
| statement | 一句话自然语言描述 |
| confidence | high / medium / low |
| evidence | KU ID 列表（代码从 tool result 提取，非 LLM 填写） |
| entities_involved | 涉及的实体 |
| relation_to_goal | 对 Goal 的贡献 |
| discovered_at_step | 发现步骤（代码填写） |
| conflict_with | 与另一个 finding 矛盾时标注 |

---

## 提取时机

4 个触发点，由代码判断：

| 触发条件 | 说明 |
|---------|------|
| 步数阈值 | 第 3 步、第 5 步提取，之后每 3 步一次 |
| 策略切换 | expand→deep_dive 或 deep_dive→verify 时 |
| 意外发现 | 当前步返回的事件类型显著不同于预测 |
| 终止触发 | LLM decision = sufficient 时 |

触发后，System Prompt Layer 3 的 `new_findings` 字段被激活，LLM 在 reasoning 中附带发现。

---

## LLM 输出格式

LLM 在每步 reasoning 中可以附带 new_findings。其中 `evidence` 和 `discovered_at_step` 由代码填充（从当前步的 tool result 中提取 KU IDs），不需要 LLM 输出。

---

## 去重与合并规则

| 情况 | 判断标准 | 处理 |
|------|---------|------|
| 语义重复 | entities 交集 ≥50% + 同 category + statement 关键词重叠 ≥60% | 合并：证据合并，confidence 取高 |
| 矛盾 | 实体重叠 + 同 category + 一个含否定词一个含肯定词 | 双保留，互相标记 conflict_with |
| 无证据 | evidence 为空 | 不进入 key_findings，存入 low_confidence_findings |

### 相似度判断要素

1. entities_involved 交集占并集比 ≥ 50%
2. 同一 category
3. statement 关键词重叠 ≥ 60%

### 矛盾检测要素

- 实体重叠
- 同一 category
- 一个 statement 含否定词（没有/无/零/未/不存在/缺失），另一个是肯定陈述

---

## Confidence 调整规则

LLM 初始自评 confidence，代码根据 evidence 量调整：

| LLM 自评 | evidence 数量 | 调整后 |
|---------|-------------|--------|
| high | ≥ 3 | high |
| high | < 3 | medium |
| medium | ≥ 5 | high |
| medium | < 2 | low |
| low | ≥ 5 | medium |
| 其他 | - | 不变 |

合并时取两者中较高的 confidence。

---

## FINALIZE 阶段的最终整理

LLM 收到所有 findings 列表后的任务：
1. 合并语义重复的 finding → 保留更精确的 statement
2. 矛盾的都保留，标记 conflict
3. 移除不再 relevant 的（low confidence + 后续探索未证实）
4. 按对 Goal 的 directness 排序

代码验证：每个 finding 的 evidence KU IDs 必须在 event_buffer 中有对应。移除后没有 evidence 的 finding 降级。
