# 数据分类体系 — EventDataType

> 日期: 2026-06-04
> 状态: 已实现
> 触发: KG 数据源异构性导致时序混叠、置信度失真、因果链掺杂流式快照

---

## 一、问题

金融知识图谱返回的 `knowledge_unit` 不是同质的。当前设计将其统一视为"事件"，导致三个问题：

1. **时序混叠**：盘中快照和收盘价共享同一日期级 timestamp，Agent 无法区分数据采集时间点
2. **置信度失真**：三条流式快照 evidence 的权重等同三条结构性事实的 evidence
3. **因果链掺杂**：盘中瞬时价格变化与制裁/并购等结构性事件被放入同一条因果链

根因：Agent 缺少数据层抽象——一个对 KG 返回数据做分类的类型系统。

---

## 二、EventDataType 定义

```typescript
type EventDataType =
  | "structural_fact"     // 结构性事实
  | "streaming_snapshot"  // 流式快照
  | "aggregate_metric"    // 聚合指标
  | "unknown";            // 无法分类
```

| 类型 | 例子 | 时间精度 | 可变性 | 是否入因果链 | 置信度权重 |
|------|------|---------|--------|------------|-----------|
| `structural_fact` | 制裁公告、并购、财报发布、供应链中断 | 日期级 | 不可变 | 是（主体） | ×1.0 |
| `aggregate_metric` | 收盘价、营收、PE、市值 | 日期/周期级 | 可被修正 | 仅终结节点 | ×0.8 |
| `streaming_snapshot` | ETF 盘中涨幅、个股实时报价 | 时间级 | 高度可变 | 否 | ×0.4 |
| `unknown` | 无法推断 | — | — | 保守处理 | ×0.6 |

---

## 三、分类机制

**LLM 批量分类**，不是关键词匹配。

每步探索结束时，所有新归档的 KU 被标记为 `unknown`，然后批量发送给 LLM 做一次分类调用。

```
handleExploring:
  1. executeToolCalls → results
  2. archiveRawEvents → event_data_type = "unknown"
  3. classifyBatchEvents(state)
       ├─ 收集所有 event_data_type === "unknown" 的事件
       ├─ 构建批量分类 prompt（约 200 token 系统提示 + JSON 输入）
       ├─ LLM 调用（max_tokens=500）
       ├─ 解析返回的 JSON 数组 [{ku_id, event_data_type}]
       └─ 更新 state.raw_event_archive 中的 event_data_type
  4. processNewFindings（使用分类结果做置信度加权）
```

**设计决策**：

- **每个 KU 只分类一次**：`classifyBatchEvents` 按 `event_data_type === "unknown"` 过滤，已分类的不会重复处理
- **LLM 失败不阻塞**：分类失败时保持 `"unknown"`，下游正常处理（权重 ×0.6）
- **批量而非逐条**：一次 LLM 调用处理本步所有新 KU，不逐条调
- **轻量 prompt**：约 200 token 系统提示 + JSON 输入，响应约 50-200 token

**为什么不用关键词匹配**：

同一个 KU 可能包含多种信息（如"盘中跌幅扩大至 5% 触发临停机制"），关键词匹配会把整个 KU 分到一类，丢失另一类信息。LLM 能理解语义混合并判断核心性质。此外，分类依据是数据来源性质和可变性，不由文本内容中的特定词汇决定。

---

## 四、下游行为规则

### 4.1 Thread 构建

- `streaming_snapshot` **不进 Thread**。代码侧在 `validateThreads` 中自动过滤。
- `structural_fact` 构成因果链主体。
- `aggregate_metric` 仅作为终结节点（如"制裁 → 供应链中断 → 营收下降"）。

内层 FINALIZE prompt 告知 LLM 此规则（通过 `[事实]`/`[指标]`/`[快照]` 标签）。

### 4.2 Finding 置信度

`adjustConfidence` 使用加权 evidence count：

```
weighted_count = Σ EVENT_TYPE_WEIGHT[event.event_data_type]
```

一条 `structural_fact` evidence 等价于 2.5 条 `streaming_snapshot` evidence。

### 4.3 外层 LLM 翻译

外层 prompt 的"数据分类认知"段告知 LLM：
- 三类数据的性质差异
- 价格类结论标注时间点
- 同实体同日数值冲突时优先采信聚合指标

---

## 五、维护

分类逻辑在 LLM 侧，无需维护关键词映射表。当 KG 新增事件类型时，LLM 基于语义自动适应。

如分类准确率不达标，调整位置：`src/agent/loop.ts` 中 `CLASSIFY_PROMPT` 常量。
