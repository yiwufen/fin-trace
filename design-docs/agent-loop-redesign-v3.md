# Graph Explorer Agent Loop Redesign v3

> 日期: 2026-06-04
> 状态: 设计讨论
> 触发: 从"单次任务执行器"升级为"多轮对话 Agent"
> 参考: Claude Code query.ts / OpenClaw embedded-runner / Codex turn.rs

---

## 一、问题：当前设计的局限

### v2 的核心假设

v2 把 Graph Explorer 设计成一个**函数**：输入参数完整 → 执行探索 → 返回结构化结果。

这个假设在三个场景下断裂：

1. **参数不完整**：用户说"帮我分析宁德时代的供应链风险"——缺少时间范围、关注方向、深度要求。v2 只能报错或用默认值硬猜。
2. **用户追问**：探索返回结果后，用户问"津巴布韦的锂矿具体受什么影响？"——v2 无法处理，因为函数已经返回了。
3. **结果翻译**：结构化 JSON 不是用户要看的。需要 LLM 把 Findings + Event Threads 翻译成自然语言。

### 用户的真实交互模式

用户和 Graph Explorer 的交互是对话，不是 API 调用：

```
用户：帮我分析宁德时代最近的供应链风险
Agent：我需要确认几个参数——关注的时间范围？制裁还是供应链中断？
用户：2024到现在，制裁影响
Agent：[探索]... 完成了。核心发现是 XXX。详见下方。
用户：津巴布韦那条线具体怎么回事？
Agent：[直接回答，或启动新探索补充]
```

---

## 二、第一性原理：Agent Loop 的本质

### 三家 Agent 产品的共同模式

| 产品 | Loop 结构 | LLM 职责 |
|------|----------|---------|
| Claude Code | while(true)，LLM 自主决定调工具还是回复 | 完全自主 |
| OpenClaw | while(true)，LLM 自主决策 + failover 保护 | 完全自主 |
| Codex | Turn 循环，每轮 build_prompt → call_model → execute_tools | 完全自主 |

**共同点**：Agent Loop 不是"执行某个任务"，是"维持一个持续的对话循环，LLM 在循环中自主决定下一步行动"。工具调用只是 LLM 可能选择的行动之一。

### 核心转变

```
v2:  函数式 —— runExploration(params) → 结构化结果
v3:  对话式 —— while(用户消息) { LLM 自主决策 }
```

探索不再是外部触发的任务，而是 LLM 可以选择的一种行动（工具）。

---

## 三、v3 架构：双层循环

### 整体结构

```
外层 Loop（对话循环，面向用户）
  用户消息 → LLM 判断意图 → 选择行动
    ├─ 直接回复（澄清/闲聊/追问回答）
    ├─ 追问用户（参数不足）
    └─ 调用 graph_explore 工具
         ↓
       内层 Loop（探索循环，v2 的 EXPLORING + FINALIZE，原封不动）
         EXPLORING: Think → Act(MCP) → Observe × N轮
         FINALIZE: Build Threads → 返回结构化结果
         ↓
       结果作为 tool_result 返回外层
       LLM 把结果翻译成自然语言回复用户
```

### 两层的关系

| 维度 | 外层（对话） | 内层（探索） |
|------|------------|------------|
| 职责 | 理解用户意图、管理对话、翻译结果 | 执行图探索、构建 Event Threads |
| LLM 角色 | 对话者 + 决策者 | 探索者 + 分析者 |
| 状态 | Session（对话历史 + 探索状态引用） | ExplorationState（v2 完整保留） |
| 循环驱动 | 用户消息 | 代码级终止条件 |
| 输出 | 自然语言 + 嵌入式结构化数据 | 结构化 JSON |

**内层就是 v2，不动。外层是 v3 的增量。**

### 为什么是"重型工具"不是"嵌套 Agent"

外层 LLM 看到的只是一次 tool call + tool result。`graph_explore` 内部的黑盒是私有实现。这跟 Claude Code 的 Bash 工具（内部可能跑 60s+）是同一个模式——**重型工具**。

不需要引入 Multi-Agent 编排、消息传递协议、上下文共享这些复杂度。两层之间的接口就是一个 MCP tool definition。

---

## 四、外层 Loop 的关键设计

### 4.1 LLM 可用的工具

| 工具 | 语义 | 何时触发 |
|------|------|---------|
| `graph_explore` | 启动深度探索 | 用户问题需要多跳推理 |
| `getExplorationStatus` | 查看当前探索状态 | 用户追问之前的探索结果 |
| （直接回复） | 不调工具，LLM 直接文本回复 | 澄清、闲聊、简单追问 |

### 4.2 System Prompt 核心要素

**角色**：金融知识图谱探索专家，两种模式（对话 + 探索）。

**决策框架**（嵌入 Prompt 的行为指令）：
1. 参数完整 → 调 graph_explore
2. 参数不足 → 向用户提问
3. 追问之前的探索 → 查 status 或直接回答
4. 闲聊/一般性问题 → 直接回答
5. 探索完成后 → 翻译成自然语言 + 标注置信度 + 提示追问方向

**不嵌入的东西**：内层的探索策略、工具映射、Phase 切换逻辑——这些是内层的私有 Prompt，外层不知道也不需要知道。

### 4.3 上下文组装

三层结构（参考 Claude Code 的缓存前缀策略）：

