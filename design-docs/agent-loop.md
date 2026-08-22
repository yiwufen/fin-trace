# Agent Loop — Phase 状态机与流程

> 状态: 已实现（v3 五意图架构） | 已对齐: dff329c (2026-08-22)
>
> 源码: `src/agent/loop.ts`（主循环 + Phase 切换）、`src/agent/error-handler.ts`
> （决策校验/终止信号/循环检测）。上下文组装见 [context-assembly.md](context-assembly.md)，
> Prompt 见 [system-prompt.md](system-prompt.md)。

---

## 核心流程

```
入口: runExploration(input, onStep?, initialState?, signal?, deps?)
  ├─ MCP 连接（失败 → 立即降级返回 mcp_unavailable，不做探索）
  ├─ initState（seed → frontier，预算分池，时间上下文注入）
  └─ 主循环 while (!done):
       assembleContext(state)   → 上下文组装（State View + 预算分层）
       callLLM(messages)        → LLM 推理（usage 计入预算）
       fixLLMOutput + parse     → 格式修复（连续 2 次失败 → 降级路径）
       if (EXPLORING):
         extractStopSignal      → stop 字段 → sufficient/stalemate（兼容旧 decision 残留）
         validateDecision       → 钳制为 expand/deep_dive/verify
         并行预检 → executeToolCalls（并行只读 / 串行写）
         markVisited + archiveRawEvents（KU 去重归档）
         LLM 批量事件分类（event_data_type，见 data-taxonomy.md）
         shouldExtractFindings → findings 提取（三分流路由，见 findings.md）
         checkContextBudget     → 四级压缩阶梯
         checkPhaseTransition   → P0-P5 终止链
       else (FINALIZE, 最多 2 步):
         handleFinalize         → threads 构建 + 验证（见 event-threads.md）
         done = true
  return assembleOutput(state)
```

### 依赖注入（deps，嵌入式宿主）

第 5 个可选参数 `ExplorationDeps`，供嵌入式宿主（dsh 插件等）注入运行时依赖：

| 字段 | 说明 |
|------|------|
| `llm` | 注入的 LLM 客户端，替代 `createLlmClient()` 的文件配置构造 |
| `mcpClient` | 注入的 KG MCP 客户端（构造时带 `McpServerConfig`）；connect/close 生命周期仍由 runExploration 管理 |
| `llmConfig` | 循环内部直读的 `model` / `max_tokens`（initState 预算、主 LLM 调用、事件分类） |

不传时与文件配置路径（`config.json` → `createLlmClient()` / `new KgMcpClient()`）行为完全一致，服务器侧 7 个调用点无感。

---

## EXPLORING 每步

| 步骤 | 说明 |
|------|------|
| 1. 决策审核 | `validateDecision` 钳制为三种策略（expand/deep_dive/verify）；终止信号由独立 `stop` 字段经 `extractStopSignal` 合成 sufficient/stalemate |
| 2. 并行预检 | 按 token 估算约束本轮调用（见下） |
| 3. 执行工具 | `categorize` 分组：只读工具 `Promise.allSettled` 并行，写操作串行 |
| 4. 归档 | `archiveRawEvents`：KU 按 ku_id 去重进 `raw_event_archive`（不注入 LLM） |
| 5. 事件分类 | 新 KU 批量过 `CLASSIFY_PROMPT` 标注 `event_data_type`（structural_fact / streaming_snapshot / aggregate_metric / unknown） |
| 6. findings 提取 | `shouldExtractFindings` 触发时提取（触发条件见 findings.md） |
| 7. 预算与上下文 | usage 累计；`checkContextBudget` 四级阶梯 |
| 8. Phase 检查 | `checkPhaseTransition` P0-P5 |

### 并行预检规则

token 估算（`TOOL_TOKEN_ESTIMATE`）: lookup 3k · trace 2k · timeline 2.5k ·
expand 2k · scan 1k。剩余预算 = `exploring_limit − used_tokens`。

