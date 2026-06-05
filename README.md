# Graph Explorer

在金融关系网络中，找到隐藏的传导路径。

---

## 它能回答什么问题

LLM 知道"宁德时代是电池龙头"，但回答不了"宁德时代的欧洲供应商里，谁对单一客户依赖超过 50%？"——因为这需要**多次跳转、逐层追溯**，不是一次知识检索能完成的。

Graph Explorer 专为这类问题设计：

| 场景 | 问题示例 |
|------|---------|
| 供应链风险 | "某车企二级供应商里，哪些同时给被制裁的俄罗斯实体供货？" |
| 传导路径 | "欧盟碳关税通过哪些中间环节影响南方航空的运营成本？" |
| 重叠暴露 | "宁德时代和比亚迪的供应商体系有多少重叠，谁更依赖高风险供应商？" |
| 事件因果 | "某房企债务违约后，哪些城投平台的融资成本出现了连锁上升？" |
| 关系发现 | "A 公司和 B 公司公开声称合作，但它们之间是否存在实际投资或采购证据？" |

**一句话**：当你需要"从 A 走到 D，中间经过 B 和 C，并且每一步都要有证据"的时候，用 Graph Explorer。

---

## 和直接问 LLM 有什么不同

| | ChatGPT / Claude 直接问 | Graph Explorer |
|---|---|---|
| 知识范围 | 训练数据截止日，无私有数据 | 实时查询金融知识图谱 |
| 多跳推理 | 单次推理，长链容易"跳步"或编造 | 每跳一次 MCP 查询，路径可审计 |
| 证据 | 无引用来源，无法验证 | 每条发现附带 KU ID，可追溯到原始数据 |
| 输出结构 | 自然语言，需人工整理 | findings + event_threads + meta，结构化可被下游消费 |

**核心差异：可追溯。** 不是"AI 说有关系"，而是"AI 找到了一条路径，每一步都有 KU ID 可以查证"。

---

## 30 秒上手

```bash
# 1. 配置
cp config.example.json config.json
# 编辑 config.json，填入你的 LLM API key 和知识图谱地址

# 2. 启动
npm install && npm run dev
```

MCP 服务运行在 `http://localhost:3001/mcp`，任何 MCP 客户端配置指向该地址即可调用 `graph_explore` 工具。

一次典型调用的输入和输出：

**输入**
```json
{
  "goal": "调查美国出口管制对某电池企业欧洲供应链的传导影响",
  "seed_entities": ["宁德时代"],
  "max_depth": 3
}
```

**输出**（约 30-90 秒）

```json
{
  "findings": [
    {
      "id": "f_001",
      "category": "chain",
      "statement": "宁德时代→匈牙利 Supplier X→德国 BMW 的供应链路中，Supplier X 同时从美国采购受限原材料，形成制裁传导风险",
      "confidence": "high",
      "evidence": ["ku_20240315_001", "ku_20240315_045", "ku_20240601_122"],
      "entities_involved": ["宁德时代", "Supplier X", "BMW"],
      "relation_to_goal": "直接的制裁传导路径"
    }
  ],
  "event_threads": [
    {
      "id": "thread_001",
      "title": "制裁通过二级供应商传导至欧洲整车厂",
      "summary": "美国 2024 年 3 月更新出口管制清单后，匈牙利 Supplier X 的原材料采购受限，进而影响其对 BMW 的电池模组交付。",
      "narrative": "2024 年 3 月，美国商务部将某关键正极材料列入管制清单...",
      "thread_events": [
        { "ku_id": "ku_20240315_001", "entity": "美国商务部", "event_type": "sanction_update", "timestamp": "2024-03-15", "description": "新增管制清单" }
      ],
      "relationships": [
        { "from_idx": 0, "to_idx": 1, "type": "causal", "reasoning": "管制清单更新直接导致 Supplier X 原材料受限" }
      ],
      "time_span": { "earliest": "2024-03-15", "latest": "2024-06-01" },
      "confidence": "high",
      "source_finding_ids": ["f_001"]
    }
  ],
  "exploration_meta": {
    "completion_reason": "sufficient",
    "stats": { "steps": 7, "entities_visited": 23, "findings_count": 4, "events_buffered": 156, "tokens_used": 48000 },
    "reliability_note": null
  }
}
```

