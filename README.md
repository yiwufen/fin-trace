<p align="center">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2018-brightgreen" alt="Node.js ≥ 18">
  <img src="https://img.shields.io/badge/license-AGPL%20v3-blue" alt="License: AGPL v3">
  <img src="https://img.shields.io/badge/status-active-success" alt="Status: Active">
</p>

<h1 align="center">Graph Explorer</h1>
<h3 align="center">金融知识图谱上的多跳推理 Agent</h3>
<p align="center">独立 MCP 服务 &nbsp;·&nbsp; 自主探索 &nbsp;·&nbsp; 每一步都有 KU ID 可查证</p>

---

> LLM 告诉你"宁德时代是电池龙头"。
>
> Graph Explorer 告诉你"宁德时代的匈牙利供应商里，谁在同时向被制裁的俄罗斯实体供货，传导路径经
> 过哪些中间节点，每一步的证据在哪。"
>
> **这是让 AI 从"知道"到"调查"的跨越。**

---

## Demo

<p align="center">
  <img src="docs/demo.gif" alt="Graph Explorer Demo" width="720">
</p>

---

## 问题

大模型能回答"什么是供应链风险"，但无法回答：

> 某车企的二级供应商里，哪些同时暴露在美国出口管制清单中？传导路径是什么？每一步的证据在哪？

这不是知识检索，这是**调查**。它要求：

```
  [种子实体]          [跳 1]           [跳 2]           [跳 3]
      │                  │                │                │
  宁德时代  ──投资──→  匈牙利 Supplier X  ──采购──→  美国受限原材料
      │                  │
      └──供应──→     德国 BMW      ←──── 制裁传导 ────┘
```

每一步都是独立的图谱查询，每条边都需要 KU ID 锚定。直接问 LLM，它会在单次推理中"跳步"——编造看似合理的中间节点，给你一段漂亮的文字而不是一份可审计的调查结果。

---

## 它做什么

```
┌─────────────────────────────────────────────────────────┐
│                    一次 graph_explore 调用                │
│                                                         │
│  输入: goal + seed_entities + max_depth                  │
│                                                         │
│    ┌─────────┐     ┌─────────┐     ┌─────────┐          │
│    │ Think   │ ──→ │ Act     │ ──→ │ Observe │ ──→ ...  │
│    │ 策略决策 │ ←── │ MCP查询 │ ←── │ 结果分析 │          │
│    └─────────┘     └─────────┘     └─────────┘          │
│         ↑               ↑               ↑               │
│         └───────────────┴───────────────┘               │
│              ~30-120s 自主探索，多轮迭代                   │
│                                                         │
│  输出: findings + event_threads + exploration_meta       │
└─────────────────────────────────────────────────────────┘
```

不是一个数据库查询（~1s），而是一个完整的调查任务（~30-120s）。Agent 自主决定每一步查什么、往哪个方向走、何时收敛。

| 场景 | 能回答的问题 |
|:-----|:------------|
| 供应链风险 | 某车企供应商体系里，谁在给被制裁实体供货？传导路径经过哪些中间节点？ |
| 政策传导 | 欧盟碳关税 → 哪些中间环节 → 最终影响南方航空的运营成本？ |
| 重叠暴露 | 宁德时代和比亚迪的供应商有多少重叠？谁更依赖高风险供应商？ |
| 事件因果 | 某房企违约后，哪些城投平台的融资成本出现了连锁反应？ |
| 关系验证 | A 和 B 声称合作，但它们之间到底有没有实际投资或采购证据？ |

> **一句话：当问题需要"从 A 走到 D，经过 B 和 C，且每一步都要有证据"，用 Graph Explorer。**

---

## 为什么不用 LLM 直接问

