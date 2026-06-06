# A2A (Agent-to-Agent) 协议分析

## 从第一性原理出发：为什么需要 A2A

LLM 时代的 Agent 交互存在一个根本矛盾：

- **单 Agent 能力有限**——一个 Agent 不可能精通所有领域，需要专家分工
- **Agent 间交互没有标准**——每个 Agent 有自己的 API 格式、认证方式、数据模型

这等于 1990 年代的局域网：每台机器是台电脑，但网线和协议不统一，每次通信都要定制。

A2A 要解决的问题：**让任意两个 Agent 之间能发现对方、委托任务、接收结果，而不需要预先约定通信格式。** 本质上就是 Agent 世界的 HTTP + REST。

### 如果不解决这个问题

```
Agent A 要调 Agent B → Agent A 的开发者要:
1. 读 B 的文档（API 格式、认证方式、数据结构）
2. 写专门调用 B 的代码
3. B 升级 → A 也要改
4. 调 Agent C 又要重复步骤 1-3
```

### 解决之后

```
Agent A 要调 Agent B → 
1. 读 B 的 Agent Card（机器可读 ↑）
2. 按标准协议发送任务
3. 对 Agent C、D、E 同样流程
```

---

## 核心设计

### Agent Card — 自描述契约

每个 Agent 在 `/.well-known/agent-card.json` 暴露自己的"能力说明书"：

```json
{
  "name": "fin-trace",
  "description": "金融知识图谱多跳关系推理",
  "url": "https://fin-trace.example.com",
  "capabilities": { "streaming": true, "push_notifications": true },
  "skills": [
    { "id": "graph_explore", "description": "多跳供应链/股权/关联方关系探索" }
  ],
  "authentication": { "schemes": ["bearer"] }
}
```

客户端 Agent 拉取这个 JSON，就能自动知道"这个 Agent 能做什么、怎么调用、是否支持异步通知"——零硬编码集成。

### Task — 异步任务生命周期

A2A 的核心操作单元是 Task，不是一次 RPC 调用：

```
submitted → working → input-required → completed / failed / canceled
                              ↑                ↑
                         等待人类输入        产出 Artifact
```

和 MCP function call 的本质区别：

| | MCP tool call | A2A task |
|------|------|------|
| 模型 | 同步 request → response | 异步 submit → poll/stream → collect |
| 超时 | 连接断了就丢了 | task_id 持久化，断连后可续查 |
| 进度 | 无原生支持 | 有 status + SSE streaming |
| 结果 | 返回值 | Artifact（可单独 fetch） |

---

## 时间线

| 时间 | 事件 |
|------|------|
| 2025 年 4 月 | Google 在 Cloud Next 发布 A2A，50+ 合作伙伴 |
| 2025 年 6 月 | 贡献给 Linux Foundation，Apache 2.0 开源 |
| 2025 H2 | v0.2 → v0.3，新增 gRPC、签名安全卡 |
| 2026 Q1 | 150+ 组织支持，5 种语言 SDK（Python/JS/Java/Go/.NET） |
| 2026 Q2 | Google I/O 宣布 Gemini Enterprise Agent Platform 深度集成 A2A |

---

## 与 MCP 的关系：互补而非替代

```
┌──────────────────────────────────────────┐
│               A2A 层                      │
│    Agent ↔ Agent 发现、委托、协作           │
│    ┌──────────┐  ←→  ┌──────────┐         │
│    │ Host     │      │ fin-trace│         │
│    │ Agent    │      │ Agent    │         │
│    └────┬─────┘      └────┬─────┘         │
│         │                 │               │
├─────────┼─────────────────┼───────────────┤
│         ▼                 ▼               │
│    MCP 层: 工具/数据/资源访问              │
│    search_knowledge   lookup/trace/...    │
│         │                 │               │
│         ▼                 ▼               │
│      知识图谱         知识图谱              │
└──────────────────────────────────────────┘
```

一句话总结行业共识：**MCP 是 Agent 的 USB-C（连接工具/数据），A2A 是 Agent 的 HTTP（连接其他 Agent）。** 不是一个替代另一个，而是一个协议栈的两个层。

---

## 是否属于行业发展方向

**是。** 三个信号：

1. **三朵云全接入**——Google Cloud（深度集成）、Azure AI Foundry、AWS Bedrock AgentCore 都已支持
2. **治理中立**——已从 Google 移交给 Linux Foundation 的 Agentic AI Foundation，不再是"Google 的协议"
3. **企业生产使用**——SAP、Salesforce、ServiceNow、Atlassian 已在生产环境跑 A2A，不是 POC

结合 2026 年 Google 公开信号：**89% 业务团队已使用 AI Agent，平均每组织 12 个 Agent**。Agent 数量增长 → Agent 间通信需求增长 → A2A 的必要性增长。这是确定性的方向。

---

## 对 fin-trace 的意义

