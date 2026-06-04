# 评估框架设计 — v2（Layer 1 + Layer 2）

> 状态: 设计完成 | 日期: 2026-06-03
>
> **Layer 1**: 零标注指标，从 Agent 输出直接计算（程序执行）。
> **Layer 2**: Ground Truth 标注 + 标注工作台（程序辅助人工）。
> **Layer 3**: 基线对比（后续版本）。

---

## 一、设计原则

1. **不用 ground truth 就不判断对错** — Layer 1 只量化 Agent 行为模式，不判断 finding 是否"正确"
2. **单值不如序列** — 效率看曲线不看单点，决策看序列不看计数
3. **指标必须有误读风险说明** — 每个指标标注"什么情况下会骗你"
4. **同 scenario 对比优先** — 绝对数值意义有限，v1 vs v2 差异才是信号

---

## 二、指标体系

### 2.1 ku_id 存证率

| 项目 | 内容 |
|------|------|
| **定义** | findings 中所有 evidence ku_id 在 `raw_event_archive` 中实际存在的比例 |
| **公式** | \|ku_id ∩ raw_event_archive\| / \|所有 evidence ku_id\| |
| **健康范围** | = 100%（每差 1% 就是一个编造的证据引用） |
| **测什么** | FINALIZE 阶段 LLM 是否遵守了指令——从 raw_event_archive 中取 ku_id 而非自行编造 |
| **误读风险** | 100% 只证明 ku_id 真实，不代表 LLM 对 ku_id 内容的解读正确。ku_id 真实 ≠ finding 正确 |
| **类别** | 代码正确性指标 |

**如果 < 100%**：FINALIZE prompt 软约束不够，需要代码级强制过滤——FINALIZE 后遍历所有 evidence，丢弃不存在的 ku_id，重新计算 finding confidence。

---

### 2.2 探索效率曲线

**不使用单值，使用累积曲线。**

| 项目 | 内容 |
|------|------|
| **X 轴** | step_count（探索步数） |
| **Y1 轴** | 累积 findings 数 |
| **Y2 轴** | 累积 token 用量 |
| **测什么** | 探索收益是否线性、饱和、还是衰减 |
| **健康形状** | 早期快速增长 → 中期缓慢增长 → 后期接近平坦（边际收益递减是正常的，但不应出现长平坦段后突然跳跃） |
| **坏形状** | ① 全程平坦 = 从未产出 insight；② 10+ 步后突然大量产出 = Agent 前期策略错误；③ token 线性增长但 finding 为零 = 纯浪费 |
| **误读风险** | 复杂 scenario 天然需要更多步，不能横向对比不同 scenario 的斜率。效率曲线的唯一正确用法是**同 scenario 不同版本对比**（config A vs B、prompt v1 vs v2） |
| **类别** | 效率指标 |

---

### 2.3 Entity Flag 双层指标

拆为两个独立指标——分别测数据质量面和保障有效面：

#### 2.3a Flag 触发率

| 项目 | 内容 |
|------|------|
| **定义** | \|entity_flags\| / \|visited_entities\| |
| **健康范围** | < 15%（>30% 说明 KG 在目标领域消歧质量差） |
| **测什么** | KG 数据质量对 Agent 行为的影响面 |
| **误读风险** | 低触发率可能不是 KG 好，而是 Agent 没探索到有问题的实体 |

#### 2.3b Flag 违规率

| 项目 | 内容 |
|------|------|
| **定义** | tool_call 中 entities 参数包含 entity_flags 中实体的步数 / 总步数 |
| **健康范围** | = 0%（>0% 说代码保障层或 LLM 指令失效） |
| **测什么** | 代码保障层是否真正拦截了问题实体。entity_flags 的消费者是代码（注入 Prompt 警告），但 LLM 仍然可能忽略警告 |
| **误读风险** | 如果 entity_flags 注入格式不当（如放在 Prompt 末尾被 LLM 忽略），违规率会高但保障层代码本身没问题 |
| **类别** | 保障有效性指标 |

---