```
┌──────────────────────────────────────────────────────────────────────┐
│                    直接问 LLM                                        │
│    输入 ──→  单次推理（黑盒）  ──→  一段漂亮文字                        │
│              ✕ 无实时数据  ✕ 可能跳步/编造  ✕ 无引用来源                 │
└──────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────┐
│                    Graph Explorer                                    │
│    输入 ──→  Think→Act→Observe ×N轮  ──→  findings + threads + meta  │
│              ✓ 实时图谱    ✓ 每跳可审计    ✓ 每条可追溯到 KU ID         │
└──────────────────────────────────────────────────────────────────────┘
```

| | 直接问 LLM | Graph Explorer |
|:--|:--|:--|
| 数据 | 训练截止日，无私有数据 | 实时金融知识图谱 |
| 推理 | 单次推理，长链易跳步 | 每跳一次 MCP 查询，路径可审计 |
| 证据 | 无引用 | 每条发现附带 KU ID |
| 输出 | 自然语言，需人工整理 | 结构化 JSON，可被下游消费 |

**核心差异：可追溯。** 不是"AI 说有关系"，而是"AI 找到了一条路径，每一步都有 KU ID 可以查证。"

---

## 30 秒开始

```bash
git clone <repo-url> && cd fin-trace

cp config.example.json config.json   # 填入 API key 和知识图谱地址
npm install && npm run dev           # 启动，监听 :3001
```

MCP 传输协议：**Streamable HTTP**。在各类客户端中配置：

**Claude Code** (`claude.json`)

