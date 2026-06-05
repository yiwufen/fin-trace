# Agent Card — 接口契约

## 核心原则

Agent Card 不需要额外文档或 Prompt 注入。**MCP tool definition 本身就是自描述的 Agent Card。** 主 Agent 的 LLM 收到工具列表时，根据 description 和 inputSchema 自然判断何时调用 graph_explore——和选 search_knowledge 的逻辑完全一样。

---

## 运行时接口（MCP tool definition）

```typescript
{
  name: "graph_explore",
  description: `在金融知识图谱上执行多跳关系推理和路径发现。

输入探索目标(goal)和起始实体(seed_entities)，Agent 自动进行多跳探索，返回三层输出:
1. findings — 关键发现（离散认知产出，标注置信度和证据）
2. event_threads — 事件发展脉络（causal/temporal/entity_shared/contradiction 关系）
3. exploration_meta — 完成原因 + 统计 + 可靠性说明

适合: 多跳关系推理、供应链风险追踪、传导路径分析、"X对Y的影响链路"
不适合: 单实体事实查询（用 search_knowledge）、统计汇总、文档搜索

延迟: 通常30s，最长120s。
可靠性: findings 有 evidence(KU ID) 可溯源。不保证无幻觉，trust but verify。
无数据时返回空 findings。`,

  inputSchema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "自然语言探索目标，如'追踪美国制裁对宁德时代欧洲供应链的影响'"
      },
      seed_entities: {
        type: "array",
        items: { type: "string" },
        description: "起始实体中文名，如 ['宁德时代']"
      },
      max_depth: {
        type: "integer",
        default: 3,
        minimum: 1,
        maximum: 5,
        description: "最大探索深度（跳数）"
      },
      relation_filters: {
        type: "array",
        items: { type: "string" },
        description: "可选，只关心这些关系类型"
      }
    },
    required: ["goal", "seed_entities"]
  }
}
```

---

## 辅助文档：Agent Card YAML（人读，非运行时）

```yaml
agent_id: fin-trace-v1
display_name: 图探索专家
description: >
  在金融知识图谱上执行多跳关系推理和路径发现的专用 Agent。
  独立进程，通过 MCP 暴露为重型工具。内部运行自定义 Agent Loop
  （EXPLORING → FINALIZE），不依赖任何 Agent 框架的编排层。

runtime: independent_process_with_custom_loop
integration: mcp_tool

capabilities:
  primary:
    - multi-hop relationship reasoning
    - entity path discovery
    - event chain tracing
    - supply chain risk propagation analysis

input:
  goal:          string (required)     # 自然语言探索目标
  seed_entities: string[] (required)   # 起始实体中文名
  max_depth:     number (default: 3)   # 最大探索深度
  relation_filters: string[] (optional)
  timeout_ms:    number (default: 120000)

output:
  findings:
    format: Finding[]
    description: >
      离散认知产出。statement + confidence(high/medium/low) +
      evidence(KU ID列表) + entities_involved + relation_to_goal。
      高置信度可直接用于二次推理。
  event_threads:
    format: EventThread[]
    description: >
      事件发展脉络。title + summary(2-3句) + narrative(完整叙事) +
      thread_events[](ku_id可溯源) + relationships[](4种类型+reasoning)。
      需要理解完整故事线时使用。
  exploration_meta:
    format: ExplorationMeta
    description: >
      completion_reason(5种) + stats + reliability_note。
      reliability_note 非空时标注输出可靠性。

behavior:
  knowledge_source: knowledge_graph_only
  guarantees_evidence_trace: true         # 每条 finding 可追溯
  guarantees_no_hallucination: false      # trust but verify
  max_latency_ms: 120000
  typical_latency_ms: 30000

error_contract:
  no_data:        { findings: [], threads: [], reason: "no_data" }
  insufficient:   { findings: [...] threads: [], reason: "insufficient_for_threading" }
  degraded:       { findings: [...], reliability_note: "mcp_degraded" }
  timeout:        { findings: [], threads: [], reason: "timeout" }

examples:
  good:
    - "调查美国出口管制对华为供应链的传导效应"
    - "宁德时代和比亚迪的供应商重叠情况，以及谁更依赖被制裁的供应商"
    - "欧盟碳关税对南方航空欧洲航线的影响路径"
  bad:
    - "宁德时代是哪年成立的"                        # 单实体查询 → search_knowledge
    - "2024年新能源汽车行业财报汇总"                # 统计分析
    - "这份PDF里提到了哪些公司"                     # 文档搜索
```

---

## 集成架构

```
OpenClaw 主 Agent
  │
  ├── MCP 工具:
  │   ├── search_knowledge(...)        # 单次 KG 查询
  │   ├── expand_graph_detail(...)     # 展开聚类
  │   ├── graph_explore(...)           # 多跳探索 Agent ← 和其他工具一样
  │   └── ...
  │
  │   LLM 看 tool description → 自己决定选哪个
  │
  └── function call graph_explore → 等待 30-120s → 收结构化输出

和 search_knowledge 的区别:
  - 调用方式: 一样（function call）
  - 内部实现: search_knowledge = 一次 DB 查询
              graph_explore = 完整 Agent Loop (EXPLORING → FINALIZE)
  - 返回: search_knowledge = 原始数据
          graph_explore = 分析后的结构化输出
  - 时延: search_knowledge ~1s, graph_explore ~30-120s
```
