# 异常处理 — 四类恢复 + 预算分池 + FINALIZE 降级

---

## 恢复动作分类

| 动作 | 语义 | 何时用 |
|------|------|--------|
| Retry | 重试同一操作 | MCP 超时、LLM 格式错误 |
| Fallback | 降级到备选方案 | MCP 不可用 → recall 工具；预算紧张 → 减少并行 |
| Skip | 跳过当前步骤 | 工具返回空结果、非关键实体查询失败 |
| Abort | 终止探索 | MCP 完全不可用、连续失败超限 |

---

## MCP 工具异常

| 异常 | 恢复 |
|------|------|
| 超时 | Retry（最多 1 次） |
| 空结果 | Skip（标记实体为"无数据"，不阻塞后续探索） |
| 错误响应 | 检查是否可降级。lookup 失败 → Skip；trace 失败 → Skip；expand 失败 → 标记 cluster 为"不可展开" |
| MCP 连接断开 | 标记 mcp_degraded=true。后续探索仅用 recall_* 工具和已有 state 数据 |

---

## 内存读取工具异常（recall_*）

内存读取不涉及网络，异常类型简单：

| 异常 | 处理 |
|------|------|
| 实体不在 visited 中 | 返回空结果 + 提示"该实体未被探索，请用 lookup" |
| finding_id 不存在 | 返回 error + 可用 finding id 列表 |
| event_buffer 为空 | 返回空 + 提示"尚未缓存任何事件" |
| 数据在 archive（冷层） | 返回数据 + 标注 "archived" |

**内存读取不需要 retry**——数据要么在温层，要么不在。数据不在不是异常，是信息。

---

## LLM 输出异常

| 异常 | 恢复 |
|------|------|
| 格式错误（缺 decision / tool_calls） | Retry（注入格式修复提示，最多 1 次） |
| 幻觉（引用不存在的 ku_id） | 代码验证时过滤，不阻塞 |
| 决策循环（连续 N 步相同 decision + 相同工具） | 注入警告文本打破循环。超限 → force_strategy 切换策略 |
| 只输出 reasoning 无 tool_calls | Retry（注入"继续探索"指令） |

---

## 状态异常

| 异常 | 恢复 |
|------|------|
| 预算使用率 > 80% | event_buffer 上限降低、对话历史压缩升级 |
| 预算使用率 > 90% | 在 State View 中注入警告："建议尽快 conclude" |
| 预算使用率 >= 100% | 强制 FINALIZE |
| tool_call_failures 连续 >= 3 | 标记 mcp_degraded |
| frontier 连续 3 步无变化 | 注入"考虑切换策略"提示 |

---

## FINALIZE 降级

FINALIZE 是单点——如果这一步失败，整个探索没有输出。所以有三条路径：

```
Path 1（正常）: LLM THINK → 输出 threads + final_findings → 代码验证 → 输出
Path 2（LLM 失败）: 超时/格式错误 → 重试 1 次 → 仍失败 → 代码降级输出 findings + 空 threads
Path 3（验证失败）: LLM 输出合法但 threads 校验不通过 → 部分保留或全部丢弃 → findings 保留
```

所有降级路径都附带 reliability_note。

---

## 与旧版的关系

旧版四类恢复动作（Retry/Fallback/Skip/Abort）仍然适用。v2 新增：
- 内存读取异常处理
- 预算分池告警 + 并行预检
- FINALIZE 单点故障应对

v2 改动是加层，不是替换。
