# Agent Card — A2A 接口契约

## 核心原则

Agent Card 是 A2A 协议的 self-describing contract。Host Agent（OpenClaw）通过 `a2a_discover` 自动拉取 `/.well-known/agent-card.json`，根据 skills 判断是否应将任务路由给 fin-trace——不需要硬编码集成。

---

## Agent Card

```json
{
  "name": "fin-trace",
  "description": "金融知识图谱多跳关系推理 Agent",
  "protocolVersion": "1.0.0",
  "version": "1.0.0",
  "url": "http://localhost:3001/a2a",
  "capabilities": {
    "streaming": true
  },
  "skills": [
    {
      "id": "graph_explore",
      "name": "金融知识图谱多跳探索",
      "description": "在金融知识图谱上执行多跳关系推理。给定探索目标和起始实体，自主进行多跳探索，返回结构化关键发现（findings）和事件脉络（event_threads）。适合供应链追踪、传导路径分析、关联方排查、竞争对手关系分析。不适合单实体事实查询。延迟：depth=1 约 3-5 分钟，depth=2 约 5-12 分钟。",
      "tags": ["graph", "supply-chain", "sanctions", "multi-hop", "risk", "compliance"],
      "inputModes": ["text", "data"],
      "outputModes": ["text", "data"]
    }
  ],
  "defaultInputModes": ["text", "data"],
  "defaultOutputModes": ["text", "data"],
  "authentication": {
    "schemes": ["bearer"]
  }
}
```

---

## A2A JSON-RPC 端点

Endpoint: `POST /a2a`

### 方法

| 方法 | 说明 | 返回 |
|------|------|------|
| `tasks/send` | 提交探索任务 | `{taskId, status: "submitted"}` 立即返回 |
| `tasks/sendSubscribe` | 提交任务 + 打开 SSE 流 | SSE 事件流（每步进度推送） |
| `tasks/get` | 查询任务状态和结果 | `{taskId, status, statusMessage?, artifacts?}` |
| `tasks/cancel` | 取消运行中的任务 | `{taskId, status: "canceled"}` |

### Task 生命周期

```
submitted → working → completed  (正常)
                    → failed     (异常)
                    → canceled   (取消)
```

### tasks/send 请求示例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tasks/send",
  "params": {
    "message": {
      "messageId": "msg-1",
      "role": "user",
      "parts": [{
        "type": "data",
        "data": {
          "goal": "调查美国出口管制对宁德时代欧洲供应链的传导影响",
          "seed_entities": ["宁德时代"],
          "max_depth": 3
        }
      }]
    }
  }
}
```

也支持 TextPart 格式：

```json
{
  "parts": [{
    "type": "text",
    "text": "探索目标：调查美国出口管制对宁德时代欧洲供应链的传导影响\n起始实体：宁德时代\n最大深度：3"
  }]
}
```

### tasks/get 响应（完成时）

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "taskId": "abc-123",
    "status": "completed",
    "statusMessage": {
      "parts": [{ "type": "text", "text": "探索完成: 3 条发现, 1 条事件脉络" }]
    },
    "artifacts": [{
      "artifactId": "abc-123-output",
      "parts": [{
        "type": "data",
        "data": {
          "findings": [...],
          "event_threads": [...],
          "exploration_meta": {
            "completion_reason": "sufficient",
            "stats": { "steps": 7, "entities_visited": 23, "findings_count": 3 },
            "reliability_note": null
          }
        }
      }]
    }]
  }
}
```

---

## 输出结构（Artifact data）

### Finding

```typescript
{
  id: string;
  category: "pattern_violation" | "concentration" | "chain" | "absence";
  statement: string;             // 一句话自然语言
  confidence: "high" | "medium" | "low";
  evidence: string[];            // KU ID，可溯源
  entities_involved: string[];
  relation_to_goal: string;
}
```

### EventThread

```typescript
{
  title: string;
  summary: string;              // 2-3 句
  narrative: string;            // 完整叙事
  thread_events: { ku_id, entity, event_type, timestamp, description }[];
  relationships: { from_idx, to_idx, type, reasoning }[];
  // type: "causal" | "temporal" | "entity_shared" | "contradiction"
  time_span: { start, end };
  confidence: "high" | "medium" | "low";
}
```

### ExplorationMeta

```typescript
{
  completion_reason: "sufficient" | "max_steps" | "token_budget" | "no_data";
  stats: { steps, entities_visited, findings_count };
  reliability_note: string | null;  // 非空 = 本次探索有降级
}
```

---

## 适合 vs 不适合

### 适合

| 场景 | 示例 goal |
|------|----------|
| 多跳关系推理 | "追踪美国制裁对宁德时代欧洲供应链的影响" |
| 供应链风险传导 | "调查华为芯片断供对下游车企的传导路径" |
| 实体间路径发现 | "宁德时代和比亚迪的供应商重叠情况" |
| 事件链追溯 | "X 政策如何逐级影响产业链各环节" |

### 不适合 → 用 search_knowledge

- 单实体事实查询（"宁德时代哪年成立"）
- 统计汇总、文档搜索、实时行情

---

## 集成架构

```
OpenClaw 主 Agent
  │
  ├── a2a_discover → /.well-known/agent-card.json → 发现 fin-trace
  ├── a2a_send_task(target="fin-trace", message) → 提交探索任务
  │       └→ { taskId, status: "submitted" }   ← 立即返回
  ├── a2a_task_status(target="fin-trace", taskId)
  │       └→ { status: "completed", artifacts: [...] }
  │
  └── 用自己的话回答用户（based on findings + threads）
```

和 search_knowledge 的区别：
- 调用方式：A2A task lifecycle（异步），不是 MCP function call（同步）
- 内部实现：search_knowledge = 一次 DB 查询（~1s），graph_explore = 完整 Agent Loop（3-20min）
- 输出：search_knowledge = 原始数据，graph_explore = 分析后的结构化输出
