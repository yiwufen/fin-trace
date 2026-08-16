# 异常处理 — 四类恢复 + 预算阶梯 + FINALIZE 降级

> 状态: 已实现（v3 五意图架构 + v3.1 确定性/瞬态错误分流） | 已对齐: a2ce04d (2026-08-16)
>
> 源码: `src/agent/error-handler.ts`（格式修复/终止信号/循环检测/降级判定）、
> `src/agent/loop.ts`（MCP 连接失败立即降级、压缩阶梯）。v3 删除了
> recall_* 工具异常章节（工具已不存在）。

---

## 恢复动作分类

| 动作 | 语义 | 何时用 |
|------|------|--------|
| Retry | 重试同一操作 | MCP 超时、LLM 格式错误 |
| Fallback | 降级到备选方案 | 预算紧张 → 减少并行；MCP 连接失败 → 立即降级返回 |
| Skip | 跳过当前步骤 | 工具返回空结果、非关键实体查询失败 |
| Abort | 终止探索 | MCP 完全不可用、连续失败超限 |

---

## MCP 工具异常

| 异常 | 恢复 |
|------|------|
| 超时 | Retry（最多 1 次） |
| 空结果 | **实体名变体重试**（见下），仍空 → Skip（标记实体"无数据"，不阻塞） |
| 错误响应 | lookup/trace 失败 → Skip；expand 失败 → 标记 cluster "不可展开" |
| 参数校验失败（映射层 `validateToolArgs`） | **本地拦截，不发请求**；错误信息注入 LLM 上下文自纠（time_range 双端 ISO 等） |
| 服务端 `{"error": ...}` 载荷（isError=false 正常 content） | `extractErrorPayload` 识别 → `McpDeterministicError`：**不重试、不计 consecutiveErrors**；错误信息注入 LLM 上下文自纠 |
| 连接失败（启动时） | **立即降级返回**：`mcp_degraded=true` + completion_reason=`mcp_unavailable`，不做探索（不再有"降级到 recall 工具"路径——温层已删除） |
| 运行中连续失败 | `tool_call_failures` 计数，连续 ≥3 → `mcp_degraded=true` + reliability_note |

确定性 vs 瞬态错误分流（v3.1）: 参数类错误（本地校验失败、服务端 error 载荷）
是确定性的——重试必然同样失败，且不应计入降级计数（两次 LLM 传参失误
不应废掉会话级 MCP 通道）；仅瞬态错误（超时/5xx/网络）走重试与降级链。

### 实体名变体重试（tryNameVariants）

空结果时按序尝试：state 的 `nameIndex` 别名 → 内置别名表（宁德时代/CATL 等）→
剥离括号内容 → 剥离"股份/集团/有限/公司/汽车"后缀。命中 nameIndex 直接换用
规范名，不重复试错。

---

## LLM 输出异常

| 异常 | 恢复 |
|------|------|
| 格式错误（缺 decision/tool_calls） | `fixLLMOutput` 修复 + Retry（注入修复提示）；**连续 2 次失败 → 降级路径**（FINALIZE 阶段直接降级输出） |
| 幻觉（引用不存在的 ku_id） | 代码验证时过滤，不阻塞 |
| 决策循环（连续 4 步同决策且 finding 无增长） | `applyLoopBreak` 强制切换策略（expand→deep_dive/verify；deep_dive→verify；仍循环 → force_sufficient） |
| 只输出 reasoning 无 tool_calls | Retry（注入"继续探索"指令） |

终止信号容错（`extractStopSignal`）: 优先读显式 `stop`/`stop_reason` 字段
（stop_reason 含 stale/block/no_progress → stalemate，否则 sufficient）；
回退兼容旧 LLM 在 `decision` 里残留的 sufficient/stalemate。

---

## 状态异常（预算阶梯）

上下文估算 / exploring_limit（详见 [context-assembly.md](context-assembly.md)）:

| 比值 | 动作 |
|------|------|
| ≥ 85% | 压缩 exploration_log；压缩后仍 >95% → FINALIZE |
| ≥ 90% | 警告（token_warnings++，State View 注入"建议尽快 conclude"） |
| ≥ 100% | 强制 FINALIZE |

`tool_call_failures ≥ 3` → mcp_degraded 标记。

---

## FINALIZE 降级

FINALIZE 是单点——失败则探索没有完整输出。三条路径：

```
Path 1（正常）: LLM THINK → 输出 threads + final_findings → 代码验证 → 输出
Path 2（LLM 失败）: 超时/格式错误 → 修复重试 → 仍失败 → 代码降级输出 findings + 空 threads
Path 3（验证失败）: LLM 输出合法但 threads 校验不通过 → 部分保留或全部丢弃 → findings 保留
```

所有降级路径都附带 reliability_note；`generateReliabilityNote` 汇总
mcp_degraded / force_sufficient / token_warnings / tool_call_failures 各项。
