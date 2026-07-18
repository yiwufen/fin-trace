# Golden Set + 评测体系 第一阶段设计

> 状态: 设计完成，待用户审阅 | 日期: 2026-07-18
>
> 范围: 第一阶段仅覆盖**探索层面**的**探索效率**与**探索质量**两个维度。
> 后续阶段（Precision 标注、基线对比、跨 run 统计）不在本 spec 范围内。

---

## 一、定位与边界

### 1.1 本阶段测什么

| 维度 | 定义 |
|------|------|
| **探索效率** | agent 探索的事件中，有多少最终被采纳进 thread（探索的"信噪比"） |
| **探索质量** | agent 是否发现了 KG 子图内本应发现的关键结论（Recall 为主） |

### 1.2 本阶段不测什么

- **不评判 finding 的措辞、confidence 分级、thread 叙事质量**——这些是第二阶段（Precision 标注）的事
- **不做跨场景的横向对比**——4 个场景类型不同，绝对值不可比；只支持同场景跨 run 对比
- **不做基线对比**（BFS / random / LLM-only）——这是第三阶段
- **不处理 LLM-as-Judge**——避免引入 judge LLM 噪声，Recall 用规则匹配 + 人工裁决

### 1.3 与既有资产的关系

| 既有资产 | 处理方式 |
|---------|---------|
| `design-docs/archive/evaluation.md`（已过时） | 仅作参考输入，**不作为权威**。本 spec 重新定义所有指标 |
| `tests/e2e/run-scenarios.ts` + 4 份捕获输出 | 保留为 smoke 测试，不动。4 个场景的 ExplorationInput 复制到 `eval/golden/scenarios.yaml` 作为评测权威输入；两份在 4 个 case 上保持同步，分歧时以 eval/ 为准 |
| `findings.ts` 的 `isSimilarFinding` 规则 | 作为规则匹配的参考实现，**重新实现一份**在 `eval/metrics/lib/match-rule.ts`，不直接 import（避免评测代码反向依赖 agent 内部模块） |

---

## 二、Golden Set 结构

### 2.1 场景输入

文件：`eval/golden/scenarios.yaml`

```yaml
scenarios:
  - id: scenario-1-supply-chain
    goal: "追踪美国对华芯片出口管制对英伟达供应链的传导影响"
    seed_entities: ["英伟达", "台积电"]
    max_depth: 4
  - id: scenario-2-competitive-landscape
    goal: "英伟达在 AI 芯片市场的竞争地位，以及主要竞争对手的动态"
    seed_entities: ["英伟达"]
    max_depth: 4
  - id: scenario-3-multi-hop
    goal: "英伟达和特斯拉之间通过哪些中间实体产生关联"
    seed_entities: ["英伟达", "特斯拉"]
    max_depth: 4
  - id: scenario-4-geopolitical
    goal: "中美科技竞争背景下，英伟达面临的政策风险有哪些传导路径"
    seed_entities: ["英伟达"]
    max_depth: 4
```

### 2.2 Ground Truth 标答

文件：`eval/golden/ground-truth/<scenario-id>.yaml`，每场景一份。

```yaml
scenario: scenario-1-supply-chain
annotation_meta:
  annotator: "developer"
  annotation_date: "2026-07-18"
  kg_scope: "3-hop from seed entities（线上 KG，不冻结快照）"
  notes: "标注基于一次实际 run 的 raw_event_archive + 手动补查。可能存在未覆盖的 finding。"

known_findings:
  - id: gt_f_1
    statement: "..."
    category: pattern_violation        # pattern_violation / concentration / chain / absence
    importance: must_find              # must_find / should_find / nice_to_find
    key_entities: ["英伟达", "中国"]    # 用于规则匹配的实体 Jaccard
    min_evidence: 2                    # agent 命中时 evidence 数必须 ≥ 此值才算"实质命中"
    aliases: []                        # 人工裁决回填：语义等价的 agent 表述（渐进收敛）

known_threads:
  - id: gt_t_1
    description: "..."
    key_events:                        # 按因果/时间序
      - ku_id: "ku_xxx"
      - ku_id: "ku_yyy"
      - ku_id: "ku_zzz"
    causal_direction: forward          # forward / reverse
    aliases: []                        # 同上

known_false:
  - id: fp_1
    pattern: "英伟达与华为.*合作"        # 正则或自然语言描述
    why: "出口管制下不可信，KG 中无直接证据"
```