### 2.4 决策序列分析

不使用"决策多样性"单值——多样性高可能是乱跳。

#### 2.4a 决策模式判定

对每步的 decision 序列（expand/deep_dive/verify/sufficient/stalemate），不做计数，做**模式识别**：

| 模式 | 判定 | 含义 |
|------|------|------|
| `expand → expand → expand → force_sufficient` | 🔴 不良 | Agent 一直在扩展面，从未形成判断，被循环检测强制终止 |
| `expand → deep_dive(finding) → verify(finding) → sufficient` | 🟢 健康 | 展开 → 抓线索 → 深挖 → 验证 → 正确结束 |
| `expand → deep_dive → deep_dive → deep_dive → stalemate` | 🟡 可疑 | 可能陷入单一路径过深，忽略了 wider picture |
| `expand → verify → expand → verify → expand` | 🟡 摇摆 | Agent 在两种策略间反复切换，缺乏方向感 |

#### 2.4b 决策→产出转化

| 指标 | 定义 |
|------|------|
| **转化步数** | decision 类型发生 change 时，该步是否产出了 ≥1 个 new_finding |
| **空转步数** | 连续 N 步（N≥3）decision 相同且无 new_finding |
| **stalemate 频率** | stalemate 步数 / 总步数 |

#### 2.4c 终止质量

| 指标 | 定义 |
|------|------|
| **最后 finding → Goal 距离** | 定性评估——最后一条 key_insight 的 `relation_to_goal` 是"直接回答"还是"间接相关" |
| **终止类型分布** | sufficient / force_sufficient / token_budget / frontier_empty / stalemate 各自占比 |

**误读风险**：健康模式取决于 Goal 类型。关系探索（"A 和 B 怎么关联"）天然需要更多 expand，分析探索（"某行业风险"）天然需要更多 deep_dive。判断时应结合 Goal 语义。

**类别**：Agent Loop 行为指标。

---

### 2.5 Thread 结构质量

| 指标 | 定义 | 健康范围 |
|------|------|---------|
| **事件完整性** | 含 ≥3 个事件的 thread 数 / 总 thread 数 | = 100%（设计约束） |
| **因果深度** | causal + temporal 关系数 / 总关系数 | ≥ 50%（<50% 说明 agent 在"凑事件"而非"找因果"） |
| **冗余度** | 同一 ku_id 出现在 ≥2 个 thread 中的次数 | ≈ 0（少量交叉可接受） |
| **Thread 覆盖率** | thread_events 总事件数 / raw_event_archive 总事件数 | 30%-70%（太低 = 闲置数据；太高 = 强行串） |

**核心指标**：因果深度。这是 Agent 从"数据整理"到"因果推理"的关键跃迁——如果 80% 关系都是 entity_shared，Agent 只是在把"和同一个实体相关的事件"放在一起，没有建立因果链。

**误读风险**：因果深度低可能不是 Agent 能力问题，而是 KG 在该领域确实缺乏因果关联数据（事件多但都是孤立报道）。

**类别**：推理质量指标。

---

### 2.6 探索覆盖率

| 项目 | 内容 |
|------|------|
| **定义** | \|visited_entities\| / (\|visited_entities\| + \|frontier_entities_reported_by_MCP_but_not_in_frontier\|) |
| **实际操作** | 每步 lookup/trace 返回的 `related_entities` 中，有多少被 Agent 加入 frontier 并最终 visited |
| **健康范围** | 40%-80%（太低 = 过早终止；太高 = 可能过度探索） |
| **测什么** | Agent 是否在大量未探索线索存在的情况下宣告 sufficient |
| **误读风险** | MCP 返回的 related_entities 中包含大量噪声实体（如体育队、无关企业），覆盖率低可能是 Agent 正确过滤了噪声 |
| **类别** | 终止质量指标 |

---

## 三、指标分类速查

