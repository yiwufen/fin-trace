# Graph Exploration Agent — 设计文档

## 项目元信息
- 日期: 2026-06-01
- 修改日期: 2026-06-02（v2: 霍尔木兹海峡模拟 → State 模型重构）
- 状态: 全部核心设计完成（含 Agent Card 集成协议）

---

## 一、定位与架构

| 层面 | 决策 |
|------|------|
| 定位 | 平等 Agent，多 Agent 系统里的图探索专家 |
| 架构 | 独立 TypeScript 项目，通过 MCP 协议调已有 KG 服务 |
| 实现方式 | 从零手写 Agent Loop，Claude Code 源码仅作架构参考 |
| MCP 服务 | knowledge-graph MCP（search_knowledge + expand_graph_detail），Agent 可直接调用 |
| OpenClaw 集成 | 独立 TS 进程 + MCP server，主 Agent 通过 function call 调用（重型工具模式） |

---

## 二、输入输出

### 输入
结构化 Goal + 边界条件：
- `seed_entities`: 起始实体（中文名）
- `max_depth`: 最大探索深度（默认 3）
- `relation_filters`: 关系类型过滤（可选）
- `direction`: 探索方向（可选）

### 输出三层
1. **Findings**: 认知产出（不是数据搬运，是从探索中提取的洞察）
2. **Event Threads**: 事件发展脉络（事件间有 causal/temporal/entity_shared/contradiction 关系）
3. **Exploration Meta**: completion_reason + stats + exploration_log + reliability_note

---

## 三、Agent 循环（含 Phase 状态机）

```
┌──────────────────────────────────────────────┐
│                 Agent Loop                     │
│                                                │
│  ┌──────────┐    termination      ┌──────────┐│
│  │ EXPLORING │ ──────────────────→ │ FINALIZE ││
│  │           │   detected by code  │          ││
│  │ Think:    │                     │ Think:   ││
│  │  decision │                     │  build   ││
│  │  +tools   │                     │  threads ││
│  │ Act: MCP  │                     │ Act:     ││
│  │  calls    │                     │  data    ││
│  │ Observe:  │                     │  assembly││
│  │  update   │                     │ Observe: ││
│  │  state    │                     │  validate││
│  └──────────┘                     └──────────┘│
│                                       │         │
│                                       ▼         │
│                                    done=true    │
└──────────────────────────────────────────────┘
```

**FINALIZE 在循环内部**，和 EXPLORING 共用同一消息历史，上下文自然继承。

### 进入 FINALIZE 的触发条件（代码判断）
1. LLM 决策 = `sufficient`（代码验证 visited 覆盖度）
2. `diminishing_returns`（连续 N 步无新 finding 且 decision 重复）
3. `token_budget` ≥ 90%
4. `frontier_empty`（过滤后为空）
5. `depth_exhausted`（达到 max_steps）

---

## 四、状态变量（ExplorationState）

### State 模型

```typescript
ExplorationState {
  // 导航层（代码维护）
  visited:        Set<string>           // 已访问实体（代码写入，代码拦截）
  frontier:       {entity, reason}[]    // 待探索实体，max 10，LLM Think 维护 + 代码审核

  // 质量标记层（代码注入 + 代码保障）
  entity_flags:   Map<entity_id, {      // 实体质量标记，代码层跨轮保障
    unreliable_mapping: boolean,        // 实体消歧失败？（如"伊朗"→"伊朗队"）
    noise_ratio?: number,               // 噪声比例
    note: string
  }>
  cluster_flags:  Map<clu_id, {         // 集群质量标记，随数据绑定注入
    conflict_type: string,              // numerical | temporal | source
    severity: "low" | "medium" | "high",
    note: string
  }>

  // 认知产出层（LLM Think 维护，跨轮累积）
  key_insights:   Insight[]             // 跨轮合成性洞察（contradiction/chain/concentration/absence）

  // 审计与归档层
  exploration_log:      string[]         // 每轮一行摘要
  raw_event_archive:    Map<clu_id, ClusterDetail>  // 已拉取的集群 raw 数据（FINALIZE 注入）

  // 预算
  budget: { max_depth, max_steps, max_tokens, used_tokens }
}
```

**Goal 不在 State**，存在于 messages 首条作为固定引用。

### 各字段的注入时机与保障层级