### 2.3 标注量约束

- `known_findings`：每场景 **must_find 2-3 条 + should_find 1-3 条 + nice_to_find 0-2 条**，总计 4-6 条
- `known_threads`：每场景至少 1 条（4 个场景均有合适的因果链可标）
- `known_false`：每场景 0-2 条，**仅作告警，不计入 Recall 分母**（属于 Precision 范畴）

---

## 三、指标体系

### 3.1 探索效率（一个指标）

**核心原则：原始数据分别存两个独立计数（`useful_events_count`、`total_events_count`），不预计算比值。比值只在 scorecard 渲染时算。**

| 项目 | 内容 |
|------|------|
| **分母** `total_events_count` | `state.raw_event_archive.length`（探索过程中沉淀的 RawEvent 总数） |
| **分子** `useful_events_count` | `∪ event_threads[].thread_events[].ku_id` 的大小（**去重后**进入任一 thread 的 ku_id 数） |
| **比值** | `useful_events_count / total_events_count`，**仅 scorecard 渲染时计算** |
| **降级处理** | 照算。FINALIZE 降级导致 thread 为空 → 分子 = 0 → 比值 = 0；scorecard 同位置输出 `reliability_note` 让读者区分"真低效"vs"FINALIZE 失败" |
| **误读风险** | ① 低分子可能是 thread 降级而非真低效（看 reliability_note）；② 高分子可能是 thread 强行串关联事件，需配合 §3.2 thread 因果深度交叉看 |

**为什么分子按 ku_id 去重而非 thread_events 总条数**：同一条 ku_id 可能出现在多个 thread 中（thread 冗余），按 ku_id 去重后才是"真正被采纳的事件点"，与分母（archive 里的 ku_id 数）口径一致。

**分子去重 ≠ 消除冗余**：分子去重是把"同一条 ku_id 被算作 1 个有用事件"的口径与分母对齐；thread 冗余度（§3.2）仍作为独立指标统计——它衡量的是"同一条 ku_id 被塞进多个 thread"，这两个概念不冲突。

### 3.2 探索质量 - 结构层（零标注，三个指标）

| 指标 | 定义 | 来源 |
|------|------|------|
| **ku_id 存证率** | `∪ output.findings[].evidence ∩ raw_event_archive_ku_ids` / `∪ output.findings[].evidence` | `output.findings` + `state.raw_event_archive` |
| **Thread 因果深度** | `(type=causal + type=temporal) 关系数 / 总关系数` | `output.event_threads[].relationships[].type` |
| **Thread 冗余度** | 同一 ku_id 出现在 ≥2 个 thread 的次数 | `output.event_threads[].thread_events[].ku_id` |

**ku_id 存证率 < 100% 视为代码 bug**——FINALIZE 路径（`loop.ts:1324-1387`）已强制过滤掉 archive 不存在的 ku_id，如果存证率 < 100% 说明 FINALIZE 校验逻辑被绕过，是 agent 代码问题，不是评测问题。

### 3.3 探索质量 - 召回层（需 ground truth，Recall 为主）

#### 指标定义

| 指标 | 定义 |
|------|------|
| **Recall_must** | `min_evidence 校验过的实质命中数 / must_find 总数` |
| **Recall_should** | 同上，分母换成 should_find |
| **Recall_nice** | 同上，分母换成 nice_to_find（可选） |
| **Thread Full Rate** | `full_match / known_threads 总数` |
| **Thread Full+Partial Rate** | `(full + partial) / known_threads 总数` |

#### Finding 匹配规则（方案 C：规则匹配 + 抽样人工裁决）

