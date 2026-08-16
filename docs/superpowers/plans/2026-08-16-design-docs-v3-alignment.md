# design-docs v3 对齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 design-docs/ 九份核心 spec 从 v2 三层架构对齐到 v3 现行代码（五意图架构），spec 见 `docs/superpowers/specs/2026-08-16-design-docs-v3-alignment-design.md`。

**Architecture:** 回填式重写——代码是事实源，文档照实描述。按依赖序 8 个切片（S1-S8），每片独立 commit，单分支 `docs/design-docs-v3-alignment` → 一个 PR。唯一代码改动是 `src/agent/tools.ts` 一行注释（裁决①）。

**Tech Stack:** Markdown 文档；验证手段为 grep + 与 `src/` 逐条论断对照；`npm run typecheck` 守住唯一代码改动。

## Global Constraints

- **不改任何运行时行为**。唯一允许的代码改动：`src/agent/tools.ts` 中 trace 的 hops schema 注释（Task 2）。
- 文档语言：中文 + English technical terms；代码标识符用英文原名。
- 术语基线（Task 1 产出，所有任务引用）：`event_buffer/event_archive`→`raw_event_archive`；`key_findings` 单列表→`entity_flags/cluster_flags/key_insights` 三分流；frontier priority 1-3→准入控制+`mention_count`(上限10)；`low_confidence_findings`→无此容器（无证据丢弃）；固定 128k→config 驱动（`llm.max_tokens` 兜底 128k）；预算阶梯 80/90/100→85/90/95/100。
- 状态头格式（每份重写文档标题下第一行）：`> 状态: 已实现（v3 五意图架构） | 已对齐: 33f02f7 (2026-08-16)`（33f02f7 = 对齐基准代码 commit）。
- Commit message 英文，格式 `docs(design): <slice 描述>`。
- 不动 `design-docs/archive/`、`three-tier-architecture.md`（DEPRECATED）、`neodata-integration.md`（设计阶段标注保留）。
- 执行 node/npm 命令前先 `source ~/.nvm/nvm.sh`（非交互 shell 不加载 bashrc）。

---

### Task 1 (S1): state.md 重写 + 术语基线表

**Files:**
- Rewrite: `design-docs/state.md`
- Modify: `design-docs/README.md`（插入术语基线表小节）

**Interfaces:**
- Consumes: 术语基线（Global Constraints 中的映射表）
- Produces: v3 数据模型权威描述（`entity_flags/cluster_flags/key_insights`、`raw_event_archive`、准入控制、`completion_reason` 7 值枚举、`time_span {earliest,latest}`）——后续所有任务引用这些命名

**源码事实（写作依据，重写前先通读）：**
- `src/agent/state.ts:1-8` — 头部注释列出 v3 删除项（event_buffer/event_archive/low_confidence_findings/recall 工具）
- `src/agent/state.ts:59-65` — 实际 state 字段：三分流 findings + `raw_event_archive`
- `src/agent/state.ts:38` — `completion_reason` 7 值枚举（sufficient/max_steps/token_budget/no_data/depth_exhausted/frontier_empty/diminishing_returns/cancelled/mcp_unavailable 中实际存在的值，以代码为准）
- `src/agent/state.ts:136-140` — `EventDataType` 与权重 ×1.0/×0.8/×0.4/×0.6（正文引用 data-taxonomy.md，不重复展开）
- `src/agent/state.ts:233` — `EventThread.time_span: {earliest, latest}`
- `src/agent/state.ts:255-262` — FrontierEntity：准入控制 + `mention_count`（无 priority 字段）
- `src/agent/loop.ts:141-145` — 预算 fallback 链 input → `llm.max_tokens` → 128_000
- `src/agent/loop.ts:161-163` — 78/16/6 三池比例（总池 config 驱动）