| 字段 | 谁写 | 谁读 | 注入时机 | 保障层级 |
|------|------|------|---------|---------|
| `visited` | 代码（Observe）| 代码 | 每轮 Observe 后更新 | 硬拦截 |
| `frontier` | LLM Think 提议 + 代码审核 | LLM Think | 每轮 Think 后更新 | 软约束（代码校验准入）|
| `entity_flags` | 代码（从 LLM new_findings 提取）| 代码 | tool call 之前拼入 Prompt | 硬保障 |
| `cluster_flags` | 代码（从 LLM new_findings 提取）| LLM Think | 随集群数据附加 | 数据绑定 |
| `key_insights` | LLM Think | LLM Think | 每轮上下文注入 | LLM 自由消费 |
| `exploration_log` | 代码 | LLM（FINALIZE）| FINALIZE 注入 | 可压缩 |
| `raw_event_archive` | 代码（Observe）| LLM（FINALIZE）| FINALIZE 注入 | 不压缩 |

### 与 v1 的关键变化

| v1 字段 | v2 变化 | 原因 |
|---------|--------|------|
| `event_buffer(max50)` | **删除** → `raw_event_archive`（无上限） | raw 不进 EXPLORING 上下文，只在 FINALIZE 注入 |
| `key_findings` | **拆为** `entity_flags` + `cluster_flags` + `key_insights` | 三种消费者、三种注入时机、三种保障层级 |
| `frontier` (带优先级) | 改为 `frontier` (带 reason，max 10) | LLM Think 自带判断力，不需要代码层排序；需要准入控制 |
| `exploration_log` | 从 LogEntry[] 改为 string[] | 每轮一行摘要，压缩极简 |
| `paths` | **删除** | 路径信息沉淀在 key_insights 中，不需要独立存储 |

---

## 五、上下文组装

### 核心原则

EXPLORING 和 FINALIZE 是两个认知模式，上下文输入不同。

**EXPLORING 轮次不注入历史 raw 数据。** 每轮的 raw 只在当轮被 LLM 消费并抽象为 `key_insights` / `entity_flags` / `cluster_flags`。下一轮只需要抽象产物，不需要重看 raw。

类比：翻书每页读完留下的是理解，不是原文。需要写梗概时（FINALIZE）回头翻书（`raw_event_archive`）。

### EXPLORING 轮次上下文

```
Phase Label + Goal（不变引用）

State Navigators:
  visited entities (去重用)
  frontier {entity, reason} (≤10，LLM Think 可从中选择)

State Quality:
  entity_flags (⚠️ 以下实体存在质量标记: ...)
  cluster_flags (随 cluster 数据附加 conflict 标注)

State Abstractions:
  key_insights (累积，LLM Think 自由消费)

Current Round:
  本轮 MCP 返回的 raw 数据  ← 唯一的 raw 来源

Budget:
  steps / tokens / depth 使用情况
```

**不注入**：之前轮的 raw 数据（已被消化）、raw_event_archive（FINALIZE 专用）。

### FINALIZE 轮次上下文

```
Phase Label + Goal

key_insights（全量，结构化的认知沉淀）
raw_event_archive（全量，回头查 KU 内容、时间戳、实体）
exploration_log（全量，审计轨迹）
entity_flags + cluster_flags（参考质量标记）
Budget: FINALIZE 专用 token 预算
```

FINALIZE 只发生一次，上下文可以大——`raw_event_archive` 无上限注入。

---

## 六、搜索策略（EXPLORING 阶段）

| 策略 | 语义 | 触发 |
|------|------|------|
| Expand | "扫一圈看有什么" | 探索初期 |
| Deep Dive | "这个有意思，追下去" | 发现高价值信号 |
| Verify | "我猜 X，验证一下" | 已形成初步模式 |

LLM 建议 + 代码审核，每步可切换。"犹豫够不够=不够，继续。"

事件内省：代码排时序 → LLM 判断发展链 → new_findings（insight/entity_flag/cluster_flag）→ 外部实体入 frontier。

---

## 七、工具系统（缺口 1）

5 个语义化工具，映射到 MCP：