| 条件 | 动作 |
|------|------|
| 多工具并行总成本 > 剩余预算 30% | 只执行优先级最高的 1 个 |
| 单工具成本 > 剩余预算 50% | 拒绝调用，`force_sufficient = true` |

工具优先级（`pickMostImportantCall`）: **expand > trace > lookup = timeline > scan**

---

## Phase 切换: checkPhaseTransition（P0-P5 终止链）

按序检查，任一命中即 EXPLORING → FINALIZE：

| # | 条件 | 说明 |
|---|------|------|
| P0 | used_tokens ≥ exploring_limit | EXPLORING 预算耗尽 |
| P1 | step_count ≥ 20 | 步数上限（`MAX_EXPLORING_STEPS`；FINALIZE 自身上限 2 步） |
| P2 | frontier 为空 | 没有新的探索方向 |
| P3 | LLM 提议 sufficient | **三重门校验**（不过门则继续探索，见下） |
| P4 | 连续 2 轮 stalemate 且 finding 计数无增长 | 僵局检测 |
| P5 | 决策循环 | 连续 4 步同决策且 finding 无增长 → `applyLoopBreak`；若破局后 `force_sufficient` 则终止 |

### P3 sufficient 三重门

LLM 认为信息充足时，代码强制校验三关，任一不过 → 继续探索（EXPLORING）：

| 门 | 阈值 | 不过时的动作 |
|----|------|-------------|
| 最少洞察 | `key_insights.length ≥ 1`（`MIN_FINDINGS`） | frontier 非空则继续 |
| 近期产出 | 最近 3 步（`MIN_RECENT_PRODUCTIVITY_STEPS`）finding 计数有增长 | 继续 |
| 实体覆盖 | visited 实体（有 entity_id）占 archive 全实体 ≥ 30%（`MIN_ENTITY_COVERAGE_RATIO`） | 继续，并注入覆盖提示 `injectHint` |

### P5 applyLoopBreak（策略切换链）

`expand → deep_dive`（frontier 非空）/ `verify`（空）；`deep_dive → verify`；
其余 → `force_sufficient`。

### max_depth 已知缺口

`ExplorationInput.max_depth` 被调用方接受并透传（A2A handler / chat loop
默认填 3），但内层循环**从不读取**——探索深度实际由步数/预算/门控决定。
对外宣传已如实修正；是否实现 depth 终止是独立的功能决策。

---

## completion_reason 判定（determineCompletionReason）

| 值 | 触发 |
|----|------|
| `mcp_unavailable` | MCP 连接失败且 step_count=0（优先判定，避免误报边际递减） |
| `sufficient` | 最后决策为 sufficient |
| `token_budget` | used_tokens ≥ exploring_limit |
| `depth_exhausted` | step_count ≥ 20（**命名为历史遗留，实指步数耗尽**） |
| `frontier_empty` | frontier 为空 |
| `diminishing_returns` | 兜底（含 P4 僵局、P5 强停） |
| `cancelled` | 外部取消 |

---

## FINALIZE 阶段: handleFinalize

三条路径（均附带 reliability_note）：

| 路径 | 触发条件 | 输出 |
|------|---------|------|
| 正常 | LLM 成功输出 threads + final_findings | 完整结果 |
| LLM 失败降级 | LLM 调用失败 / parse 修复无效 | 原始 key_insights 去重作为 findings，threads=[] |
| 验证降级 | threads 校验不通过 | findings 保留，threads 丢弃或部分保留 |

**设计决策**: FINALIZE 不做新的 MCP 调用——数据已完整在 `raw_event_archive`
（全量注入上下文，见 context-assembly.md）。

Thread 验证规则（ku_id 存在性、时序、类型钳制、长度警告、索引重算）见
[event-threads.md](event-threads.md)。

---

## MCP 不可用处理

连接失败 → **立即降级返回**（无重试循环）：`mcp_degraded=true`、
`reliability_note="知识图谱服务连接失败，探索未能执行"`、
completion_reason=`mcp_unavailable`。运行中单次调用失败走
error-handling.md 的工具级处理（retry → skip 累计）。