对每条 `known_finding`，遍历 `output.findings`，**命中需同时满足**：

1. 实体 Jaccard ≥ 0.5：`|gt.key_entities ∩ f.entities_involved| / |gt.key_entities ∪ f.entities_involved| ≥ 0.5`
2. category 相同
3. 关键词重叠 ≥ 0.6：`|gt_keywords ∩ f_keywords| / |min(gt_keywords, f_keywords)| ≥ 0.6`。**关键词 token 化规则（第一阶段固定）**：按标点和空格切分，中文段落额外切单字 bigram 兜底；不引入分词库。例如 "英伟达撤离中国" → `["英伟", "伟达", "达撤", "撤离", "离中", "中国"]`
4. `f.evidence.length ≥ gt.min_evidence`（实质命中校验）

**特殊处理**：
- 若 `gt.aliases` 非空（人工裁决回填过），先用 aliases 扩展匹配候选：agent finding 的 statement/entities 与任一 alias 匹配即算命中
- 规则未命中但**有近似候选**（实体 Jaccard ≥ 0.3 或 category 相同）→ 写入 `audit-pending.json` 等待人工裁决

#### Thread 匹配规则（有序子序列 + 因果方向）

对每条 `known_thread`，遍历 `output.event_threads`：

| 判定 | 条件 |
|------|------|
| **Full Match** | 所有 gt key_events 在 agent thread 中出现，**相对顺序一致**（gt key_events 的 ku_id 在 agent thread 的 thread_events 序列中作为子序列出现），因果方向一致。Agent 可多出中间事件 |
| **Partial Match** | ≥ 2/3 gt key_events 出现，且出现部分作为 agent thread 的子序列（顺序一致），方向一致 |
| **Mismatch** | 因果方向反转，或 < 2/3 覆盖，或 gt key_events 在 agent thread 中不是子序列（顺序颠倒） |

Agent thread 是 GT 的**超集**（多发现不算错）。**不用 Jaccard**——thread 是有序因果序列，不是集合。"顺序一致"严格定义为 **gt key_events 是 agent thread_events 的子序列**。

#### Recall 门限

`recall_must < 100%` → scorecard 顶部**高亮标红**，**但不阻断其他指标输出**。所有指标照常计算与展示，让读者看到完整画面。

#### known_false 的处理

`known_false` 命中（agent 产出的 finding 匹配某 false pattern）→ scorecard 高亮"触发了 N 条 known_false 模式"，**不计入 Recall 分母**。Precision 处理留待第二阶段。

---

## 四、架构

### 4.1 目录结构

```
eval/
├── golden/                              # 数据层（输入）
│   ├── scenarios.yaml
│   └── ground-truth/
│       ├── scenario-1-supply-chain.yaml
│       ├── scenario-2-competitive-landscape.yaml
│       ├── scenario-3-multi-hop.yaml
│       └── scenario-4-geopolitical.yaml
│
├── runs/                                # 每次 run 的产物（按 run-id 隔离）
│   └── <run-id>/                        # 格式：YYYYMMDD-HHMMSS-<git-short-sha>
│       ├── manifest.json
│       ├── scenario-1/
│       │   ├── raw-output.json          # ExplorationOutput
│       │   ├── raw-state.json           # serializeState(ExplorationState)
│       │   ├── metrics/
│       │   │   ├── efficiency.json
│       │   │   ├── quality-structural.json
│       │   │   └── quality-recall.json
│       │   └── audit-pending.json       # 待裁决项
│       └── ...
│
├── judgments/                           # 人工裁决累积（跨 run，按场景隔离）
│   ├── scenario-1-supply-chain/
│   │   └── worksheet.md                 # 当前裁决工作表（含历史裁决记录）
│   └── ...
│
├── runner/
│   └── run.ts                           # 单元 1：执行器
│
├── metrics/                             # 单元 2-4：三层指标
│   ├── lib/
│   │   ├── state-view.ts                # 隔离层：从 ExplorationState 提取扁平结构
│   │   └── match-rule.ts                # 规则匹配（自实现，不 import findings.ts）
│   ├── efficiency.ts                    # 探索效率
│   ├── quality-structural.ts            # 结构层
│   └── quality-recall.ts                # 召回层
│
├── report/                              # 单元 5：报告
│   ├── scorecard.ts                     # JSON + Markdown scorecard
│   └── worksheet.ts                     # 渲染 audit-worksheet.md
│
└── cli.ts                               # 入口：run / judge / report
```

