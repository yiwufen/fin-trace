---
name: fin-trace
description: 当用户问题需要金融知识图谱多跳推理时激活。触发词：供应链追踪、传导路径、关系穿透、关联方排查、多跳推理、X对Y的影响链路、A和B的供应商重叠
---

# fin-trace — 金融知识图谱子 Agent 集成指令

你是 Host Agent。当用户问题无法通过单次知识库查询解决、需要在图中走多步探索时，spawn fin-trace 子 Agent。

---

## 判断：要不要 spawn

用这句话测试用户问题：

> "这个问题能通过一次查图回答，还是需要在图中走多步探索？"

| 一次查图能回答 → search_knowledge | 需要多步探索 → spawn fin-trace |
|----------------------------------|-----------------------------|
| "宁德时代是哪年成立的" | "美国制裁如何传导到宁德时代的欧洲供应链" |
| "比亚迪最近有哪些事件" | "宁德时代和比亚迪的供应商有多少重叠" |
| "A 公司的大股东是谁" | "Z 公司的关联方中是否有被制裁实体" |

---

## 操作流程

### Step 1: 组装 prompt

从用户问题中提取 goal 和 seed_entities：

```
探索目标: <动词 + 关注点 + 核心实体 + 预期输出>
起始实体: <实体1>[, <实体2>, <实体3>]
最大深度: <默认 2，不确定时从 2 开始>
```

goal 示例：
- ✓ "追踪美国出口管制对宁德时代欧洲供应链的传导路径"
- ✓ "对比宁德时代和比亚迪的供应商重叠，分析各自制裁风险敞口"
- ✗ "查一下宁德时代"（太模糊，子 Agent 会迷路）

### Step 2: spawn 子 Agent

将上述 prompt 发给 fin-trace。子 Agent 跑在独立 session，上下文隔离，不污染主 session。

不同平台的 spawn 方式：

**OpenClaw**
```
sessions_spawn(agent="fin-trace", prompt=<上述 prompt>)
```

**Claude Code**
```
spawn sub-agent with type "general-purpose", prompt=<上述 prompt>
```

**通用 MCP 调用**（无 spawn 机制时的降级方案）
```
graph_explore(goal, seed_entities, max_depth)
```
仅 depth=1 时可同步调用（设 5 分钟超时）。depth≥2 必须用 spawn。

### Step 3: yield

spawn 之后立即 yield，释放当前 session：

**OpenClaw**
```
sessions_yield(wait_for=[subSession.id])
```

子 Agent 完成时，平台自动唤醒主 session 并注入结果。**不要轮询，不要写检查循环。**

### Step 4: 被唤醒后处理结果

1. 检查 `exploration_meta.reliability_note` — 非空说明有降级，在回答中标注
2. 按 confidence 分层使用 findings：
   - `high` → 直接用于结论
   - `medium` → 交叉验证后使用
   - `low` → 仅作线索，不输出为结论
3. 用 `event_threads` 解释事件演变脉络
4. **用自己的话组织最终回答**，不要原文粘贴 findings JSON
5. 用户追问证据时，用 finding 的 `evidence` 字段（KU ID 列表）

---

## 耗时预期

| depth | 耗时 |
|-------|------|
| 1 | 3-5 分钟 |
| 2 | 5-12 分钟 |
| 3+ | 8-20+ 分钟 |

---

## 禁忌

- **不要同步调用**。graph_explore 是重型工具（3-20min），同步调用会阻塞主 session
- **不要并发 spawn 多个**。内部已有工具并行，外部并发浪费资源
- **不要对同一 goal 反复换 seed 重试**。结果不理想时，调整 goal 的描述
- **不要用 search_knowledge 替代**。如果问题需要多跳，search_knowledge 会漏掉中间环节
- **不要把 low confidence finding 当结论输出**
