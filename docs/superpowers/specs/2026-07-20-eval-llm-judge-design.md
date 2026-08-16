# Eval Phase 1 增量设计 — Finding 匹配改用 LLM-as-Judge

> 状态: 已实现并合并（PR #5，2026-08-15）| 日期: 2026-07-20
>
> **性质**: 修订 `2026-07-18-eval-phase1-design.md` 的 §1.2 / §3.3 / §6.1 / §6.2 / §6.4。
> 不重写原 spec，只记录差异。冲突时以本文档为准。

---

## 一、为什么要改

原 spec §1.2 写：
> 不处理 LLM-as-Judge——避免引入 judge LLM 噪声，Recall 用规则匹配 + 人工裁决

这条决定在写 spec 时（2026-07-18）没真实数据支撑，纯靠推理。**真实数据跑完后这条站不住脚**：

### Rule matching 在中文 KG 上的 false negative 率高到让 recall 数字不可信

实测（4 个 scenario 的 audit-pending 数据）：
- 10 个 audit-pending 项中，**8 个**是 rule matching 因措辞不同漏判，而非 agent 真实盲点
- 典型 case：GT "权重股→板块情绪传导链" vs agent "大型科技股板块联动效应"——语义完全等价，规则算出 keyword_overlap=0.27 < 0.6 阈值
- 根因：中文 bigram token 化在两个语义等价但措辞不同的句子上重叠天然偏低

### "Judge LLM 噪声"的顾虑被高估了

原 spec 担心"judge LLM 心情变了，分不清 agent 变好还是 judge 偏移"。但工程上有标准对策：
- `temperature=0` + 固定 prompt → 单次判定接近确定性
- 结果缓存到磁盘 → 同一 (GT, agent) 对只调一次，跨 run 复用
- manifest 记录 judge 模型 → 跨 run 对比时检查一致性
- judge 模型版本变化才需要重判，不是每次 run 都变

**rule matching 的"确定性"反而是假象**——它确定地**判错**（语义等价的中文句子判成未命中）。

---

## 二、新架构：三层匹配

对每对 `(gt_finding, agent_finding)` 的判定流程：

```
                ┌─ Layer 0: Alias 缓存命中？ ──→ 是 → match（不调 LLM）
                │
(gt, agent) ────┤                              否
                │
                ├─ Layer 1: Rule pre-filter ───→ 不通过 → no_match（不调 LLM）
                │
                │                              通过
                │
                └─ Layer 2: LLM-as-Judge ─────→ match / partial / no_match
                                                  ↓
                                          match/partial → 写入 alias 缓存
```

### Layer 0 — Alias 缓存（不调 LLM）

**判定**：`gt.aliases` 非空且任一 alias 与 `f.statement` 的 keyword_overlap ≥ 0.5 → 直接 `match`。

**alias 是什么**：历史 LLM judge / 人工裁决认定的"语义等价 agent 表述"。第一次判过的对会自动回填 `f.statement` 到 `gt.aliases`，下次同类输入直接 Layer 0 命中。

**为什么有这层**：省钱。LLM 调用是按次计费的，alias 命中不调 LLM、跨 run 稳定。

**与 PR #4 Bug 2 修复的关系**：PR #4 把 alias 从 finding_id UUID 改成了 statement 文本，正是因为要为 LLM 缓存做铺垫。这条修复在新架构下意义更明确。

### Layer 1 — Rule pre-filter（不调 LLM，快速淘汰）

**判定**：同时满足以下 3 条才进入 Layer 2：
1. 实体 Jaccard ≥ 0.2（`|gt.key_entities ∩ f.entities_involved| / |gt.key_entities ∪ f.entities_involved|`）
2. `category` 相同，**或** 实体 Jaccard ≥ 0.5（防止"absence vs chain"的 category 误判——语义等价的 finding 可能因为视角不同被打不同 category）
3. `f.evidence.length ≥ gt.min_evidence`（实质命中校验，硬约束不可放宽）

