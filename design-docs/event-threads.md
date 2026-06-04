# Event Thread — FINALIZE 阶段的 Thread 构建

---

## Thread 定义

Event Thread = 2+ 个事件通过关系连成的故事线。每条 Thread 有：
- 标题 / 摘要 / 叙事文本
- 事件列表（每个引用 ku_id，可溯源）
- 事件间关系边（from→to, type, reasoning）
- 时间跨度
- 信心评级
- 来源的 finding IDs

---

## FINALIZE Prompt（注入 System Prompt Layer 3+）

FINALIZE 阶段不再调用工具，不再探索新实体。LLM 收到的数据：

- **key_findings**: 序列化的 finding 列表（statement + category + entities）
- **event_buffer**: 按实体分组的缓存事件（ku_id + entity + event_type + timestamp + description）
- **exploration_log**: 步骤数和决策记录

LLM 的任务：
1. 整理最终 key_findings（合并重复、保留矛盾、移除 irrelevant、排序）
2. 从 event_buffer 构建 Event Threads

---

## Thread 构建规则

| 规则 | 说明 |
|------|------|
| 最小长度 ≥ 3 事件 | 2 个事件只是"关系"，不是故事线 |
| 关系必须标注 reasoning | 每条关系边必须解释为什么认为存在这种关系 |
| 每个事件引用 ku_id | 从 event_buffer 中取，保证可溯源 |
| 不硬串不相关事件 | 一个实体的 20 个散落事件可能是多条短 Thread，也可能不成 Thread |
| 多条 Thread 之间独立 | 分开展示，不强求合并 |
| Thread 可引用多条 finding | chain 类型的 finding 是路标，Thread 是路的全貌 |

### 四种关系类型

| 类型 | 语义 | reasoning 示例 |
|------|------|---------------|
| causal | A 导致 B | "A 发生后 B 随之发生，且从内容看 A 是 B 的直接原因" |
| temporal | A 在 B 之前，无明确因果 | "从时间顺序看 A 在前 B 在后，但未找到直接因果证据" |
| entity_shared | A 和 B 涉及同一实体 | "两事件分别涉及 X 的不同方面" |
| contradiction | A 和 B 矛盾 | "A 声称合作，B 显示断供" |

### Confidence 评级

| 级别 | 条件 |
|------|------|
| high | ≥ 5 事件，关系都有明确 reasoning |
| medium | 3-4 事件，关系有 reasoning |
| low | 勉强成链，关系 weak |

---

## FINALIZE 输出格式

LLM 输出包含两个部分：

1. **key_findings**: 整理后的 finding 列表
2. **threads**: Event Thread 列表

每条 Thread 包含：
- title / summary / narrative
- thread_events（ku_id + entity + event_type + timestamp + description）
- relationships（from_idx + to_idx + type + reasoning）
- time_span
- confidence
- source_finding_ids

---

## 代码验证（FINALIZE 输出的后处理）

| 校验项 | 规则 | 失败处理 |
|--------|------|---------|
| ku_id 存在性 | 每个 thread_event 的 ku_id 必须在 event_buffer 中 | 移除幻觉事件，剩余 <3 则丢弃整条 Thread |
| 时间线一致性 | causal 关系的 from_event 必须在 to_event 之前 | 标注问题但保留 |
| 关系类型 | 只允许 4 种类型 | 非法类型钳制为 entity_shared |
| Thread 长度 | >10 个事件可能是过度串连 | 标注警告但保留 |

移除幻觉事件后需要重新计算 relationship 的索引（from_idx/to_idx 偏移）。

---

## Finding 和 Thread 的关系

chain 类型的 finding 是路标——"这里有链"。Thread 是路的全貌——"这个链的具体形态是 A→B→C→D，关系是 X，证据是 KU IDs"。

```
探索阶段:
  new_findings: [chain finding "A1→A2→A3 形成链"]

FINALIZE:
  输入: chain finding + event_buffer (A1~A5 的事件详情)
  输出: 
    Thread: A1[ku_001] → A2[ku_015] → A3[ku_032] → A4[ku_048]
           relationships: causal×2, entity_shared×1
           source_finding_ids: ["finding_chain_001"]
```

---

## 边界情况

| 情况 | 处理 |
|------|------|
| 所有事件串不起 Thread | threads: []。正常输出 |
| 有数据但 LLM 没串 | 不重试 FINALIZE。reliability_note 标注 |
| 两条 Thread 完全重叠 | 允许同一事件从不同角度属于不同 Thread。thread_events 完全一致时合并 |
| Thread 全部验证失败 | findings 保留，threads 为空。reliability_note 标注 |