| 类别 | 指标 | 核心问题 |
|------|------|---------|
| 代码正确性 | ku_id 存证率 | 证据引用是否真实存在 |
| 效率 | 探索效率曲线 | 每一步探索花在哪里 |
| 数据质量 | Entity Flag 触发率 | KG 烂到什么程度 |
| 保障有效性 | Entity Flag 违规率 | 保障层有没有真正拦住 |
| Agent Loop 行为 | 决策序列分析 | Agent 在"思考"还是"空转" |
| 推理质量 | Thread 因果深度 | Agent 在推理还是整理 |
| 终止质量 | 探索覆盖率 | Agent 是否过早放弃 |

---

## 四、输出格式：Scorecard

每次跑完一个 scenario，生成如下 scorecard（JSON + Markdown）：

```markdown
# Evaluation Scorecard — scenario-1-supply-chain

## 运行概要
| 项目 | 值 |
|------|----|
| Steps | 9 |
| Visited Entities | 14 |
| Findings | 1 |
| Event Threads | 2 |
| Tokens Used | 45,230 |
| Completion | sufficient |

## 指标一览

### 代码正确性
| 指标 | 值 | 状态 |
|------|----|------|
| ku_id 存证率 | 5/5 (100%) | ✅ |

### 效率曲线
[步骤 1-9: 累积 finding 0,0,0,0,0,0,0,0,1]
⚠️ 前 8 步无 finding 产出，最后一步集中输出。

### 数据质量 & 保障
| 指标 | 值 | 状态 |
|------|----|------|
| Entity Flag 触发率 | 2/14 (14%) | ✅ |
| Flag 违规率 | 0/9 (0%) | ✅ |

### 决策序列
expand → expand → deep_dive → expand → expand → expand → expand → expand → sufficient
⚠️ 连续 5 步 expand 后直接 sufficient，缺少 deep_dive/verify 过渡。

### Thread 质量
| 指标 | 值 | 状态 |
|------|----|------|
| 事件完整性 | 2/2 (100%) | ✅ |
| 因果深度 | 5/10 (50%) | ✅ |
| 冗余度 | 0 | ✅ |
| 覆盖率 | 12/45 (27%) | ⚠️ 偏低 |

### 探索覆盖
| 指标 | 值 | 状态 |
|------|----|------|
| 覆盖率 | 14/32 (44%) | ✅ |

## 综合评级
⚠️ 可接受，但效率曲线和决策序列提示 Agent 前期探索面过宽。
```

---

## 五、Layer 2: Ground Truth 评估（程序辅助人工标注 + LLM-as-Judge 匹配）

### 5.1 设计原则

1. **Ground truth 锚定于 KG，不是现实世界** — 评估"Agent 在给定 KG 上的探索能力"，不评估 KG 本身
2. **Known Checkpoints，不全量穷举** — 不声称知道所有能发现的 findings，只标注已知一定存在的
3. **标注者的认知瓶颈在"KG 里有什么"，不在"好坏判断"** — 标注工作台的价值是消除信息获取成本
4. **LLM-as-Judge 做语义匹配** — Recall 匹配不是字符串对比，是"是否表达了相同核心含义"

### 5.2 Ground Truth 标注对象

#### Known Findings（重要性分层）

不分条数，按重要性分层——标注到下一个 finding 不再是 must/should 时停止：

| 层级 | 含义 | 典型数量 |
|------|------|---------|
| **must_find** | Agent 必须找到。找不到 = 严重遗漏。KG 子图中最显然的发现，任何有经验的分析师在相同 KG 上都会得出 | 2-3 条 |
| **should_find** | 合格的分析师应该找得到。需要一定推理深度，但不超出 Agent 声称的能力范围 | 1-3 条 |
| **nice_to_find** | 加分项。找到了说明 Agent 探索质量高。不一定每个 scenario 都有 | 0-2 条 |

**标注量**：总计 4-6 条 per scenario，在人力可接受范围内。

**Recall 拆为两个独立信号**：
```
Recall_must   = |must_find 中被 Agent 匹配的| / |must_find|
Recall_should = |should_find 中被 Agent 匹配的| / |should_find|
```