任一不满足 → 直接 `no_match`。

**为什么有这层**：省钱 + 控制噪声。实体完全不重合的对（比如 GT 讲英伟达、agent 讲特斯拉）直接淘汰，没必要让 LLM 判。实测能筛掉 50-70% 的对。

**阈值的依据**：Jaccard 0.2 是宽松阈值——只淘汰"几乎完全不相关"的。原 spec 的 0.5 太严，把语义等价但实体表述不同的对也淘汰了。

### Layer 2 — LLM-as-Judge（语义判定）

**只对 pre-filter 通过的对调用**。

**Prompt（强制 GT-first 视角，缓解自评偏置）**：

```
你是一名严格的金融分析师评审。判断 Agent 的 finding 是否实质性回答了 GT 要求的结论。

【Ground Truth（本应发现什么）】
statement: {gt.statement}
category: {gt.category}
key_entities: {gt.key_entities}

【Agent Finding 候选】
statement: {f.statement}
category: {f.category}
entities_involved: {f.entities_involved}

判断标准：
- match: Agent 的 finding 实质性回答了 GT 的核心结论（措辞/细节/侧重不同可接受）
- partial: Agent 的 finding 方向对、与 GT 主题相关，但只覆盖了 GT 要求的一部分
- no_match: Agent 的 finding 答非所问、方向相反，或与 GT 完全不相关

注意：不要因为 Agent 的措辞不同于 GT 就判 no_match；关注核心结论是否被回答。
注意：你是 GT 的辩护人——你的任务是判断 Agent 有没有回答 GT 问的问题，而不是反过来。

只输出 JSON：{"verdict": "match|partial|no_match", "reason": "一句话理由"}
```

**调用参数**：
- `temperature: 0`（确定性解码）
- `max_tokens: 200`（输出短）
- `model`: 复用 `readConfig().llm.model`（与 agent 同模型，见 §五的自评偏置说明）

**解析失败处理**：JSON 解析失败 → 重试 1 次 → 仍失败 → 视为 `no_match` + 写入 `audit-pending.json`（标记 `judge_failed: true`）等人工裁决。

**Alias 自动回填**：LLM 判 `match` 或 `partial` 的对，把 `f.statement` 自动追加到 `gt.aliases`（持久化到 GT yaml）。下次同类输入走 Layer 0。

---

## 三、缓存设计

### 缓存目的

1. **省钱**：同一 (GT, agent) 对不重复调 LLM
2. **可复现**：缓存即"这次判定的证据"，可追溯
3. **跨 run 复用**：alias 机制已经处理，但缓存文件是更底层的备份

### 缓存存储

`eval/runs/<run-id>/<scenario>/llm-judge-calls.jsonl`，每行一次 LLM 调用：

```json
{"cache_key": "<hash>", "gt_id": "gt_f_3", "agent_finding_id": "finding_xxx", "gt_statement": "...", "agent_statement": "...", "category_match": true, "jaccard": 1.0, "verdict": "match", "reason": "...", "model": "deepseek-v4-pro", "timestamp": "2026-07-20T...", "tokens_used": 187}
```

### Cache key

`hash(gt.statement + "\n---\n" + f.statement + "\n---\n" + gt.category + "\n---\n" + f.category)`——基于内容，与 finding_id 无关，跨 run 稳定。

### Cache 复用规则

- 默认读：每次跑先读 cache，cache 命中（同 key）直接用，不调 LLM
- alias 优先：Layer 0 命中的不进 cache（已经从 GT yaml 读了）
- `--no-judge-cache` flag：强制全部重新调 LLM（debug 用）

### 跨 run 复用的边界

cache 文件存在每个 run 目录下，但**实际上跨 run 复用是通过 GT aliases 实现的**（Layer 0）：
- run A 的 LLM 判定 → 写 alias 到 GT yaml → run B 同类输入走 Layer 0
- cache 文件本身只对该 run 内的重跑有效（同一 run 内不会调两次 LLM 判同一对）