当前 fin-trace 作为 MCP tool 暴露，10 分钟的任务塞进一次 function call：

```
现在:  Host → MCP → graph_explore(...)  [等 10 分钟，连接断了全丢]
建议:  Host → A2A → task/send(...) → { task_id }  [断开]
       Host → A2A → task/get(task_id) → { status: "working", step: 5/12 }
       Host → A2A → task/get(task_id) → { status: "completed", artifacts: [...] }
```

改造成 A2A Agent 后：
- Host 提交任务即走，不占连接
- 进度可查（step 5/12），不瞎等
- 连接断开不丢结果（task_id 持久化）
- Agent Card 让 Host 自动发现 fin-trace 的能力

这比"MCP tool 里藏一个 Agent Loop"更贴合 problem domain。

---

## OpenClaw 的 A2A 集成模式

### 架构

OpenClaw 通过插件（`openclaw-a2a-gateway`）将 A2A 协议封装为 LLM 可调用的工具，第三方 Agent 只需暴露 Agent Card + A2A 端点即可被自动发现和调用。

```
OpenClaw 主 Agent
    │
    ├── a2a_discover()      ← LLM 可见的工具
    ├── a2a_send_task()     ← LLM 可见的工具
    ├── a2a_task_status()   ← LLM 可见的工具
    │
    │  ┌─ 插件层 (openclaw-a2a-gateway)
    │  │   负责: Agent Card 拉取、DNS-SD/mDNS 发现、
    │  │        JSON-RPC 通信、SSE 流、断路器、推送通知
    │  │
    │  ▼
    └──→ 第三方 Agent (A2A JSON-RPC over HTTPS)

第三方 Agent 只需:
  - 在 /.well-known/agent-card.json 暴露能力说明
  - 实现 tasks/send、tasks/get、tasks/cancel 端点
```

### LLM 视角：A2A 就是三个 function call

从 LLM 的角度看，A2A 第三方 Agent 和普通 MCP tool 没有区别——都是 function call。Agent Card 的 `skills` 就是"工具描述"，LLM 据此决定调哪个 Agent。

```
Step 1: LLM 不确定谁能处理 → 调用 a2a_discover()
        → [
            { name: "fin-trace", skills: [{id: "graph_explore", ...}] },
            { name: "data-analyzer", skills: [...] }
          ]

Step 2: LLM 判断需要图探索 → 调用 a2a_send_task(
            target: "fin-trace",
            message: "探索目标: ...\n起始实体: ..."
        )
        → { taskId: "abc123", status: "working" }  ← 立即返回，不阻塞

Step 3: LLM 可 yield 或处理其他事。需要时查进度：
        → a2a_task_status(target: "fin-trace", taskId: "abc123")
        → { status: "working", progress: "step 5/12" }

Step 4: 任务完成
        → { status: "completed", artifacts: [{ findings, threads }] }
        → LLM 用结果回答用户
```

和当前 MCP 模式的本质区别：

```
MCP:   OpenClaw ── graph_explore(...) ──→ [卡 10 分钟等返回]
A2A:   OpenClaw ── a2a_send_task ──→ { taskId } [立即返回]
              ── a2a_task_status ──→ { progress } [按需查询]
              ←── push notification ── [任务完成]
```

### fin-trace 改造为 A2A Agent 需要做的事

| 步骤 | 内容 |
|------|------|
| 1 | 实现 `/.well-known/agent-card.json`，登记 `graph_explore` skill |
| 2 | 实现 A2A JSON-RPC 端点：`tasks/send`、`tasks/get`、`tasks/cancel` |
| 3 | `tasks/send` 收到请求后启动 Agent Loop，将探索过程映射为 Task 生命周期 |
| 4 | 支持 SSE 推送每步进度（step 5/12），注册 webhook 通知完成 |
| 5 | 探索完成后，将 findings + threads + meta 打包为 Artifact |

OpenClaw 侧不需要任何改动——`a2a_discover` 自动发现 fin-trace 的 Agent Card，`a2a_send_task` 自动路由。

### Agent Card 示例（fin-trace）

```json
{
  "name": "fin-trace",
  "description": "金融知识图谱多跳关系推理 Agent。在金融知识图谱上执行供应链追踪、传导路径分析、关联方排查。",
  "protocolVersion": "1.0.0",
  "version": "1.0.0",
  "url": "https://fin-trace.example.com/a2a",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "skills": [
    {
      "id": "graph_explore",
      "name": "金融知识图谱多跳探索",
      "description": "在金融知识图谱上执行多跳关系推理。输入探索目标和起始实体，返回关键发现和事件脉络。适合供应链追踪、传导路径分析、关联方排查。",
      "tags": ["graph", "supply-chain", "sanctions", "risk", "multi-hop"],
      "inputModes": ["text"],
      "outputModes": ["text", "data"]
    }
  ],
  "authentication": {
    "schemes": ["bearer"]
  }
}
```
