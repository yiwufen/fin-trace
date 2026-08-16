# design-docs v3 对齐 — 九份核心 spec 重写设计

> 状态: 设计完成，待用户审阅 | 日期: 2026-08-16
>
> 范围: 将 `design-docs/` 九份核心 spec 从 v2 三层架构对齐到 v3 现行代码（五意图架构）。
> 原则: **回填为主 + 四个矛盾点逐点裁决**（§三）。除 `tools.ts` 一行注释外，
> 不改任何运行时行为。

---

## 一、背景与角色定位

- 2026-06-04 "去代码化"重构（commit `03b3f94`）后文档冻结在 v2 三层设计；代码随后经历
  v3 五意图重构（删温层/recall 工具、findings 三分流）及 eval/web 等演进，九份核心
  spec 与 `src/` 系统性漂移（2026-08-16 文档审计结论）。
- 对齐后 design-docs 的角色: **已实现架构的权威描述**（documentation of record）。
  代码是事实源；文档照实回填；对外契约（agent-card、README、skills）与宣传同步修正。
- 防再漂移: 状态头 + 同 PR 约束（§五）。

## 二、术语基线（v2 → v3，所有文档统一）

| v2 术语（废除） | v3 现实（写入） |
|---|---|
| event_buffer / event_archive | `raw_event_archive` |
| key_findings 单一列表 | `entity_flags` / `cluster_flags` / `key_insights` 三分流 |
| frontier priority 1-3 | 准入控制 + `mention_count`（上限 10） |
| low_confidence_findings 暂存 | 无此容器（无证据 finding 直接丢弃，见裁决③） |
| 固定 128k 预算 | config 驱动（`llm.max_tokens`，兜底 128k） |
| 80/90/100 预算阶梯 | 85% 压缩 / 90% 警告 / 95% 再压缩 / 100% 强制收敛 |

术语基线表落入 `design-docs/README.md`（S1），作为后续所有文档的引用锚点。

## 三、四个裁决点

### ① trace 的 hops —— 二部图换算（含一行代码改动）

- 事实: schema 注释写"hops 固定为 1"；`mapToMcpCall` 实际传 `hops: 2`；
  AGENTS.md 约束写"hops=1"。
- **解释（用户确认）**: KG 是**实体-事件二部图**，一条语义关系 = 两条边
  （实体→事件→实体）。"hops=1 单跳原则"指**语义跳**；映射层把 1 语义跳
  翻译成 2 条原始边传给 KG。`hops: 2` 不是例外，是二部图换算。
- 处理: `tools.md` 明确写出换算逻辑；`tools.ts` schema 注释改为与映射一致
  的二部图表述（**唯一代码改动，零行为变化**）；AGENTS.md 约束按
  "语义跳 vs 原始边"澄清；实现时核实每个工具的实际透传值，逐一如实记录。

### ② max_depth 未生效 —— 如实记录 + 修宣传

- 事实: 输入契约接受 `max_depth`（Agent Card / skills / README 均宣传），
  但内层循环从不检查 `state.depth`；终止完全由步数预算 + 充分性门控决定。
- 处理: 文档写明"max_depth 当前仅记录不生效"；修正对外宣传中的 depth 延时
  表述（agent-card.md / README.md / skills/fin-trace.md 的"depth=1 约 3-5min"）。
- 遗留: 是否实现 depth 终止是**独立的功能决策**，记为已知缺口，不在本档范围。

### ③ 无证据 finding —— 如实记录"丢弃"

- 事实: v2 设计暂存 `low_confidence_findings`；v3 代码直接丢弃（`findings.ts:251`）。
- 处理: 如实记录。AGENTS.md 绑定约束本就规定 "No evidence = not a valid
  finding"，代码与约束一致，v2 暂存设计是被取代的孤儿方案。无代码改动。

### ④ scan 参数 —— 如实记录"无透传"

- 事实: v2 文档写 scan 透传 "hops=1, top_k=10"；实际 scan 不透传，用 KG
  服务端默认值。
- 处理: 如实记录"无透传，服务端默认"。显式传常量与依赖服务端默认等价，
  改代码无收益。

## 四、九份文档重写要点