---

## 核心能力

**多跳推理** — 从种子实体出发，逐跳探索关系网络。每跳一次 MCP 查询，路径透明，不会"跳过中间环节直接猜答案"。

**证据追溯** — 每条 finding 的 `evidence` 字段包含 KU ID 列表，可追溯到知识图谱中的原始数据。没有证据不构成有效发现。

**事件脉络** — 将散落的离散事件串成因果/时序/共享实体/矛盾关系的故事线，每段关系附带推理说明。

**四类发现**

| 类型 | 含义 | 示例 |
|------|------|------|
| `chain` | 离散事件串成逻辑链 | "A 发布新品 → B 降价 → C 退市" |
| `concentration` | 某实体/事件类型异常集中 | "15 家供应商中 12 家有供应中断记录" |
| `pattern_violation` | 预期 X 但找到了 Y | "预期所有欧盟供应商都有制裁记录，但 Supplier C 零制裁" |
| `absence` | 预期有但没找到 | "尽管公开宣称合作，A 和 B 之间无直接投资证据" |

**容错降级** — MCP 三级容错（重试 → 降级 → 跳过）、LLM 格式自动修复、收敛不足时自动切换探索策略。不保证零幻觉，但保证可验证。

---

## 架构

```
Host Agent（上游 LLM，如 Claude/OpenClaw）
    └── function call: graph_explore(goal, seed_entities, ...)
            │
            ▼
    Graph Explorer（独立进程，MCP Server :3001）
    │
    │  内层 Agent Loop: EXPLORING → FINALIZE
    │       ↕ MCP 工具调用（lookup / trace / timeline / expand / scan）
    │  金融知识图谱
    │
    └── 返回: findings + event_threads + exploration_meta
```

Graph Explorer 本身也是一个 MCP Server——上游 Agent 像调用普通工具一样调用它，区别在于它不是一次数据库查询（~1s），而是一个完整的探索循环（~30-120s）。

---

## 安装 & 启动

```bash
# 前置条件: Node.js ≥ 18
git clone <repo-url> && cd graph-explorer

# 配置
cp config.example.json config.json
# 编辑 config.json:
#   - llm.api_key: 你的 LLM API key
#   - mcp.servers.knowledge-graph.url: 知识图谱 MCP 地址

# 启动
npm install
npm run dev     # 开发模式，tsx 热加载
# 或
npm run build && npm start   # 生产模式
```

启动后访问 `http://localhost:3001/mcp` 即为 MCP 端点。

在 Claude Code 中使用时，在 `settings.json` 中配置：

```json
{
  "mcpServers": {
    "graph-explorer": {
      "type": "http",
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

---

## 项目结构

```
src/
├── index.ts              # MCP Server 入口，注册 graph_explore 工具
├── api.ts                # HTTP API（/api/*），供前端调用
├── agent/
│   ├── loop.ts           # Agent Loop 主逻辑（EXPLORING → FINALIZE）
│   ├── state.ts          # 状态定义 & 序列化
│   ├── prompt.ts         # System Prompt 构建
│   ├── tools.ts          # 5 个 MCP 工具定义
│   ├── mcp-client.ts     # MCP 客户端（连接知识图谱）
│   ├── findings.ts       # Finding 提取、去重、confidence 调整
│   ├── threads.ts        # Event Thread 构建 & 验证
│   ├── context.ts        # 上下文组装 & Token 预算管理
│   ├── error-handler.ts  # 容错 & 降级策略
│   └── config.ts         # 配置加载
├── llm/
│   ├── client.ts         # LLM 客户端抽象
│   ├── openai.ts         # OpenAI-compatible 实现
│   └── types.ts          # LLM 类型定义
├── chat/                 # 对话循环（外层 Loop）
├── session-store.ts      # 会话持久化
└── tool-categories.ts    # 工具分类
```