**Recall_must < 100% → stop**。不需要看别的指标，Agent 在这个 scenario 上不合格。

#### Known Threads

标注已知存在的因果链（不是所有可能的 Thread，是确定性的关键链）。

#### Known False Patterns

标注不应该出现的模式。大部分来自常识判断，标注成本低。用于检测严重幻觉。

### 5.3 Ground Truth 标注格式

```yaml
scenario: scenario-1-supply-chain
goal: "追踪美国对华芯片出口管制对英伟达供应链的传导影响"

ground_truth:
  known_findings:
    - id: gt_f_1
      statement: "英伟达在中国AI芯片市场已实质性退出"
      category: pattern_violation
      importance: must_find
      min_evidence: 2

    - id: gt_f_2
      statement: "管制对英伟达供应链的直接冲击未体现在KG可观测事件中"
      category: absence
      importance: must_find
      min_evidence: 3

    - id: gt_f_3
      statement: "英伟达正加速PC端AI芯片布局，AI PC成为新增长极"
      category: concentration
      importance: should_find
      min_evidence: 2

  known_threads:
    - id: gt_t_1
      description: "AI PC战略 → 市场反应 → 新品 → 生态扩张"
      key_events:
        - ku_id: ku_ed38853d7b7cf5c8
          description: "英伟达发布PC新时代推文"
        - ku_id: ku_173a5a8bf9f8bfe8
          description: "股价涨超6%"
        - ku_id: ku_393bb7179e6bb834
          description: "发布PC端CPU芯片"
      causal_direction: forward

  known_false:
    - pattern: "英伟达与华为.*合作"
      why: "出口管制下不可信，KG中无直接证据"

annotation_meta:
  annotator: "developer"
  kg_scope: "3-hop from seed entities"
  annotation_date: "2026-06-03"
  notes: "标注基于 Agent 已探索的 KG 数据和手动补查。可能存在未覆盖的 finding。"
```

### 5.4 匹配策略

#### Precision: 人工逐条打分

标注者对 Agent 产出的每条 finding 打标签，**不使用自动化匹配**：

| 标签 | 含义 |
|------|------|
| `correct` | 完全正确，evidence 支撑 statement |
| `partially_correct` | 方向对但细节不精确 |
| `incorrect` | 解读错误或无证据支撑 |
| `uncertain` | 标注者也无法判断（不参与分母） |

```
Precision = (correct + 0.5 × partially_correct) / (total_agent_findings - uncertain)
```

#### Recall: LLM-as-Judge 语义匹配

两阶段匹配：

**Stage 1 — 实体+类别粗筛**：ground truth g 和 agent finding f 共享 ≥2 个 entities_involved 且 category 相同 → 候选。排除明显不匹配的。

**Stage 2 — LLM-as-Judge 精判**：给 LLM 出题：
```
已知 Ground Truth Finding:
  statement: "英伟达在中国AI芯片市场已实质性退出"
  entities_involved: [英伟达, 中国]
  category: pattern_violation

Agent Finding 候选:
  statement: "黄仁勋确认英伟达已撤离中国AI芯片市场但当地生态发展良好"
  entities_involved: [英伟达, 黄仁勋, 中国]
  category: absence

问题: Agent Finding 是否表达了与 Ground Truth Finding 相同的核心含义？
选项: [match / partial_match / no_match]
```

`match` 或 `partial_match` → 该 ground truth finding 被 Recall 覆盖。

#### Thread 匹配: 有序子序列包含 + 因果方向一致

**不使用 Jaccard**。Thread 是有序的因果序列，不是集合。Agent Thread 应被视为 ground truth 的**超集**（多发现不算错）。

| 判定 | 条件 |
|------|------|
| **Full Match** | 所有 gt key_events 在 Agent Thread 中出现，顺序一致，因果方向一致。Agent 可以多出中间事件 |
| **Partial Match** | ≥2/3 gt key_events 出现了，且出现部分的顺序和方向一致 |
| **Mismatch** | 任何因果方向反转 或 <2/3 覆盖 或 关键事件顺序颠倒 |