- [ ] **Step 1: 通读源码** — 读 `src/agent/state.ts` 全文、`src/agent/loop.ts:130-170`，逐字段核对上述事实
- [ ] **Step 2: 重写 state.md** — 结构：状态头 → 数据模型总览（v3 三分流图示）→ ExplorationState 完整字段表（以 state.ts 实际字段为准）→ Finding/三分流接口 → EventThread（time_span 键名照代码）→ FrontierEntity 准入模型 → 预算模型（config 驱动 + 78/16/6）→ 与 v2 的差异说明（一段，指向 three-tier DEPRECATED）。删除全部温层/驱逐/暂存章节
- [ ] **Step 3: 术语基线表进 README.md** — 在 `design-docs/README.md` 的"⚠️ 文档漂移警告"之后插入"## 术语基线（v2 → v3）"小节，放 Global Constraints 中那张六行映射表
- [ ] **Step 4: 验证** — `grep -n "event_buffer\|event_archive\|low_confidence\|priority" design-docs/state.md` 预期：仅在"与 v2 差异"段出现 v2 术语对照；`grep -c "raw_event_archive" design-docs/state.md` 预期 ≥3
- [ ] **Step 5: Commit** — `git add design-docs/state.md design-docs/README.md && git commit -m "docs(design): rewrite state.md for v3 data model (S1)"`

### Task 2 (S2): tools.md 重写 + 裁决①④

**Files:**
- Rewrite: `design-docs/tools.md`
- Modify: `src/agent/tools.ts:150-154`（trace hops 注释，唯一代码改动）

**Interfaces:**
- Consumes: Task 1 的三分流/预算术语
- Produces: 5 工具 schema + MCP 映射权威描述；"二部图 hops 换算"表述（Task 7 的 AGENTS.md/README 澄清引用此表述）

**源码事实：**
- `src/agent/tools.ts:1` — "v3: 仅 5 个 MCP 工具（删除 recall 工具）"
- `src/agent/tools.ts:87-219` — `TOOL_DEFINITIONS` 五工具 schema（以代码为准逐工具对照）
- `src/agent/tools.ts:150-154` — trace 的 hops 参数 schema 注释现为"固定为 1"（与实现矛盾，需改）
- `src/agent/tools.ts:282` — `mapToMcpCall` trace 传 `hops: 2`
- `src/agent/tools.ts:306-317` — scan 映射不透传 hops/top_k（服务端默认）
- **裁决①（二部图）**: KG 是实体-事件二部图，一条语义关系=两条边（实体→事件→实体）。"hops=1 单跳原则"指语义跳；映射层把 1 语义跳换算为 2 原始边。`hops: 2` 是换算不是例外。
- **裁决④**: scan 无透传，用 KG 服务端默认值。

- [ ] **Step 1: 通读** — 读 `src/agent/tools.ts` 全文；核实五工具各自在 `mapToMcpCall` 的实际透传参数（逐工具列表，写入文档"MCP 映射"列）
- [ ] **Step 2: 改 tools.ts 注释** — `150-154` 处 hops 描述改为（实际字符串以现有注释风格为准）：`hops 参数未暴露给 LLM：映射层按实体-事件二部图将 1 语义跳换算为 hops=2 传给 KG`
- [ ] **Step 3: 重写 tools.md** — 结构：状态头 → 五工具一览表 → 逐工具 schema（照代码）→ **MCP 映射表**（每工具实际透传值，含 trace hops=2 二部图换算说明、scan 无透传）→ 二部图 hops 换算小节（裁决①核心论述）。删除"3 个内存读取工具"全部章节
- [ ] **Step 4: 验证** — `grep -n "recall_\|内存读取\|top_k=10" design-docs/tools.md` 预期无匹配；`grep -n "二部图" design-docs/tools.md` 预期有；`source ~/.nvm/nvm.sh && npm run typecheck` 预期通过
- [ ] **Step 5: Commit** — `git add design-docs/tools.md src/agent/tools.ts && git commit -m "docs(design): rewrite tools.md — 5 tools, bipartite hops mapping (S2)"`

### Task 3 (S3): agent-loop.md 大改

**Files:**
- Rewrite: `design-docs/agent-loop.md`

**Interfaces:**
- Consumes: Task 1 的 completion_reason 枚举、预算模型
- Produces: v3 终止检查链权威描述（三重门/僵局/事件分类），Task 5/7 引用