| 工具 | MCP 映射 | 语义 |
|------|---------|------|
| `lookup` | search_knowledge(ENTITY_OVERVIEW) | 查实体信息和事件 |
| `trace` | search_knowledge(RELATIONSHIP_QUERY, hops=2) | 追两实体关系路径 |
| `timeline` | search_knowledge(ENTITY_TIMELINE) | 拉事件时间线 |
| `expand` | expand_graph_detail(cluster_ids) | 展开事件聚类 |
| `scan` | search_knowledge(EVENT_ANALYSIS) | 批量筛选事件 |

**关键决策：hops=1**，深度控制由 Agent Loop 做。

---

## 八、System Prompt（缺口 2）

七层 + FINALIZE 段，~3000 tokens。

| Layer | 内容 | Token |
|-------|------|:----:|
| 1. 身份与边界 | Graph Explorer Agent，知识来源只有图谱 | ~200 |
| 2. 工具说明 | 5 个工具，什么语义→什么时候用→输入 | ~500 |
| 3. 决策框架 | reasoning + decision(5值) + tool_calls + new_findings(insight/entity_flag/cluster_flag) | ~600 |
| 3a. State 字段说明 | entity_flags / cluster_flags / key_insights 的语义和关系 | ~300 |
| 3+. FINALIZE | threads + final_findings，Thread 构建要求（含 raw_event_archive 使用说明） | ~500 |
| 4. 策略指导 | 三种策略 + 切换 + "犹豫够不够=不够" | ~400 |
| 5. 输出格式 | 并行/串行，max 4 工具/次 | ~200 |
| 6. 硬约束 | 6 条不可违反规则 | ~200 |

**新增 Layer 3a: State 字段说明** — 告诉 LLM `entity_flags` 是代码层保障的质量标记（不要覆盖）、`cluster_flags` 是跟着数据来的冲突标注（自然看到即可）、`key_insights` 是 LLM 自由维护的认知沉淀。

---

## 九、认知产物：三层架构（缺口 3 修正）

### 为什么拆为三层

原 `key_findings` 是扁平数组，什么东西都往里扔。但不同消费者需要不同的注入时机和保障层级：

- **代码需要保障的**（如实体消歧失败标记）→ 应该代码层注入 Prompt，不是让 LLM 去 findings 里找
- **随数据一起看的**（如集群冲突标记）→ 应该在数据返回时附加，不需要单独记
- **LLM 自由消费的**（如跨轮合成洞察）→ 应该注入上下文，LLM 自己判断如何使用

### 第一层：entity_flags（基础设施告警，代码保障层）

**消费者：代码。** 在每轮 tool call 之前注入 Prompt。

产生方式：LLM Think 的 `new_findings` 中标记 `type: entity_flag` → 代码提取写入 `entity_flags`。

```typescript
entity_flags: Map<entity_id, {
  unreliable_mapping: boolean,   // false positive: LLM spotting entity resolution error
  noise_ratio?: number,           // e.g. 0.15 = 15% of KUs for this entity are sports noise
  note: string                    // "KG maps 伊朗 → 伊朗队(football team)"
}>
```

注入方式：代码拼 Prompt 时在工具调用说明前插入：

```
⚠️ Entity Quality Flags (do NOT override these, they are code-verified):
- ent_0b989c89ea55 (伊朗队): UNRELIABLE — entity resolution maps nation to football team, 
  ~15% of returned KUs are sports noise. Use entity name "伊朗伊斯兰革命卫队" for 
  military queries or "伊朗政府" for political queries instead.
```

**不是 insight，是基础设施告警。** 和工具超时进异常处理一样——代码保障层的事。

### 第二层：cluster_flags（数据质量标记，数据绑定层）

**消费者：LLM Think。** 随集群数据一起返回给 LLM。

产生方式：LLM Think 在 `new_findings` 中标记 `type: cluster_flag` → 代码提取写入 `cluster_flags`。

```typescript
cluster_flags: Map<clu_id, {
  conflict_type: "numerical" | "temporal" | "source" | "mixed",
  severity: "low" | "medium" | "high",
  note: string  // "过船数量在不同来源相矛盾: 24/25/28/33艘"
}>
```

注入方式：集群数据返回时直接附加 conflict badge：

```
Cluster clu_3248a46a448a [⚠️ HIGH DATA CONFLICT: conflicting ship counts across sources]
  - 6 KUs, 4 sources, confidence 0.9
  - Source A (5/23): 33 ships
  - Source B (5/26): 25 ships
  - Source C (5/29): 24 ships
  - Source D (5/31): 28 ships
```