### 4.2 五个单元的接口

| 单元 | 输入 | 输出 | 依赖 |
|------|------|------|------|
| **runner** | `ExplorationInput` | `{output: ExplorationOutput, state: ExplorationState}` | `src/agent/loop.ts:runExploration` |
| **efficiency** | `state + output` | `{useful_events_count, total_events_count}` | state-view |
| **quality-structural** | `state + output` | `{ku_id_provenance, thread_causal_depth, thread_redundancy}` | state-view |
| **quality-recall** | `output + ground_truth` | `{recall_must, recall_should, thread_full_rate, ...} + audit-pending` | match-rule |
| **report** | 上述所有 + manifest | `scorecard.{json,md}` + `judgments/<scenario>/worksheet.md` | 三层 metrics |

### 4.3 state-view 隔离层

所有 metrics 模块**只通过 state-view 提供的扁平结构**接触 ExplorationState，不直接读 `state.ts`。这是为了：

- `state.ts` 已发生过 v2→v3 演进，未来还可能变；变更时只改 state-view，不动 metrics
- 固化评测代码对 agent 内部数据结构的依赖边界

state-view 暴露的最小接口（从 ExplorationState + ExplorationOutput 提取）：

```typescript
interface StateView {
  raw_event_archive_ku_ids: string[];           // 分母来源
  thread_ku_ids: string[];                       // 分子来源（去重）
  findings_evidence_ku_ids: string[];            // ku_id 存证率来源
  thread_relationships: { type: "causal"|"temporal"|"entity_shared"|"contradiction" }[];  // 因果深度来源
  per_thread_ku_ids: string[][];                 // 冗余度来源（按 thread 分组）
  agent_findings: {                              // Recall 匹配的对象
    id: string;
    statement: string;
    category: string;
    confidence: string;
    entities_involved: string[];
    evidence: string[];
  }[];
  agent_threads: {                               // Thread 匹配的对象
    id: string;
    title: string;
    thread_event_ku_ids: string[];               // 有序
    relationships: { from_idx: number; to_idx: number; type: string }[];
  }[];
  reliability_note: string | null;               // 降级标注
}
```

---

## 五、执行流程

### 5.1 三条子命令

```
npx tsx eval/cli.ts run     [scenario] [--no-cache]              # 跑探索 + 算所有指标
npx tsx eval/cli.ts judge   [scenario] [--commit]                # 渲染/回填裁决工作表
npx tsx eval/cli.ts report  [scenario] [--run-id <id>] [--baseline <id>]  # 生成 scorecard
```

#### `run`（最重，调 LLM + MCP）

1. 生成 run-id：`<YYYYMMDD-HHMMSS>-<git-short-sha>`，跨机器不撞
2. 写 `manifest.json`（git sha、config hash、LLM model、KG endpoint、golden_set_sha、时间戳）
3. 读 `scenarios.yaml`，逐场景进程内调 `runExploration`
4. 存 `raw-output.json` + `raw-state.json`（用 `serializeState`）
5. 跑 efficiency / quality-structural / quality-recall
6. 输出 `audit-pending.json`
7. **不做人工裁决**——裁决是独立动作

缓存：默认跳过已有 `raw-output.json` 的场景，`--no-cache` 强制重跑。

#### `judge`（不调 LLM，只读 + 渲染/回填）

无 `--commit`：
1. 读最近 run 的 `audit-pending.json` + `raw-output.json`
2. 渲染 `eval/judgments/<scenario>/worksheet.md`（含历史裁决记录，追加模式）