**源码事实：**
- `src/agent/loop.ts:65` — `MAX_EXPLORING_STEPS = 20`；FINALIZE 步数上限 2（照代码核实）
- `src/agent/loop.ts:195-207` — 并行预检阈值 30%/50%
- `src/agent/loop.ts:211-217` — 工具优先级 expand > trace > lookup = timeline > scan
- `src/agent/loop.ts:798-830` — sufficient 三重门：MIN_FINDINGS / 近期产出 / 30% 实体覆盖（照代码核实具体阈值）
- `src/agent/loop.ts` — 2 轮僵局(stalemate)逻辑（搜 stalemate/僵局，核实轮数与动作）
- `src/agent/loop.ts:1281` 附近 — LLM 事件分类步骤（批量分类进 raw_event_archive，引 data-taxonomy.md）
- `src/agent/loop.ts:1106-1117, 1402-1411` — FINALIZE 三路径降级
- `src/agent/error-handler.ts:48-63` — extractStopSignal
- **裁决②**: `max_depth` 当前仅记录不生效（`state.depth` 从不被读）；删除 v2 文档的"depth >= max_depth 终止"条件，写明已知缺口
- 已匹配项照旧：per-tool token 估算（loop.ts:71-77）、FINALIZE 线程验证表（threads.ts:46-111）

- [ ] **Step 1: 通读** — `src/agent/loop.ts` 重点 60-220、780-840、930-1010、1090-1130、1270-1300、1390-1420；`src/agent/error-handler.ts` 全文
- [ ] **Step 2: 重写 agent-loop.md** — 结构：状态头 → 循环总览 → EXPLORING 每步（决策/预检/优先级/token 估算/事件分类）→ **终止条件链**（步数/预算/三重门 sufficient/僵局/stop signal，各配实际阈值；明确 max_depth 不生效）→ FINALIZE 流程与三路径降级。删除 depth 终止条件与温层引用
- [ ] **Step 3: 验证** — `grep -n "max_depth" design-docs/agent-loop.md` 预期命中处均写明"不生效/已知缺口"；`grep -n "event_buffer\|温层" design-docs/agent-loop.md` 预期无匹配
- [ ] **Step 4: Commit** — `git add design-docs/agent-loop.md && git commit -m "docs(design): rewrite agent-loop.md — actual termination chain (S3)"`

### Task 4 (S4): findings.md + event-threads.md

**Files:**
- Modify: `design-docs/findings.md`（中改）
- Modify: `design-docs/event-threads.md`（小改）

**Interfaces:**
- Consumes: Task 1 三分流命名
- Produces: flag_target 三分流路由规则描述

**源码事实：**
- `src/agent/findings.ts:29-52` — `shouldExtractFindings` 触发（step 3/5/每3步 + 策略切换 + sufficient；**无**"意外发现"触发）
- `src/agent/findings.ts:118-136` — 去重阈值 50%/60%
- `src/agent/findings.ts:138-149` — 矛盾规则
- `src/agent/findings.ts:153-158` — 事件权重 ×1.0/×0.8/×0.4/×0.6
- `src/agent/findings.ts:169-180` — confidence 表（现文档已逐字一致，保留）
- `src/agent/findings.ts:192-227` — `flag_target` 三分流路由（文档缺失，补）
- `src/agent/findings.ts:251-254` — **裁决③**：无证据 finding 直接丢弃（删除 v2"暂存 low_confidence_findings"表述，写明与 AGENTS.md 证据约束一致）
- `src/agent/threads.ts:46-111` — 验证规则（与现文档一致，保留）；`56-67` streaming_snapshot 过滤（校验 1b，补入）

- [ ] **Step 1: 通读** — `src/agent/findings.ts`、`src/agent/threads.ts` 全文
- [ ] **Step 2: 改 findings.md** — 加状态头；补 flag_target 路由小节；触发条件对齐实现（删"意外发现"）；无证据处理改"丢弃"；术语 event_buffer→raw_event_archive；confidence 表保留
- [ ] **Step 3: 改 event-threads.md** — 加状态头；全文 event_buffer→raw_event_archive；校验规则表补 1b streaming_snapshot 行
- [ ] **Step 4: 验证** — `grep -n "low_confidence" design-docs/findings.md` 预期无匹配；`grep -n "event_buffer" design-docs/event-threads.md` 预期无匹配；`grep -n "flag_target" design-docs/findings.md` 预期有
- [ ] **Step 5: Commit** — `git add design-docs/findings.md design-docs/event-threads.md && git commit -m "docs(design): findings flag_target routing + threads streaming filter (S4)"`

### Task 5 (S5): context-assembly.md + error-handling.md

**Files:**
- Rewrite: `design-docs/context-assembly.md`
- Modify: `design-docs/error-handling.md`（中改）

