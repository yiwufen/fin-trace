---
name: fin-trace
description: 当用户问题需要金融知识图谱多跳推理时激活。触发词：供应链追踪、传导路径、关系穿透、关联方排查、多跳推理、X对Y的影响链路、A和B的供应商重叠
---

# fin-trace — A2A Agent 使用指令

你是 Host Agent。fin-trace 是一个 A2A Agent，通过 Agent Card 暴露能力，通过 JSON-RPC 接收任务。

---

## 判断：要不要用

> "这个问题能通过一次查图回答，还是需要在图中走多步探索？"

| 一次查图 → search_knowledge | 多步探索 → fin-trace |
|----------------------------|---------------------|
| "宁德时代是哪年成立的" | "美国制裁如何传导到宁德时代的欧洲供应链" |
| "比亚迪最近有哪些事件" | "宁德时代和比亚迪的供应商有多少重叠" |
| "A 公司的大股东是谁" | "Z 公司的关联方中是否有被制裁实体" |

---

## A2A 调用流程

### Step 1: 发现 Agent

拉取 Agent Card，确认 fin-trace 有 `graph_explore` skill：

```
GET /.well-known/agent-card.json
→ { name: "fin-trace", skills: [{id: "graph_explore", ...}], url: "/a2a" }
```

OpenClaw 的 `a2a_discover` 工具自动完成这一步。

### Step 2: 提交任务

发送 `tasks/send` 到 `/a2a`，参数用 DataPart 格式：

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tasks/send",
  "params": {
    "message": {
      "messageId": "...",
      "role": "user",
      "parts": [{
        "type": "data",
        "data": {
          "goal": "追踪美国出口管制对宁德时代欧洲供应链的传导路径",
          "seed_entities": ["宁德时代"],
          "max_depth": 3
        }
      }]
    }
  }
}
```

返回 `{taskId, status: "submitted"}` —— 立即，不阻塞。

goal 格式：`动词 + 关注点 + 核心实体 + 预期输出`。不要写"查一下 XX"。

### Step 3: 等待完成

三种方式，按平台支持选择：

| 方式 | A2A 方法 | 说明 |
|------|---------|------|
| **SSE 流式**（推荐） | `tasks/sendSubscribe` | 提交任务同时打开 SSE，实时收每步进度 |
| **轮询** | `tasks/get` | 定期查状态，直到 `completed` 或 `failed` |
| **平台 spawn** | OpenClaw `sessions_spawn` + `sessions_yield` | 平台封装了 A2A，自动等+注入结果 |

SSE 流示例：

```
POST /a2a → tasks/sendSubscribe
  ← event: task / data: {taskId, status:"working", ...}
  ← event: task / data: {taskId, status:"working", metadata:{step:5}}
  ← event: task / data: {taskId, status:"completed", ...}
```

**不要同步等。** 这是长时任务（3-20 分钟），不是 API 调用。

### Step 4: 处理结果

任务 `completed` 后，从 `artifacts` 中取数据：

```
tasks/get → result.artifacts[0].parts[data] →
  { findings, event_threads, exploration_meta }
```

1. 先看 `exploration_meta.reliability_note` → 非空有降级
2. `findings` 按 confidence 分层：high → 结论，medium → 交叉验证，low → 线索
3. `event_threads` 解释事件演变
4. 用自己的话回答用户，不原文粘贴 JSON

---

## 耗时

| depth | 耗时 |
|-------|------|
| 1 | 3-5 分钟 |
| 2 | 5-12 分钟 |
| 3+ | 8-20+ 分钟 |

---

## 禁忌

- **不要同步调用**。A2A task 是异步的——send 后拿到 taskId 就走，等完成通知或 poll
- **不要并发提交多个 task**。fin-trace 内部 Agent Loop 已有工具并行，外部并发浪费资源
- **不要对同一 goal 反复换 seed 重试**。调整 goal 描述更有效
- **不要把 low confidence finding 当结论**
- **不要用 search_knowledge 替代**。单跳查不出来多跳传导路径