**LLM 看 cluster 时自然看到，不需要在 key_insights 里单独翻。**

### 第三层：key_insights（跨轮认知沉淀，LLM 认知层）

**消费者：LLM Think。** 每轮 Think 上下文注入。这才是原来 "key_findings" 的核心语义，但命名收紧为 "insights"，强调 **跨轮合成性**而非单点观察。

四种类型保持：`pattern_violation` / `concentration` / `chain` / `absence`

结构: id + category + statement + confidence + evidence(ku_ids) + entities_involved + relation_to_goal + discovered_at_step

提取时机: LLM Think 每轮的 `new_findings: insight[]`。代码不单独调 LLM。

去重: 相同实体+相近→合并；矛盾→双保留+conflict 标记。

**如果 key_insights 体积超过阈值 → 触发 FINALIZE，不是压缩。** 产品本身大到要压缩才能继续生产 = 该交货了。

### 示例（来自霍尔木兹海峡模拟）

R2 Observed → Think produced:

```yaml
new_findings:
  - type: entity_flag
    entity: ent_0b989c89ea55
    unreliable_mapping: true
    note: "伊朗 mapped to 伊朗队(football team); ~15% KUs are sports noise"

  - type: cluster_flag
    cluster: clu_3248a46a448a
    conflict_type: numerical
    severity: high
    note: "Ship passage counts differ: 24/25/28/33 across 4 sources"

  - type: insight
    category: chain
    statement: "US airstrike on Qeshm Island is a turning point — MQ-1 shootdown → airstrike → Iranian retaliation"
    evidence: [ku_842c, ku_9cfb]
    confidence: 0.85
```

---

## 十、Event Thread 构建（FINALIZE 阶段，循环内）

数据结构: title + summary + narrative + thread_events[](ku_id 可溯源) + relationships[](4种类型 + reasoning) + time_span + confidence + source_finding_ids

关系类型: `causal` / `temporal` / `entity_shared` / `contradiction`

流程: Think(LLM 输出 threads + final_findings) → Act(代码组装) → Observe(校验 ku_id/时间线/关系类型，失败→LLM 修正1次→仍失败→丢弃) → done

质量红线: 每事件 ku_id、每关系 reasoning、≥3 事件、事件 ku_id 在 raw_event_archive 中可查。

---

## 十一、异常处理（缺口 4）

四类恢复: Retry / Fallback / Skip / Abort

**MCP 异常**: 超时→Fallback 映射（trace 超时→lookup 各自查；timeline 超时→缩短范围）；空结果→改名重试 ≤1 次；服务错误→3 级降级

**LLM 异常**: 格式错误→修复+重试；幻觉→校验+钳制；决策循环→强制切换

**状态异常**: frontier 质量→add 时检查；token→80/90/95/100% 四级；步数→强制 FINALIZE(+2 步)

**FINALIZE 兜底**: 不做新 MCP 调用。异常记入 exploration_log → 输出 reliability_note。

---

## 十一-B、上下文溢出处理（v2 简化）

### 设计原则

v1 设计了 Active State + Compressed Log 二段结构，假设 State 会膨胀到需要分层。模拟验证后发现：

1. **State 体积天然小** — 去掉 event_buffer 后，跨轮累积的只有 `entity_flags`（极慢增长）、`cluster_flags`（线性，但体积小）、`key_insights`（5-10 条/轮，合理）
2. **raw 只在当前轮** — 历史 raw 已归档到 `raw_event_archive`，不进 EXPLORING 上下文
3. **唯一可压缩的是 `exploration_log`** — 每轮一行摘要，语义就是可压缩的

### 处理顺序

```
上下文预算超 85% 时：
  1. exploration_log → 摘要化（1 句/轮 → 合并类似轮次）
  2. 还超？→ 触发 early FINALIZE
```

**不压缩 key_insights** — 如果 key_insights 本身大到装不下，说明探索已经足够丰富，应该直接交货，不是压缩后继续探索。

**不压缩 entity_flags / cluster_flags** — 体积可忽略，且压缩 = 丢失质量保障信息。

---

## 十二、竞品调研摘要

| 维度 | GraphRAG (微软) | LightRAG (港大) | KAG (浙大/蚂蚁) |
|------|------|------|------|
| 定位 | 复杂推理+全局洞察 | 轻量高效 | 多跳推理+领域增强 |
| 效率 | 慢 | 快（+99.98%） | 中等 |
| 推理 | 依赖 GPT-4 | 轻量模型 | 多步推理引擎 |
| 场景 | 医疗/法律/科研 | 移动/边缘/实时 | 垂直领域（>93%） |