有 `--commit`：
1. 解析 worksheet.md 里标注者的 verdict（YAML front-matter 部分）
2. 回填到 `eval/golden/ground-truth/<scenario>.yaml` 的 `aliases` 字段
3. 下次 `run` / `report` 时规则匹配自动认出 aliases

#### `report`（不调 LLM，只读 + 渲染）

1. 读指定 run-id（默认最近成功的 run）的所有 metrics
2. 应用最新 `aliases` 重算 recall
3. 若指定 `--baseline <run-id>`，对比两次 run，跨 run 字段不一致时按 §6.3 警告
4. 输出 `scorecard.{json,md}` 到 `eval/runs/<run-id>/`

### 5.2 worksheet 流程总览

```
1. run                           → 产出 audit-pending.json（含 verdict: unjudged 的待裁决项）
2. judge（无 --commit）          → 把 audit-pending.json 渲染成 worksheet.md（含 YAML front-matter）
3. 标注者编辑 worksheet.md       → 改 front-matter 里的 verdict（unjudged → match/no_match/partial）
4. judge --commit                → 解析 worksheet.md 的 front-matter，回填 aliases 到 ground-truth yaml
5. 下次 run / report             → 规则匹配自动认出 aliases
```

audit-pending.json 是 quality-recall 指标计算过程中的**副产物**——规则匹配时遇到"实体 Jaccard ≥ 0.3 或 category 相同但未达命中阈值"的近似项，就收集起来待裁决。它不是独立单元的输出，而是 quality-recall 顺手记录。

### 5.3 worksheet 格式（YAML front-matter + Markdown 表格）

```markdown
---
# 机器可解析部分（标注者改 verdict 字段）
verdicts:
  - gt_id: gt_f_1
    candidate_finding_id: finding_87eb
    verdict: unjudged     # unjudged / match / no_match / partial
  - gt_id: gt_f_2
    candidate_finding_id: null
    verdict: unjudged
---

# Annotation Worksheet — scenario-1-supply-chain（run 20260718-143052-a3f1c92）

## 待裁决项

### gt_f_1（must_find, pattern_violation）
GT statement: "..."
GT key_entities: [英伟达, 中国]
近似候选 finding_87eb（rule scores: jaccard=0.45, keyword=0.55，未达阈值）
- [ ] match   [ ] no_match   [ ] partial

### gt_f_2（must_find, absence）
GT statement: "..."
无近似候选（规则完全未命中）
- [ ] match   [ ] no_match   [ ] partial

## 历史裁决记录
（追加，每次 judge 不带 --commit 时显示）
```

---

## 六、失败处理与对比约束

### 6.1 评测代码对 src/ 的依赖边界

**只通过两个稳定入口**接触 agent：

| 入口 | 文件 | 用途 |
|------|------|------|
| `runExploration` | `src/agent/loop.ts:983` | 进程内执行探索 |
| `serializeState` | `src/agent/state.ts:362` | 落盘 ExplorationState |

**禁止**：
- 不 import agent 内部模块（findings.ts、tools.ts、loop.ts 内部函数）
- 不 monkey-patch agent 行为
- 不修改 src/ 下任何文件来"方便评测"——若发现某字段没暴露，单独提案，不混进评测 PR

### 6.2 LLM/MCP 失败行为

| 失败类型 | 评测行为 |
|---------|---------|
| `runExploration` 抛出（MCP 不可达、LLM 全失败） | `run_status: "failed"`，该场景所有指标输出 null，scorecard 标红，不参与跨场景统计 |
| Agent 内部降级（reliability_note 非空但 run 完成） | 正常算所有指标，scorecard 附带 reliability_note |
| 单个 metric 计算抛出 | 该 metric 输出 null + error message，不阻塞其他 metric，scorecard 标黄 |

### 6.3 跨 run 对比的最小约束

manifest.json 强制记录：`git_sha`、`config_hash`（不含 API key）、`llm_model`、`kg_endpoint`、`golden_set_sha`（golden/ 目录的 git sha）、`timestamp`。