这样设计是为了避免跨 run 复用时的 cache 失效问题（KG 演变、prompt 改变等）。

---

## 四、模块结构

### 新增 `eval/metrics/lib/llm-judge.ts`

唯一调 LLM 的模块。

```typescript
export interface JudgeInput {
  gt_statement: string;
  gt_category: string;
  gt_key_entities: string[];
  agent_statement: string;
  agent_category: string;
  agent_entities: string[];
}

export interface JudgeResult {
  verdict: "match" | "partial" | "no_match";
  reason: string;
}

export interface JudgeCallRecord extends JudgeResult {
  cache_key: string;
  gt_id: string;
  agent_finding_id: string;
  model: string;
  timestamp: string;
  tokens_used: number;
}

// 调 LLM judge（带重试 + JSON 解析）
export async function judgeFindingPair(input: JudgeInput): Promise<JudgeResult>;

// 把判定结果追加到 cache 文件
export function appendJudgeCall(scenarioDir: string, record: JudgeCallRecord): void;
```

**依赖**：
- `src/llm/client.js` 的 `createLlmClient()`（复用，新稳定入口点）
- `src/agent/config.js` 的 `readConfig()`（拿 model 名）

### 改造 `eval/metrics/lib/match-rule.ts`

`matchFinding` 改为 async + 三层架构：

```typescript
export interface MatchContext {
  scenarioDir: string;       // cache 文件路径
  useLlmJudge: boolean;      // false = 只用 rule pre-filter（兼容旧模式）
  noJudgeCache: boolean;     // true = 强制重调 LLM
}

export async function matchFinding(
  gt: KnownFinding,
  agentFindings: AgentFindingView[],
  ctx: MatchContext,
): Promise<FindingMatchResult>;
```

**保留的导出**（给 audit-pending / 其他模块用）：`tokenize`、`entityJaccard`、`keywordOverlap`、`isApproximateCandidate`、`matchThread`、`subsequenceCoverage`。

**移除**：原来的"alias 是 finding_id"特例逻辑（PR #4 commit 91c1480 加的，后来 fbcb511 改了，现在彻底重构）。

### 改造 `eval/metrics/quality-recall.ts`

`computeRecall` 改为 async：

```typescript
export async function computeRecall(input: RecallComputeInput): Promise<RecallComputeOutput>;
```

调用方（`cli.ts recall` 子命令、`runScenario` 里的 metric 计算）都要 await。

### CLI flag

- `recall` 子命令加 `--no-llm-judge`（仅用 rule pre-filter，等价于今天的 rule matching 模式，用于对比/调试）
- `recall` 子命令加 `--no-judge-cache`（强制重调 LLM）
- `run` 子命令默认开启 LLM judge

---

## 五、自评偏置的应对

### 问题

judge 用 deepseek-v4-pro，agent 也用 deepseek-v4-pro。模型对"自己的输出风格"有偏好——它生成的 finding 倾向于某种句式/视角，judge 时也容易认同这种句式，**recall 可能系统性偏高**。

### 应对（写进实现）

1. **Prompt 强制 GT-first 视角**（见 §二的 prompt）：让 LLM 站在"GT 辩护人"角度判断"agent 有没有回答 GT 问的问题"，而不是反过来。这能部分缓解"judge 偏袒 agent 输出"。
2. **要求 LLM 给出 reason**：所有判定都带一句话理由，便于人工抽查异常 case（比如 scorecard 显示 recall 突然飙高时，可以看 cache 文件查 LLM 的理由是否合理）。
3. **manifest + scorecard 显式标注**：
   - `RunManifest` 加 `judge_model: string` 字段
   - scorecard 顶部加注：`⚠️ judge model 与 agent model 相同（{model}），存在自评偏置可能`
4. **保留升级入口**：未来想换成 GPT-4/Claude 当 judge 时，只需改 `llm-judge.ts` 里读取 model 的逻辑（或加 config 字段 `eval.judge_model`），不改架构。