关键发现: 传统向量 RAG 多跳准确率 ~50%，GraphRAG 可达 85%。微软 DRIFT: 向量搜索→社区拆解→KG 上游走。

---

## 十二-B、KG Agent 式图探索竞品深度分析

> GraphRAG / LightRAG / KAG 本身是 RAG 检索增强框架，不包含 Agent 式图探索能力。
> 真正在 KG 上做 Agent 式自主搜索分析的方案参见独立竞品分析文档。

**详细分析**: [`graph-agent-competitor-analysis-2026-06-01.md`](graph-agent-competitor-analysis-2026-06-01.md)

**核心结论**: 发现 5 个 KG Agent 方案（KG-Agent / GraphRAG-R1 / INRAExplorer / SciAgents / Agentic Deep Graph），分属 RL 训练型、Multi-Agent 协作型、图构建型。**无与本设计完全相同的组合**：代码级 Phase 状态机 + 金融事件语义化工具 + Event Thread 构建。

---

## 十三、多 Agent 交互协议 — Agent Card

### 本质区别：Graph Explorer ≠ OpenClaw Agent

**Graph Explorer 不是跑在 OpenClaw 框架里的 Agent。** 它有自己的 Agent Loop，不能交给 OpenClaw 的内置 ReAct 循环。

| 维度 | OpenClaw Agent | Graph Explorer Agent |
|------|---------------|---------------------|
| **运行时** | OpenClaw 框架内 | **独立 TS 进程** |
| **Loop** | 平台内置 ReAct，你管不了 | **代码显式 while，完全自控** |
| **Phase** | 无 phase 概念 | EXPLORING→FINALIZE，代码检测切换 |
| **终止** | LLM 自己说停 + 平台超时 | **代码判断** 5 种条件，不看 LLM 心情 |
| **State** | 对话历史，无显式 state | ExplorationState，代码可读可写 |
| **工具审计** | LLM 自由决定 | 每步代码审核：decision 合法？hops=1？ |
| **输出校验** | 无 | FINALIZE 代码验证：ku_id 存在性、时间线一致性 |

如果把 Graph Explorer 当 OpenClaw sub-agent 跑 → System Prompt 被 LLM 当建议忽略、Phase 切换不存在、代码级终止失控 → **核心设计全丢了**。

### 正确集成：独立进程 + MCP 暴露 = 重型工具

```
┌─────────────────────────────────────────────┐
│  OpenClaw（主 Agent，ua58rsb93veqtxl7）      │
│                                             │
│  收到: "分析制裁对宁德时代供应链的影响"        │
│                                             │
│  function call: graph_explore({             │
│    goal: "追踪美国制裁...",                  │
│    seed_entities: ["宁德时代"],              │
│    max_depth: 3                             │
│  })                                         │
│     │                                       │
│     │  等待 30-120s                         │
│     ▼                                       │
│  返回: findings + event_threads + meta      │
│     │                                       │
│     ▼                                       │
│  读 findings → 组织自然语言回答               │
└──────────────────────┬──────────────────────┘
                       │ MCP / function call
                       ▼
┌──────────────────────────────────────────────┐
│  Graph Explorer 服务（独立 TypeScript 进程）   │
│                                              │
│  ┌─ 自定义 Agent Loop ───────────────────┐   │
│  │ EXPLORING: Think → Act(MCP) → Observe │   │
│  │   ↓ code 检测终止条件                  │   │
│  │ FINALIZE: Think → Act(assembly) →     │   │
│  │            Observe(validate) → done    │   │
│  └───────────────────────────────────────┘   │
│         ↕ MCP                                │
│  ┌─────────────┐                             │
│  │ knowledge   │                             │
│  │ graph MCP   │                             │
│  └─────────────┘                             │
└──────────────────────────────────────────────┘
```

**Graph Explorer 对主 Agent 来说就是一个重型工具**——调用方式跟 `search_knowledge` 一样，区别是内部跑了一整个 Agent Loop 而不只是一次查询。

### 接口契约：MCP Tool Definition