**Interfaces:**
- Consumes: Task 3 的四级压缩阶梯、Task 1 预算模型
- Produces: 上下文组装与降级路径权威描述

**源码事实：**
- `src/agent/context.ts:60-66` — 预算分层注入 <50%/50-70%/>70%（保留）
- `src/agent/context.ts:58` — expand 全文例外；`71-73` — 4k 硬上限
- `src/agent/context.ts:6, 399-400` — FINALIZE 全量 `raw_event_archive` 注入（非"摘要"）
- `src/agent/loop.ts:939-976` — 四级阶梯：85% 压缩 / 90% 警告 / 95% 再压缩 / 100% 强制收敛（替换 80/90/100）
- `src/agent/loop.ts:960-973` — 85% exploration_log 压缩路径
- `src/agent/loop.ts:1536-1553` — 对话历史全量回放（非"仅决策摘要"，照实改）
- `src/agent/loop.ts:1000-1010` — MCP 不可用→立即返回降级（替换 v2"降级到 recall 工具"）
- `src/agent/error-handler.ts:163-186` — FINALIZE 降级与决策循环打破（保留）

- [ ] **Step 1: 通读** — `src/agent/context.ts` 全文；`src/agent/loop.ts:930-1010、1530-1560`
- [ ] **Step 2: 重写 context-assembly.md** — 状态头 → 三池预算（config 驱动+78/16/6）→ State View 分层注入 → 4k 上限与 expand 例外 → 四级压缩阶梯 → FINALIZE 全量注入 → 对话历史回放策略。删除温层/召回工具表/驱逐/冷层章节
- [ ] **Step 3: 改 error-handling.md** — 状态头；删 recall 异常段；MCP 不可用改立即降级；预算梯度改 85/90/95/100；FINALIZE 三路径保留
- [ ] **Step 4: 验证** — `grep -n "recall\|温层\|冷层\|驱逐" design-docs/context-assembly.md design-docs/error-handling.md` 预期无匹配；`grep -n "85%" design-docs/error-handling.md` 预期有
- [ ] **Step 5: Commit** — `git add design-docs/context-assembly.md design-docs/error-handling.md && git commit -m "docs(design): context assembly + error handling for v3 (S5)"`

### Task 6 (S6): system-prompt.md 重构

**Files:**
- Rewrite: `design-docs/system-prompt.md`

**Interfaces:**
- Consumes: Task 1/3/4 的术语与流程描述
- Produces: "结构+意图+引用源码"模式（不复制 prompt 全文）

**源码事实：**
- `src/agent/prompt.ts` — 全部段落锚点：17-32 实体旗标警告注入、34-61 运行时时间上下文、96-113 Layer 3A 状态字段、118 结构化推理格式、132 new_findings 含 flag_target、156 frontier"提醒清单不是约束"、183-199 FINALIZE 段（[事实]/[指标]/[快照] 标签）
- 现文档六层结构与多数层文本描述保留；FINALIZE 段两处 event_buffer 术语与上述 5 个缺失段落是本任务主对象

- [ ] **Step 1: 通读** — `src/agent/prompt.ts` 全文，为每层标注行号锚点
- [ ] **Step 2: 重构 system-prompt.md** — 状态头 → 六层结构总览表（层名/激活时机/设计意图/`prompt.ts` 行号锚点）→ 逐层：设计意图段落 + "正文源：prompt.ts:<lines>"；删除全部逐字 prompt 文本复制。新增段落说明：旗标警告、时间上下文、Layer 3A、结构化推理、flag_target、frontier 提醒
- [ ] **Step 3: 验证** — `grep -n "event_buffer" design-docs/system-prompt.md` 预期无匹配；`grep -c "prompt.ts" design-docs/system-prompt.md` 预期 ≥6
- [ ] **Step 4: Commit** — `git add design-docs/system-prompt.md && git commit -m "docs(design): system-prompt.md — structure + intent, source refs (S6)"`

### Task 7 (S7): agent-card.md + 对外宣传修正

**Files:**
- Modify: `design-docs/agent-card.md`
- Modify: `README.md`、`skills/fin-trace.md`、`AGENTS.md`（表述级修正）

**Interfaces:**
- Consumes: Task 1 的枚举/键名、Task 2 的二部图表述、Task 3 的 max_depth 缺口