| 层 | 内容 | 变化频率 | 大小 |
|----|------|---------|------|
| System Prompt | 角色 + 工具说明 + 决策框架 | Session 内不变 | ~3000t |
| Exploration State | 当前探索的 state snapshot | 有探索时注入，无探索时省略 | ~500-2000t |
| Conversation History | 用户消息 + LLM 回复 + tool results | 逐轮增长 | 动态 |

### 4.4 对话历史压缩

外层历史会增长。压缩策略：

- **保留**：最近 N 轮 + Exploration State + System Prompt
- **压缩**：历史对话 → LLM 摘要（类似 Claude Code autocompact）
- **不压缩**：Exploration State（key_insights、entity_flags 是跨轮保障数据）

v1 做简单 LLM 摘要就行。不需要 Claude Code 的 5 级压缩管线。

---

## 五、内层 Loop 的变化

**几乎不变。** v2 设计完整保留：

- [x] ExplorationState 模型
- [x] EXPLORING → FINALIZE Phase 状态机
- [x] Think → Act → Observe 三步循环
- [x] 5 个 MCP 工具（lookup/trace/timeline/expand/scan）
- [x] 上下文组装策略
- [x] 5 种终止条件（代码检测）
- [x] 异常处理（Retry/Fallback/Skip/Abort）
- [x] Event Thread 构建

唯一变化：

| 变化点 | v2 | v3 |
|--------|-----|-----|
| 入口 | 外部直接调用 | 外层 LLM 通过 tool call 触发 |
| 输出消费 | 直接返回给调用方 | 作为 tool_result 注入外层对话历史 |
| SSE 事件 | 直接推给前端 | 包装在 `tool_event` 中透传给前端 |

---

## 六、前端 UI 的变化

### v2 方案（纯探索 UI）

整个页面是 ExplorationView。用户输入 → 触发探索 → 看过程 → 看结果。

### v3 方案（对话 + 嵌入式探索 UI）

整个页面是 ChatView。ExplorationView 嵌入在对话流的某条助手消息中。

```
ChatView
  ├─ MessageList
  │   ├─ UserMessage: "分析制裁对宁德时代供应链"
  │   ├─ AssistantMessage: "我需要确认..." (纯文本)
  │   ├─ UserMessage: "2024到现在，制裁影响"
  │   └─ AssistantMessage:
  │       ├─ TextPart: "好的，我来追踪美国制裁..."
  │       ├─ ToolCallPart → ExplorationView (嵌入式)
  │       │   ├─ PhaseIndicator
  │       │   ├─ StepTimeline
  │       │   └─ FinalResults
  │       └─ TextPart: "探索完成。核心发现是..."
  └─ ChatInput
```

### SSE 事件分层

前端收到的两类事件：

1. **外层事件**：text_delta（LLM 文本输出）、tool_start/tool_result（工具调用生命周期）、message_complete
2. **探索事件**（透传）：step_think/step_act/step_observe/phase_switch/complete

前端根据 `tool_start.tool_name === 'graph_explore'` 决定渲染 ExplorationView。

---

## 七、工程实施

### 分阶段

| 阶段 | 内容 | 依赖 | 时间 |
|------|------|------|------|
| P0 | 外层对话循环（while + LLM + 文本回复） | 无 | 2天 |
| P1 | graph_explore 桥接（外层调内层） | P0 + v2 内层 | 2天 |
| P2 | 前端 ChatView + ChatInput | P0 | 2天 |
| P3 | 前端 ExplorationView（嵌入式） | P1 + P2 | 3天 |
| P4 | 追问 + ExplorationStatus + 跨轮状态 | P1 | 1天 |
| P5 | 对话历史压缩 | P0 | 1天 |
| **总计** | | | **~11天** |

### 技术选型原则

- **后端**：轻量 HTTP 框架（Hono），SSE 原生支持，不依赖 Express/Next.js
- **LLM 调用**：统一 SDK 接口，支持多模型
- **前端**：Vite + React，不需要 SSR/SEO。shadcn/ui 做基础组件
- **状态管理**：轻量（Zustand 或等价物）

### 模块边界

```
core/     → 内层探索循环（v2，不动）
agent/    → 外层对话循环（v3 新增）
server/   → HTTP + SSE 层
web/      → 前端
```

`agent/` 通过 `graph_explore` tool call 桥接 `core/`。两层之间的接口契约 = MCP tool definition。

---

## 八、约束与风险

### 约束

1. **内层不变原则**：v2 的设计是经过模拟验证的，v3 外层不能修改内层逻辑
2. **重型工具延迟**：graph_explore 30-120s，前端必须有 loading 状态 + 中途可取消
3. **上下文预算**：外层对话 + 内层探索结果可能很大，需要压缩策略
4. **MCP 依赖**：内层探索依赖 knowledge-graph MCP，MCP 不可用时外层要能优雅降级（直接告诉用户数据服务不可用）

### 风险

| 风险 | 缓解 |
|------|------|
| 外层 LLM 不正确判断意图（该探索时闲聊，该闲聊时探索） | System Prompt 的决策框架 + few-shot examples |
| 探索结果太大撑爆外层上下文 | graph_explore 返回摘要，不返回全量 raw |
| 两层 Prompt 冲突 | 外层 Prompt 不知道内层工具/策略，内层 Prompt 不知道外层对话 |
| v1 压缩策略不够用 | 先观察实际 token 消耗再决定是否升级压缩 |