Agent Card 不需要额外文档或 Prompt 注入——**MCP tool definition 本身就是自描述的 Agent Card**。主 Agent 的 LLM 收到工具列表时，根据 description 和 inputSchema 自然判断何时调用 graph_explore，和选 search_knowledge 的逻辑完全一样。

```typescript
// 这就是运行时唯一的接口契约。LLM 读 description 就知道:
// 做什么、什么时候用、返回什么、等多久、可靠性如何
{
  name: "graph_explore",
  description: `在金融知识图谱上执行多跳关系推理和路径发现。

输入探索目标(goal)和起始实体(seed_entities)，Agent 自动进行多跳探索，返回三层输出:
1. findings — 关键发现（离散认知产出，标注置信度和证据）
2. event_threads — 事件发展脉络（causal/temporal/entity_shared/contradiction）
3. exploration_meta — 完成原因 + 统计 + 可靠性说明

适合: 多跳关系推理、供应链风险追踪、传导路径分析、"X对Y的影响链路"
不适合: 单实体事实查询（用 search_knowledge）、统计汇总、文档搜索

延迟: 通常30s，最长120s。
可靠性: findings 有 evidence(KU ID) 可溯源。不保证无幻觉，trust but verify。
无数据时返回空 findings。`,

  inputSchema: {
    type: "object",
    properties: {
      goal:           { type: "string", description: "自然语言探索目标" },
      seed_entities:  { type: "array", items: { type: "string" }, description: "起始实体中文名" },
      max_depth:      { type: "number", default: 3 },
      relation_filters: { type: "array", items: { type: "string" } },
    },
    required: ["goal", "seed_entities"]
  }
}
```

调用后内部启动 Agent Loop（EXPLORING→FINALIZE），循环结束返回结构化输出。对外和 `search_knowledge` 调用方式完全一致，区别只在时延和返回内容。

### 辅助文档：Agent Card（人读，非运行时注入）

```yaml
agent_id: graph-explorer-v1
display_name: 图探索专家
description: >
  在金融知识图谱上执行多跳关系推理和路径发现的专用 Agent。
  独立进程，通过 MCP 暴露为重型工具。内部运行自定义 Agent Loop
  （EXPLORING → FINALIZE），不依赖任何 Agent 框架的编排层。

runtime: independent_process_with_custom_loop
integration: mcp_tool  # 主 Agent 通过 function call 调用

capabilities:
  primary:
    - multi-hop relationship reasoning
    - entity path discovery
    - event chain tracing
    - supply chain risk propagation analysis

input:
  goal: string (required)
  seed_entities: string[] (required)
  max_depth: number (default: 3)
  relation_filters: string[] (optional)
  timeout_ms: number (default: 120000)

output:
  findings:      Finding[]        # statement + confidence + evidence(KU ID) + relation_to_goal
  event_threads: EventThread[]    # title + summary + narrative + events + relationships
  exploration_meta: ExplorationMeta  # completion_reason + stats + reliability_note

behavior:
  knowledge_source: knowledge_graph_only
  guarantees_evidence_trace: true
  guarantees_no_hallucination: false
  max_latency_ms: 120000
  typical_latency_ms: 30000

error_contract:
  no_data:        { findings: [], threads: [], reason: "no_data" }
  insufficient:   { findings: [...] threads: [], reason: "insufficient_for_threading" }
  degraded:       { findings: [...], reliability_note: "mcp_degraded_at_step_N" }
  timeout:        { findings: [], threads: [], reason: "timeout" }

examples:
  good:
    - "调查美国出口管制对华为供应链的传导效应"
    - "宁德时代和比亚迪的供应商重叠情况"
  bad:
    - "宁德时代是哪年成立的"
    - "2024年新能源汽车行业财报汇总"
```

### 对比汇总

| | 普通 MCP 工具 | Graph Explorer Agent |
|---|---|---|
| 内部逻辑 | 单次查询 → 返回数据 | **完整 Agent Loop** → EXPLORING → FINALIZE |
| Loop 控制 | 无 | **自定义 Phase 状态机**，代码控制 |
| 调用方式 | function call | function call（对外一样） |
| 返回 | 原始数据(KU、聚类) | 结构化分析(findings、threads) |
| 时延 | ~1s | ~30-120s |
| 失败处理 | 错误码 | 降级策略 + reliability_note |
| 适合 | 单次查询、简单检索 | 多跳推理、供应链追踪、传导分析 |