### 不做的事

- **不引入第二个 LLM 模型**（比如同时跑 GPT-4 + deepseek 交叉验证）：成本太高，第一阶段不需要
- **不做多数表决**（多次调用取众数）：temperature=0 时多次调用结果稳定，没必要

---

## 六、对原 spec 的修订条目

### §1.2 "本阶段不测什么"修订

**删除**：
> 不处理 LLM-as-Judge——避免引入 judge LLM 噪声，Recall 用规则匹配 + 人工裁决

**替换为**：
> Finding 的语义等价判定采用 LLM-as-Judge（复用 deepseek-v4-pro，温度 0），rule matching 降级为 pre-filter。Thread 匹配仍用 ku_id 子序列（thread 是结构化因果链，rule 合适）。Precision 标注（agent finding 措辞/置信度准确性）仍留待第二阶段。

### §3.3 "Finding 匹配规则"修订

**整段替换**为本文档 §二的三层架构描述。

**Thread 匹配规则**保留不变（ku_id 子序列）。
**Recall 门限**保留不变（must < 100% 高亮不阻断）。
**known_false 处理**保留不变。

### §6.1 "评测代码对 src/ 的依赖边界"修订

**原 2 个稳定入口**改为 **3 个**：

| 入口 | 文件 | 用途 |
|------|------|------|
| `runExploration` | `src/agent/loop.ts` | 进程内执行探索 |
| `serializeState` | `src/agent/state.ts` | 落盘 ExplorationState |
| **`createLlmClient`** | **`src/llm/client.ts`** | **LLM-as-Judge 调用** |

### §6.2 "LLM/MCP 失败行为"修订

新增一行：

| 失败类型 | 评测行为 |
|---------|---------|
| **LLM judge 调用失败**（网络/超时/JSON 解析失败） | 重试 1 次 → 仍失败 → 该对判 `no_match` + 写入 audit-pending（标记 `judge_failed: true`）。不阻塞其他对的判定 |

### §6.4 "依赖约束"修订

不引入新依赖——LLM judge 复用现有 `src/llm/client.ts`（已在 src/ 里）+ `deepseek-v4-pro`（已在 config 里）。

### §4.1 "目录结构"修订

新增：

```
eval/metrics/lib/
├── state-view.ts
├── match-rule.ts      (重构：三层架构)
└── llm-judge.ts       (新增)
```

### RunManifest 修订

新增字段：

```typescript
export interface RunManifest {
  // 原有字段...
  judge_model: string;       // 新增：LLM judge 用的模型名
}
```

### Scorecard 修订

运行概要顶部新增一行（仅当 judge_model 与 agent model 相同时）：

```
| ⚠️ Self-evaluation bias | judge model 与 agent 同（{model}），recall 可能系统性偏高 |
```

---

## 七、实施切片

| 步骤 | 内容 | 验证 |
|------|------|------|
| S1 | 实现 `llm-judge.ts`（prompt + 调用 + 重试 + JSON 解析） | 手工调一次，看 verdict 是否合理 |
| S2 | 重构 `match-rule.ts` 为三层架构，保留 `--no-llm-judge` flag 兼容旧模式 | 旧模式下 recall 数字与今天完全一致 |
| S3 | 改 `quality-recall.ts` + `cli.ts` + `runScenario` 为 async | typecheck 通过 |
| S4 | 更新 RunManifest + scorecard（judge_model + 偏置提示） | manifest 字段写入正确 |
| S5 | 重算 4 scenario recall，对比 rule matching 版本 | 对比表，看 LLM judge 是否解决了 8 个漏判 |
| S6 | 重新走 judgment pass（如果 LLM judge 仍漏判的话） | audit-pending 应大幅减少 |

每步独立 commit。S5 是关键验证点——如果 LLM judge 跟人工裁决吻合度高（10 个里 ≥8 个一致），证明架构对；如果吻合度低，需要调 prompt 或换模型。