**源码事实：**
- `src/a2a/agent-card.ts:15-38` — name/skill/tags（含 `financial-analysis`）；`16-19` `pushNotifications: false`
- `src/a2a/handler.ts:418-439` — tasks/send|sendSubscribe|get|cancel；`87-91` DataPart {goal, seed_entities, max_depth}
- `src/agent/state.ts:38` — completion_reason 实际枚举；`state.ts:233` — time_span {earliest,latest}
- **裁决②对外修正**: README.md"depth=1 约 3-5min/depth=2 约 5-12min"（两处 + 它做什么图）、agent-card.md 深度延时宣传、skills/fin-trace.md 如有 depth 延时/深度语义承诺均改：探索时长由步数/预算/门控决定，max_depth 当前不生效
- AGENTS.md「Single-hop tool primitives」句改写为语义跳表述（引二部图换算）

- [ ] **Step 1: 通读** — `src/a2a/agent-card.ts`、`src/a2a/handler.ts:80-130, 410-440`；grep 三份对外文档的 depth/hops 表述定位
- [ ] **Step 2: 改 agent-card.md** — 状态头；capabilities 补 pushNotifications；tags 补 financial-analysis；completion_reason 全枚举照 state.ts:38；time_span 改 {earliest,latest}；删 depth 延时宣传
- [ ] **Step 3: 改 README.md / skills/fin-trace.md** — depth 延时表述替换为"时长由步数预算与充分性门控决定（约 3-12 分钟）"类表述；hops=1 相关句补"（语义跳；KG 二部图映射为 2 边，详见 design-docs/tools.md）"
- [ ] **Step 4: 改 AGENTS.md** — "Single-hop tool primitives" 条目改为：每个工具一次一**语义跳**（KG 实体-事件二部图中映射为 hops=2 原始边）；多跳由 Agent Loop 组合涌现
- [ ] **Step 5: 验证** — `grep -rn "depth=1\|depth=2" README.md skills/fin-trace.md design-docs/agent-card.md` 预期无延时承诺残留；`grep -n "earliest" design-docs/agent-card.md` 预期有
- [ ] **Step 6: Commit** — `git add design-docs/agent-card.md README.md skills/fin-trace.md AGENTS.md && git commit -m "docs(design): agent-card contract + external claims alignment (S7)"`

### Task 8 (S8): 防漂移机制落地 + 终验

**Files:**
- Modify: `AGENTS.md`（Implementation Fidelity 加一条约束）
- Modify: `design-docs/README.md`（撤漂移警告、索引去 ⚠️、已重写文档标注）

**Interfaces:**
- Consumes: S1-S7 全部完成状态

- [ ] **Step 1: AGENTS.md 加约束** — 「Implementation Fidelity（实现保真）」小节末尾加：`- PRs that change agent-core behavior must update the corresponding design doc in the same PR and refresh its alignment SHA (状态头"已对齐").`
- [ ] **Step 2: design-docs/README.md 清理** — 删除"⚠️ 文档漂移警告"整节；索引表各行去 ⚠️ 标注；九份文档行保持指向（they now all carry 状态头）
- [ ] **Step 3: 终验（spec §七验收标准逐条）**
  - `grep -rn "event_buffer\|low_confidence_findings\|event_archive" design-docs/ --include="*.md" | grep -v archive/ | grep -v three-tier | grep -v 术语基线` 预期：仅术语基线表与 v2 差异说明行
  - `grep -rn "recall_" design-docs/ --include="*.md" | grep -v archive/ | grep -v three-tier | grep -v 术语基线` 预期同上
  - agent-card.md 枚举/键名与 state.ts 抽查一致（目测 diff）
  - `grep -L "已对齐" design-docs/{state,tools,agent-loop,findings,event-threads,context-assembly,error-handling,system-prompt,agent-card}.md` 预期输出为空（九份全带状态头）
  - `source ~/.nvm/nvm.sh && npm run typecheck` 通过
- [ ] **Step 4: Commit** — `git add AGENTS.md design-docs/README.md && git commit -m "docs(design): drift-prevention mechanism + final verification (S8)"`
- [ ] **Step 5: 汇报** — push 分支并提示可建 PR（`git push -u origin docs/design-docs-v3-alignment`，是否建 PR 由用户定）
