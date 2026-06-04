# Agent Loop — Phase 状态机与流程

> 三层架构详见: [three-tier-architecture.md](three-tier-architecture.md)

---

## 核心流程

```
入口: runExploration(input)
  ├─ 初始化 State（seed entities → frontier, budget 分池）
  ├─ 组装 System Prompt + Goal
  └─ 进入主循环

主循环:
  while (!done) {
    assembleContext(state, phase)  → 上下文组装（见 context-assembly.md）
    callLLM(messages, context)     → LLM 推理
    if (EXPLORING) {
      handleExploring(output)      → 处理探索步骤
      checkPhaseTransition(state)  → 检查是否切换到 FINALIZE
    } else {
      handleFinalize(output)       → 处理 FINALIZE 输出
      done = true
    }
    state.step_count++
  }
  return assembleOutput(state)
```

---

## EXPLORING 阶段: handleExploring

每步执行流程：

| 步骤 | 说明 |
|------|------|
| 1. 审核输出 | 验证 LLM 的 decision 和 tool_calls 合法性 |
| 2. 并行预检 | 估算本轮工具调用的总 token 成本。超预算则降级为单工具或强制 FINALIZE |
| 3. 执行工具 | 区分 MCP 调用 vs 内存读取（recall_*） |
| 4. 存入温层 | MCP 工具结果全文存入 state（visited/buffer/findings），不注入 LLM |
| 5. 生成压缩视图 | 从原始结果提取摘要 + 标题行，作为 LLM 可见的版本 |
| 6. 注入对话 | 仅将压缩视图注入消息历史 |
| 7. 更新预算 | 累计 token 消耗 |
| 8. 处理 findings | 提取/去重/合并新 finding（见 findings.md） |

### 并行预检规则

每工具有 token 估算（lookup~3k, trace~2k, timeline~2.5k, expand~2k/cluster, scan~1k/5entities）。

| 条件 | 动作 |
|------|------|
| 多工具并行总成本 > 剩余预算 30% | 降级为只执行优先级最高的 1 个 |
| 单工具成本 > 剩余预算 50% | 拒绝调用，force_sufficient=true |

工具优先级排序：expand > trace > lookup = timeline > scan

---

## Phase 切换: checkPhaseTransition

从 EXPLORING → FINALIZE 的 6 个条件（任一满足即切换）：

| # | 条件 | 说明 |
|---|------|------|
| 0 | EXPLORING 预算耗尽 | v2 新增。100k 用完即切 |
| 1 | LLM decision = sufficient | LLM 认为信息充足 |
| 2 | 连续 N 步无新 finding | 边际递减检测 |
| 3 | frontier 为空 | 没有新的探索方向 |
| 4 | step_count >= max_steps | 步数上限 |
| 5 | depth >= max_depth | 深度上限 |

---

## FINALIZE 阶段: handleFinalize

三条路径：

| 路径 | 触发条件 | 输出 |
|------|---------|------|
| 正常 | LLM 成功输出 threads + final_findings | 完整结果 |
| LLM 失败降级 | LLM 超时/格式错误，重试 1 次仍失败 | 直接用 key_findings（去重后），threads=[] |
| 验证失败降级 | LLM 输出合法但 threads 校验不通过 | findings 保留，threads 丢弃或部分保留 |

降级时都附带 reliability_note 说明原因。

**设计决策**: FINALIZE 不做新的 MCP 调用。数据已完整体现在温层。

---

## Thread 验证（FINALIZE 输出的后处理）

| 校验项 | 规则 | 失败处理 |
|--------|------|---------|
| ku_id 存在性 | 每个 thread_event 的 ku_id 必须在 event_buffer 中 | 移除幻觉事件，剩余 <3 则丢弃整条 Thread |
| 时间线一致性 | causal 关系的 from_event 必须在 to_event 之前 | 标注问题但保留 |
| 关系类型合法性 | 只允许 4 种类型 | 非法类型钳制为 entity_shared |
| Thread 过长 | >10 个事件可能是过度串连 | 标注警告但保留 |

索引偏移：移除幻觉事件后需要更新 relationship 的 from_idx/to_idx。

---

## 终止条件（完整列表）

| 条件 | 阶段 | 说明 |
|------|------|------|
| FINALIZE 完成 | FINALIZE | 正常结束 |
| max_steps | EXPLORING | 步数上限 |
| budget 耗尽 | EXPLORING | token 上限 |
| force_sufficient | EXPLORING | 代码强制（预算紧张/工具失败过多） |
| MCP 完全不可用 | EXPLORING | 降级标记 + 直接 FINALIZE |