例：
```
Ground Truth:  A →causal→ B →causal→ C

Case 1: Agent = A →causal→ X →causal→ B →causal→ C   → Full Match  ✅
        (多了一个 X，但 A→B→C 顺序和方向都对)

Case 2: Agent = A →causal→ C →causal→ B                 → Mismatch   ❌
        (B→C 方向反转，因果链断裂)

Case 3: Agent = A →causal→ B                              → Partial    ⚠️
        (C 缺失，但已有部分正确)

Case 4: Agent = X →causal→ A →causal→ B →causal→ C       → Full Match  ✅
        (Agent 还发现了 A 的前置事件 X)
```

Thread 汇总指标：

| 指标 | 定义 |
|------|------|
| Full Match Rate | full_match / \|known_threads\| |
| Partial+Full Rate | (full + partial) / \|known_threads\| |
| Mismatch Rate | mismatch / \|known_threads\|（越低越好） |

### 5.5 Label 汇总公式

```
Precision        = (correct + 0.5 × partial) / (total_agent_findings - uncertain)
                    ↑ 标注者逐条打分

Recall_must      = |must_find 中被 Agent 匹配的| / |must_find|
Recall_should    = |should_find 中被 Agent 匹配的| / |should_find|
                    ↑ LLM-as-Judge 语义匹配

F1_must          = 2 × Precision × Recall_must / (Precision + Recall_must)
F1_should        = 2 × Precision × Recall_should / (Precision + Recall_should)

Thread Full       = full_match / |known_threads|
Thread Full+Part  = (full + partial) / |known_threads|
Thread Mismatch   = mismatch / |known_threads|
                    ↑ 有序子序列包含 + 因果方向检查
```

### 5.6 标注工作台（程序辅助人工）

#### 原理

标注者的认知瓶颈在于**"KG 里有什么"**——人脑同时 hold 住 200 个散落事件的难度，远大于"好坏判断"。工作台消除信息获取成本，把"KG 里有什么"从记忆负担变成阅读负担。

#### 输入: Agent 已有的 `exploration_output.json`

标注工作台不需要标注者手动探索 KG——Agent 已经探索过了，raw_event_archive 里有全量数据。工作台将探索结果按人类友好的格式展开。

#### 输出: `annotation_worksheet.md`

```markdown
# Annotation Worksheet — scenario-1-supply-chain

## 1. 探索全貌
visited: 14 entities | raw events: 45 | clusters: 11 | steps: 9

## 2. 已探索实体（按事件数排序）

| Entity | Events | Clusters | Sample Event |
|--------|--------|----------|--------------|
| 英伟达 | 12 | 5 | ku_173a: 股价涨超6% |
| 台积电 | 8 | 3 | ku_0b82: 3nm量产进展 |
| 微软 | 5 | 2 | ku_219a: AI PC秋季推出 |
| ... | ... | ... | ... |

## 3. 关键事件聚类（按事件数排序）

### clu_6a2f: 英伟达AI PC战略（6 events）
| ku_id | Entity | Event Type | Timestamp | Description |
|-------|--------|------------|-----------|-------------|
| ku_ed38 | 英伟达 | announcement | 2026-06-01 | 发布"PC新时代"推文 |
| ku_173a | 英伟达 | stock_price | 2026-06-01 | 股价涨超6%，市值+3190亿 |
| ku_393b | 英伟达 | product_launch | 2026-06-02 | 发布PC端CPU芯片 |
| ... | ... | ... | ... | ... |

→ [ ] 标注为 Known Thread?  关键事件 ku_ids: ___ (按因果序)
→ [ ] 标注为 Known Finding? statement: ___

### clu_89d1: 台积电先进制程（4 events）
| ... | ... | ... | ... | ... |

→ [ ] 标注为 Known Thread?
→ [ ] 标注为 Known Finding?

## 4. Agent Findings（供 Precision 标注）

### finding_87eb: absence, high confidence, step 9
| 项目 | 内容 |
|------|------|
| Statement | "管制影响不存在于可观测事件中" |
| Entities | 英伟达, 台积电, ARM, 微软, 华为, ... |
| Evidence | ku_0671, ku_edc6, ku_8c5f, ku_17a4, ku_f0f8 |

标注: [ ] correct  [ ] partial  [ ] incorrect  [ ] uncertain
说明: ___

## 5. Known Findings（标注者填写）

### gt_f_1
importance: [ ] must_find  [ ] should_find  [ ] nice_to_find
statement: ___
category: [ ] pattern_violation  [ ] concentration  [ ] chain  [ ] absence
key entities: ___
min_evidence: ___

### gt_f_2
importance: [ ] must_find  [ ] should_find  [ ] nice_to_find
statement: ___
...

## 6. Known Threads（标注者填写）

### gt_t_1
description: ___
key_events (≥3, 按时间/因果序):
  1. ku_id: ___  description: ___
  2. ku_id: ___  description: ___
  3. ku_id: ___  description: ___
causal_direction: [ ] forward  [ ] reverse

## 7. Known False Patterns（标注者填写）

### fp_1
pattern: ___
why: ___
```