`report --baseline` 对比时，字段不一致的警告级别：

| 字段 | 警告级别 |
|------|---------|
| `git_sha` | 黄色（代码变了，对比仅供参考） |
| `config_hash` | 红色（探索预算/MCP endpoint 变了，对比无意义） |
| `llm_model` | 黄色 |
| `kg_endpoint` | 红色（KG 换了，标答可能失效） |
| `golden_set_sha` | 红色（标答变了，recall 数字不可比） |

### 6.4 依赖约束

- **引入 js-yaml** 作为唯一新依赖（用于 golden set 存储与 worksheet 解析）
- 不引入测试框架（沿用项目"无 test runner，靠 typecheck"约定）
- 不引入 chart 库——曲线/可视化需要时输出 CSV 由人自己画
- 不引入其他依赖

---

## 七、Scorecard 输出格式

每次 `report` 生成 `scorecard.json`（机器读）+ `scorecard.md`（人读）。Markdown 示例：

```markdown
# Evaluation Scorecard — scenario-1-supply-chain

## 运行概要
| 项目 | 值 |
|------|----|
| Run ID | 20260718-143052-a3f1c92 |
| Steps | 9 |
| Visited Entities | 16 |
| Findings | 1 |
| Event Threads | 2 |
| Completion | sufficient |
| Reliability Note | （如有降级则显示） |

## 探索效率
| 项目 | 值 | 状态 |
|------|----|------|
| Useful Events | 8 |
| Total Events | 134 |
| Efficiency Ratio | 8/134 (6.0%) |

## 探索质量 - 结构层
| 指标 | 值 | 状态 |
|------|----|------|
| ku_id 存证率 | 5/5 (100%) | ✅ |
| Thread 因果深度 | 5/10 (50%) | ✅ |
| Thread 冗余度 | 0 | ✅ |

## 探索质量 - 召回层
| 指标 | 值 | 状态 |
|------|----|------|
| Recall_must | 1/2 (50%) | 🔴 高亮（不阻断） |
| Recall_should | 1/1 (100%) | ✅ |
| Recall_nice | 0/1 (0%) | — |
| Thread Full Rate | 1/1 (100%) | ✅ |
| Thread Full+Partial | 1/1 (100%) | ✅ |
| known_false 触发 | 0 | ✅ |

## 跨 run 对比（vs baseline 20260715-091200-b2e4a01）
（若 --baseline 指定，输出对比表 + 字段不一致警告）
```

---

## 八、实施切片（不在本 spec 详细展开，留给后续 plan）

按依赖顺序粗划，每片可独立交付：

1. **S1 — 骨架 + scenarios.yaml + 4 个空 ground-truth**：目录结构、cli 入口、manifest、runner 跑通一个场景存盘
2. **S2 — state-view + efficiency 指标**：第一个指标跑通端到端
3. **S3 — quality-structural 三个指标**：零标注指标全部跑通
4. **S4 — quality-recall + match-rule**：规则匹配跑通，输出 audit-pending.json
5. **S5 — judge + worksheet**：裁决工作表渲染与回填
6. **S6 — report + scorecard**：报告生成 + 跨 run 对比
7. **S7 — 4 个场景的 ground truth 实际标注**（人工活动，非代码）

S7 与 S1-S6 可并行：标注者可以在 S4 完成后就用 audit-pending.json + 自己的 KG 补查来填 ground truth。

---

## 九、未解决问题（留给后续阶段）

| 问题 | 处理 |
|------|------|
| Precision 标注（agent finding 的逐条正确性） | 第二阶段 |
| LLM-as-Judge 语义匹配 | 第二阶段评估是否需要 |
| 跨场景统计 / 移动平均 | 第二阶段（4 个场景统计力弱） |
| 基线对比（BFS / random / LLM-only） | 第三阶段 |
| KG 快照冻结 | 不做（接受线上 KG 漂移） |
| scorecard 可视化（曲线图） | 不做（输出 CSV 即可） |
