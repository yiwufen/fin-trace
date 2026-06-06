---
name: fin-trace
description: 当需要金融知识图谱多跳推理时使用此 skill。触发词：供应链追踪、传导路径、关系穿透、关联方排查、多跳推理
---

# fin-trace — 金融知识图谱子 Agent

## 何时 spawn

满足以下条件时 spawn fin-trace 子 Agent：

- 用户问题需要 **A→B→C 多跳关系推理**（供应链传导、股权穿透、关联方排查、事件链追溯）
- 不是单实体事实查询（那是 search_knowledge 的事，~1s）

决策问句：**"这个问题能通过一次查图回答，还是需要在图中走多步探索？"** 后者 → spawn。

## 何时不 spawn

- 单实体查询（"宁德时代是什么"、"A 公司有哪些事件"）→ 用 search_knowledge
- 统计汇总、文档搜索、实时行情 → 不适用
- 用户问题本身不涉及关系推理

## 如何 spawn

```
sessions_spawn({
  agent: "fin-trace",
  prompt: `
探索目标: ${goal}
起始实体: ${seed_entities.join(", ")}
最大深度: ${max_depth}
${relation_filters ? `关系过滤: ${relation_filters.join(", ")}` : ""}
`,
})
```

然后 **yield**，不要同步等：

```
sessions_yield({ wait_for: [subSession.id] })
```

子 Agent 完成后，平台自动唤醒当前 session 并注入结果。

## 参数怎么填

- **goal**: 自然语言。格式 "动词 + 关注点 + 核心实体 + 预期输出"。例如 "追踪美国制裁对宁德时代欧洲供应链的传导效应"。不要写 "查一下XX"——太模糊，内部 Agent Loop 会迷路。
- **seed_entities**: 1-3 个实体中文名。1 个是深度追踪，多个是交叉比对。
- **max_depth**: 默认 3。不确定时从 2 开始，不够再加。depth 越大越慢。
- **relation_filters**: 不设，让内部 Agent 自己判断。除非你明确知道只要某类关系。

## 耗时预期

| depth | 耗时 |
|-------|------|
| 1 | 3-5 分钟 |
| 2 | 5-12 分钟 |
| 3+ | 8-20+ 分钟 |

耗时由 KG 服务端工具调用主导（每次 20-60s），Agent Loop 每步 1-3 次调用。

## 收到结果后

1. **先看 exploration_meta.reliability_note**。非空 → 本次探索有降级，结论打折。
2. **按 confidence 分层**：high → 可直接用；medium → 交叉验证后用；low → 不作为结论。
3. **用自己的话回答用户**，不要原文转发 findings。findings 是素材，不是最终答案。
4. 需要溯源时，每条 finding 的 evidence 字段是 KU ID 列表。

## 不要做

- **不要同步调用 graph_explore**。用 spawn + yield，让子 Agent 跑在独立 session。
- **不要并发 spawn 多个**。内部已有工具并行，外部并发浪费资源。
- **不要对同一 goal 反复换 seed 重试**。调整 goal 描述更有效。
- **不要把 low confidence finding 当结论输出**。
- **不要 spawn 后轮询**。yield 之后等平台回调，不要写检查循环。