```json
{
  "mcpServers": {
    "fin-trace": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

**OpenClaw** 或其他 MCP 客户端

```json
{
  "mcpServers": {
    "fin-trace": {
      "transport": "streamable-http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

<br>

**输入 → 输出一览**

```json
// 输入
{ "goal": "调查美国出口管制对宁德时代欧洲供应链的传导影响",
  "seed_entities": ["宁德时代"], "max_depth": 3 }

// 输出 (~30-90s)
{
  "findings": [{
    "id": "f_001",
    "category": "chain",
    "statement": "宁德时代→Supplier X→BMW 供应链中，Supplier X 同时从美国采购受限原材料",
    "confidence": "high",
    "evidence": ["ku_20240315_001", "ku_20240315_045", "ku_20240601_122"]
  }],
  "event_threads": [{
    "title": "制裁通过二级供应商传导至欧洲整车厂",
    "narrative": "2024年3月美国商务部更新出口管制清单，Supplier X 原材料受限，进而影响 BMW 电池模组交付",
    "thread_events": [
      { "ku_id": "ku_20240315_001", "entity": "美国商务部", "event_type": "sanction_update" }
    ],
    "relationships": [
      { "from_idx": 0, "to_idx": 1, "type": "causal",
        "reasoning": "管制清单更新直接导致 Supplier X 原材料受限" }
    ]
  }],
  "exploration_meta": {
    "completion_reason": "sufficient",
    "stats": { "steps": 7, "entities_visited": 23, "findings_count": 4 }
  }
}
```

---

## 核心能力

```
┌────────────────────────────────────────────────────────────────────┐
│                                                                     │
│   ⚉ 自主多跳探索              ⚉ 四类结构化发现                        │
│    策略自决策，路径透明           chain · concentration               │
│    会扩展、会回退、会换方向         pattern_violation · absence         │
│                                                                     │
│   ⚉ 事件脉络构建              ⚉ 生产级容错                             │
│    散落事件 → 因果故事线        三级降级 · 格式修复 · 收敛检测             │
│    每段关系附带推理说明          128k 预算分池 · 4级压缩                  │
│                                                                     │
│            ⚉ 不保证零幻觉，但保证可验证 ← 每条 finding 都有 KU ID        │
│                                                                     │
└────────────────────────────────────────────────────────────────────┘
```

### 四类发现

```
 chain              模式违规            集中度              缺失
 ──────             ──────             ──────             ──────
 A→B→C 的           预期 A 但            15家供应商里        尽管公开宣称
 传导链路            找到了 B            12家有中断记录      合作，A和B之间
                                                          无直接投资证据
```

### 事件脉络

`event_threads` 不只是散落的事件列表——离散事件被串联成有因果、时序、共享实体关系的故事线，每段关系附带 `reasoning`，可追溯到 `source_finding_ids`。

### 容错

MCP 三级降级 → LLM 格式自修复 → 连续 4 次相同决策自动切换策略 → 4 级压缩升级。一次查询失败不会中断整个调查。

---

## 架构

```
                    ┌────────────────────────────┐
                    │   上游 LLM（任何 MCP 客户端）  │
                    │   function call →            │
                    │   graph_explore(goal,        │
                    │     seed_entities,           │
                    │     max_depth)               │
                    └────────────┬───────────────┘
                                 │
                                 ▼
           ┌─────────────────────────────────────────┐
           │       Graph Explorer（:3001）            │
           │                                         │
           │   ┌─────────────────────────────────┐  │
           │   │       Agent Loop                │  │
           │   │                                 │  │
           │   │  EXPLORING                      │  │
           │   │  ┌──────┐  ┌──────┐  ┌───────┐ │  │
           │   │  │ Think │─→│  Act  │─→│Observe│ │  │
           │   │  └──────┘  └──┬───┘  └───┬───┘ │  │
           │   │        ↑      │          │      │  │
           │   │        └──────┴──────────┘      │  │
           │   │              × N 轮              │  │
           │   │                                 │  │
           │   │  FINALIZE                       │  │
           │   │  构建 Threads → 验证 → 输出      │  │
           │   └─────────────────────────────────┘  │
           │                ↕ MCP                    │
           │   ┌─────────────────────────────────┐  │
           │   │  lookup · trace · timeline       │  │
           │   │  expand · scan                   │  │
           │   │  (每个工具 hops=1，组合涌现多跳)    │  │
           │   └─────────────────────────────────┘  │
           │                                         │
           │               ↕ MCP                     │
           └──────────────────┬──────────────────────┘
                              │
                              ▼
           ┌─────────────────────────────────────────┐
           │        金融知识图谱（独立 MCP 服务）       │
           └─────────────────────────────────────────┘
```

**Graph Explorer 本身就是一个 MCP Server**——上游 Agent 像调用普通工具一样调用它。区别在于它不是一次查询，而是一个完整的自主探索循环。

### 设计原则

> **"库优于框架"** — Agent Loop 全部在自己代码里，零框架依赖
>
> **单跳工具，多跳涌现** — 每个工具 `hops=1`，复杂推理从 Agent Loop 的组合调用中涌现
>
> **配置解耦** — 知识图谱地址、LLM endpoint 均在 `config.json`，不硬编码
>
> **证据链完整** — Finding 必须有 KU ID 支撑；Thread 必须验证 `ku_id` 存在性

---

## 项目结构

```
src/
├── index.ts              # MCP Server 入口
├── api.ts                # HTTP API
├── agent/
│   ├── loop.ts           # Agent Loop（EXPLORING → FINALIZE）
│   ├── state.ts          # 状态定义 & 序列化
│   ├── prompt.ts         # System Prompt 构建
│   ├── tools.ts          # 5 个 MCP 工具定义
│   ├── mcp-client.ts     # MCP 客户端
│   ├── findings.ts       # Finding 提取 · 去重 · confidence
│   ├── threads.ts        # Event Thread 构建 & 验证
│   ├── context.ts        # 上下文组装 & Token 预算
│   ├── error-handler.ts  # 容错 & 降级
│   └── config.ts         # 配置加载
├── llm/
│   ├── client.ts         # LLM 客户端抽象
│   ├── openai.ts         # OpenAI-compatible 实现
│   └── types.ts
├── chat/                 # 对话循环
├── session-store.ts      # 会话持久化
└── tool-categories.ts
```

---

## License

[GNU Affero General Public License v3.0](LICENSE) — 使用本项目或基于本项目的衍生作品，通过计算机网络提供服务的，必须开源全部源代码。