| 文档 | 量级 | 核心改动 |
|---|---|---|
| `state.md` | 重写 | 数据模型全换：三分流 findings、`raw_event_archive`、frontier 准入控制、EventDataType 权重（引 `data-taxonomy.md`）、config 驱动预算 |
| `tools.md` | 重写 | 标题与内容改"仅 5 个 KG 工具"；删 recall 三工具章节；每工具 MCP 映射如实记录（含裁决①④） |
| `agent-loop.md` | 大改 | 终止条件改为实际检查链（三重门 + 僵局逻辑 + LLM 事件分类步骤）；删除未实现的 depth 终止（裁决②） |
| `findings.md` | 中改 | 补 `flag_target` 三分流路由；触发条件对齐 `shouldExtractFindings` 实现；无证据处理如实（裁决③） |
| `event-threads.md` | 小改 | 术语替换；补 streaming_snapshot 过滤规则（校验 1b） |
| `context-assembly.md` | 大改 | 删温层/召回/驱逐章节；压缩阶梯改四级；FINALIZE 改全量 `raw_event_archive` 注入；78/16/6 比例保留但标注总数 config 驱动 |
| `error-handling.md` | 中改 | 删 recall 降级路径；MCP 不可用改"立即返回降级"；预算阶梯同步四级 |
| `system-prompt.md` | 重构 | 改为"六层结构 + 每层设计意图 + 引用 `prompt.ts` 段落"，不再复制全文；补未记载的 5 个注入段落说明（Layer 3A、实体旗标警告、时间上下文、flag_target、frontier 提醒） |
| `agent-card.md` | 中改 | completion_reason 改 7 值枚举；time_span 改 `{earliest, latest}`；capabilities 补 `pushNotifications: false`；tags 补 `financial-analysis`；depth 延时宣传修正（裁决②） |

机械性修正（随切片）: README.md / skills / AGENTS.md 中 hops 与 depth 的表述同步。

## 五、防漂移机制

1. **状态头**: 每份重写后的文档头部加
   `> 状态: 已实现（v3 五意图架构） | 已对齐: <short SHA> (2026-08-XX)`
   （沿用 `data-taxonomy.md` 的"状态: 已实现"惯例并增强）。
2. **同 PR 约束**: AGENTS.md「Implementation Fidelity」小节新增绑定约束——
   改 agent 核心行为的 PR 必须同 PR 更新对应设计文档并刷新对齐 SHA。
3. **索引清理**: 九份全部重写后，撤掉 `design-docs/README.md` 的"文档漂移
   警告"，索引表各行去掉 ⚠️ 标注。

## 六、实施切片

单分支 → 一个 PR；每片独立 commit，按依赖序；状态头随片写入。

| 切片 | 内容 |
|---|---|
| S1 | `state.md` 重写 + 术语基线表进 `design-docs/README.md` |
| S2 | `tools.md` 重写 + 裁决①（二部图换算 + `tools.ts` 注释一行）+ 裁决④ |
| S3 | `agent-loop.md` 大改（终止检查链、三重门、僵局逻辑、LLM 事件分类；裁决②） |
| S4 | `findings.md` + `event-threads.md`（三分流路由、`raw_event_archive`、streaming 过滤；裁决③） |
| S5 | `context-assembly.md` + `error-handling.md`（四级压缩阶梯、降级路径） |
| S6 | `system-prompt.md` 重构（结构 + 意图 + 引用源码） |
| S7 | `agent-card.md`（枚举/键名/capabilities）+ 对外三处 depth 宣传修正 + AGENTS.md hops 表述澄清 |
| S8 | AGENTS.md 加同 PR 约束、`design-docs/README.md` 撤警告去 ⚠️、全库 v2 术语残留 grep 验证 |

每片重写时逐条论断对照 `src/` 核实（2026-08-16 审计报告已提供大半 file:line 映射）。

## 七、验收标准

1. 全 `design-docs/` grep `event_buffer` / `recall_` / `low_confidence_findings` /
   `event_archive` —— 仅允许出现在 archive/、three-tier-architecture.md
   （DEPRECATED）和术语映射表。
2. `agent-card.md` 的枚举、键名与 `src/agent/state.ts` 逐字一致。
3. 对外文档（README / skills / agent-card）无 depth 延时承诺；hops 表述含二部图说明。
4. 九份文档全部带"已对齐 SHA"状态头。
5. 唯一代码改动 = `tools.ts` 注释；typecheck 通过。

## 八、遗留与不做

- **max_depth 终止未实现**: 已知缺口，独立功能决策，不在本档范围（裁决②）。
- **neodata 双数据源**: 保持"设计阶段"标注不动。
- **archive/ 与 three-tier-architecture.md**: 已标 DEPRECATED/历史，不重写。
- **web/账户/eval 侧文档**: 档①②已覆盖，不在本档范围。