#### 标注流程

```
1. 跑 Agent → exploration_output.json
2. 跑标注工作台 → annotation_worksheet.md
3. 标注者 marking 工作表：
   a. 浏览 §2-3（实体 + cluster 概览），建立子图心智模型
   b. 在 §4 给每条 Agent finding 打分（Precision 标注）
   c. 在 §5 写 Known Findings（≥3 条，标注 importance）
   d. 在 §6 写 Known Threads（粘贴 ku_ids）
   e. 在 §7 写 Known False Patterns
   f. 如果浏览 cluster 时触发"这里还有一个该标的"→ 回 §5/§6 补充
4. 验证脚本 → 检查 ku_ids 存在、YAML 格式正确、must_find ≥ 2 条
5. 输出 ground_truth.yaml + precision_labels.yaml
```

#### 实现成本

| 组件 | 复杂度 |
|------|--------|
| JSON → Markdown 结构化展开（§1-4） | 低（~200 行 TS） |
| 按 cluster 分组，事件时间排序 | 低（数据已结构化） |
| Agent findings 嵌入打分表 | 低 |
| 标注结果 → YAML 解析 | 中（需定义 Markdown 标注约定） |
| YAML 验证（ku_id 存在、格式正确、must_find 数量） | 低 |

### 5.7 横向可比性

同一个 annotation_worksheet 可用于多次 Agent 运行：
- 标注者先标注一次 ground truth（场景固定后不改）
- 后续 Agent 版本跑同一个 scenario，用**已标注的 ground truth** 计算 Recall
- 仅需重新做 §4 的 Precision 标注（Agent findings 变了）

---

## 六、Layer 3: 基线对比（后续版本）

| 基线 | 实现 | 对比维度 |
|------|------|---------|
| BFS naive | 纯图遍历，无 LLM reasoning，按度数展开实体 | Finding 深度 vs 效率 |
| LLM-only | 给 LLM system prompt + tools，但不给 Agent Loop | 发现质量对比 |
| Random exploration | 随机选 frontier entity，随机选工具 | 下界对照 |

---

## 七、实施优先级

| 优先级 | 内容 | 依赖 |
|--------|------|------|
| P0 | ku_id 存证率 | 无（纯代码计算） |
| P0 | Entity Flag 触发率 + 违规率 | 无 |
| P1 | 探索效率曲线 | 需要累计 tracking |
| P1 | 决策序列分析 | 无 |
| P1 | Thread 因果深度 | 无 |
| P2 | 探索覆盖率 | 需要统计 MCP 返回的 related_entities |
| P2 | Scorecard 生成器 | P0+P1 完成后 |
| P3 | 标注工作台（§1-4 自动生成） | 需要 §5 标注工具链 |
| P3 | Ground Truth 标注 + LLM-as-Judge 匹配 | 工作台就绪后 |
| P4 | 基线对比 | 需要 BFS/Random baseline 实现 |
