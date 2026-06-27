// State 接口定义 — v3: 五意图重构
//
// 核心变化（相对于 v2 三层架构）:
// - 删除 event_buffer / event_archive，改为 raw_event_archive（仅 FINALIZE 注入）
// - 拆解 key_findings 为 entity_flags / cluster_flags / key_insights 三层
// - FrontierEntity 从优先级排序改为准入控制（去 priority，source_reason 必填）
// - 删除 recall 工具类型（不再需要温层读取）
// - 删除 CompressedResults / HistoryStep 等分段压缩类型

// ─── 时间上下文（运行时注入，解决"今天"数据的时效性对齐）───

export interface TemporalContext {
  current_time: string;       // "2026-06-04 14:35 CST"
  is_trading_day: boolean;
  market_session: "pre_market" | "open" | "closed" | "holiday";
  weekday: string;            // "周三"
}

// ─── 探索入口 ───

export interface ExplorationInput {
  goal: string;
  seed_entities: string[];
  session_id?: string;
  time_range?: string;
  max_depth?: number;
  max_steps?: number;
  max_tokens?: number;
  relation_filters?: string[];
}

// ─── 探索出口 ───

export interface ExplorationOutput {
  findings: Finding[];
  event_threads: EventThread[];
  exploration_meta: {
    completion_reason: "sufficient" | "depth_exhausted" | "token_budget" | "frontier_empty" | "diminishing_returns" | "cancelled" | "mcp_unavailable";
    stats: {
      steps: number;
      entities_visited: number;
      findings_count: number;
      events_buffered: number;
      tokens_used: number;
    };
    exploration_log: LogEntry[];
    reliability_note: string | null;
  };
}

// ─── 核心状态 ───

export interface ExplorationState {
  // ─── 探索图状态 ───
  visited: Map<string, EntitySummary>;
  frontier: FrontierEntity[];
  paths: Map<string, EntityPath>;

  // ─── 三层发现存储 ───
  entity_flags: EntityFlag[];           // 基础设施告警，代码保障，注入 Prompt
  cluster_flags: ClusterFlag[];         // 数据质量标记，随 cluster 数据绑定
  key_insights: Finding[];              // 跨轮合成洞察，LLM 自由消费

  // ─── 原始事件归档（仅 FINALIZE 注入）───
  raw_event_archive: RawEvent[];

  // ─── 探索日志 ───
  exploration_log: LogEntry[];

  // ─── 预算 ───
  budget: ExplorationBudget;

  // ─── 循环控制 ───
  step_count: number;
  depth: number;
  phase: "EXPLORING" | "FINALIZE";
  mcp_degraded: boolean;
  force_strategy?: "expand" | "deep_dive" | "verify";
  force_sufficient: boolean;
  injectHint?: string;

  // ─── 决策历史 ───
  last_n_decisions: string[];
  last_n_finding_counts: number[];

  // ─── 工具调用状态 ───
  known_clusters: Set<string>;
  nameIndex: Map<string, string>;
  last_tool_results_raw: ToolResult[];
  tool_call_failures: number;
  token_warnings: number;

  // ─── 输出阶段 ───
  final_findings?: Finding[];
  event_threads?: EventThread[];
  reliability_note?: string;

  // ─── 时间上下文（运行时注入）───
  temporal_context?: TemporalContext;
}

// ─── EntitySummary — visited 中每个实体的摘要 ───

export interface EntitySummary {
  entity_id?: string;
  name: string;
  aliases: string[];
  type: "company" | "person" | "organization" | "product" | "unknown";
  related_events_count: number;
  event_types: string[];
  clusters_count: number;
  discovered_at_step: number;
  key_relations?: string[];
}

// ─── EntityFlag — 基础设施告警，代码保障注入 Prompt ───

export interface EntityFlag {
  entity_name: string;
  flag_type: "unreliable_mapping";
  description: string;
  source_step: number;
}

// ─── ClusterFlag — 数据质量标记，随 cluster 数据绑定 ───

export interface ClusterFlag {
  cluster_id: string;
  flag_type: "data_conflict";
  description: string;
  source_step: number;
}

// ─── EventDataType — 金融 KG 数据的三类本质 ───

export type EventDataType =
  | "structural_fact"     // 结构性事实：制裁、并购、财报、高管变更 — 不可变，可入因果链
  | "streaming_snapshot"  // 流式快照：盘中行情、实时报价 — 高度可变，不入因果链
  | "aggregate_metric"    // 聚合指标：收盘价、营收、PE — 可被更新，作为因果链终结节点
  | "unknown";            // 无法分类

// ─── RawEvent — 归档的原始事件（仅 FINALIZE 使用）───

export interface RawEvent {
  ku_id: string;
  entity: string;
  event_type: string;
  timestamp: string;
  description: string;
  cluster_id?: string;
  source_step: number;
  event_data_type: EventDataType;
}

// ─── ExplorationBudget ───

export interface ExplorationBudget {
  total: number;
  exploring_limit: number;
  finalize_reserved: number;
  headroom: number;
  used_tokens: number;
}

// ─── ToolResult — 单次工具调用结果 ───

export interface ToolResult {
  tool_name: McpToolName;
  args: Record<string, unknown>;
  success: boolean;
  error?: string;
  data: unknown;
  knowledge_units?: KU[];
  clusters?: Cluster[];
  entities?: EntityProfile[];
  total_count: number;
}

// ─── 工具名称（仅 5 个 MCP 工具）───

export const MCP_TOOL_NAMES = ["lookup", "trace", "timeline", "expand", "scan"] as const;
export type McpToolName = (typeof MCP_TOOL_NAMES)[number];

// ─── KU / Cluster / EntityProfile — MCP 返回子结构 ───

export interface KU {
  ku_id: string;
  entities: Array<{ mention: string; entity_id?: string; entity_type?: string; role?: string }>;
  unit_type?: string;
  time?: { event_time?: string; published_at?: string };
  summary?: string;
  description?: string;
  cluster_id?: string;
}

export interface Cluster {
  cluster_id: string;
  members?: unknown[];
  summary?: string;
}

export interface EntityProfile {
  entity_id?: string;
  canonical_name: string;
  name?: string;
  entity_type?: string;
  aliases?: string[];
}

// ─── Finding ───

export interface Finding {
  id: string;
  category: "pattern_violation" | "concentration" | "chain" | "absence";
  statement: string;
  confidence: "high" | "medium" | "low";
  evidence: string[];
  entities_involved: string[];
  relation_to_goal: string;
  discovered_at_step: number;
  conflict_with?: string;
}

// ─── EventThread, ThreadEvent, ThreadRelation ───

export interface EventThread {
  id: string;
  title: string;
  summary: string;
  narrative: string;
  thread_events: ThreadEvent[];
  relationships: ThreadRelation[];
  time_span: { earliest: string; latest: string };
  confidence: "high" | "medium" | "low";
  source_finding_ids: string[];
}

export interface ThreadEvent {
  ku_id: string;
  entity: string;
  event_type: string;
  timestamp: string;
  description: string;
}

export interface ThreadRelation {
  from_idx: number;
  to_idx: number;
  type: "causal" | "temporal" | "entity_shared" | "contradiction";
  reasoning: string;
}

// ─── FrontierEntity ───

export interface FrontierEntity {
  entity_id?: string;
  name: string;
  source: string;
  source_reason: string;              // 必填：为什么引入此实体
  type?: "company" | "person" | "organization" | "product";
  mention_count?: number;
}

// ─── EntityPath ───

export interface EntityPath {
  from: string;
  to: string;
  hops: number;
  intermediate_entities: string[];
  intermediate_events: string[];
  discovered_at_step: number;
}

// ─── LogEntry ───

export interface LogEntry {
  step: number;
  phase: "EXPLORING" | "FINALIZE";
  decision: string;
  tool_calls_count: number;
  new_findings_count: number;
  exception?: {
    type: "mcp_timeout" | "mcp_empty" | "mcp_error" | "llm_format" | "llm_hallucination" | "llm_loop";
    target: string;
    recovery: "retry" | "fallback" | "skip" | "abort";
    impact: string;
  };
  strategy_switch?: {
    from: string;
    to: string;
    reason: string;
  };
}

// ─── StepEvent — loop 每步完成时向前端推送的事件 ───

export type StepEventType = "step_complete" | "finding" | "analyzing_events" | "extracting_findings" | "building_threads" | "validating" | "finalize" | "error";

export interface StepEvent {
  type: StepEventType;
  step: number;
  phase: "EXPLORING" | "FINALIZE";
  decision?: string;
  tools_used?: McpToolName[];
  new_entities?: string[];
  new_findings_count?: number;
  total_findings?: number;
  total_entities?: number;
  total_events?: number;
  budget_used?: number;
  budget_limit?: number;
  // finalize 时传完整产出
  findings?: Finding[];
  event_threads?: EventThread[];
  exploration_meta?: ExplorationOutput["exploration_meta"];
  // error
  error?: string;
  // 分析阶段中间步骤
  detail?: string;
  events_analyzed?: number;
  findings_extracted?: number;
  findings_dropped?: number;
  threads_built?: number;
  threads_dropped?: number;
  // 聊天 SSE 上下文（外层 loop 注入）
  tool_use_id?: string;
}

// ─── State 序列化 — Map/Set → JSON-safe 平面结构 ───

export interface SerializedState {
  visited: [string, EntitySummary][];
  frontier: FrontierEntity[];
  paths: [string, EntityPath][];
  entity_flags: EntityFlag[];
  cluster_flags: ClusterFlag[];
  key_insights: Finding[];
  raw_event_archive: RawEvent[];
  exploration_log: LogEntry[];
  budget: ExplorationBudget;
  step_count: number;
  depth: number;
  phase: "EXPLORING" | "FINALIZE";
  mcp_degraded: boolean;
  force_strategy?: "expand" | "deep_dive" | "verify";
  force_sufficient: boolean;
  injectHint?: string;
  last_n_decisions: string[];
  last_n_finding_counts: number[];
  known_clusters: string[];
  nameIndex: [string, string][];
  last_tool_results_raw: ToolResult[];
  tool_call_failures: number;
  token_warnings: number;
  final_findings?: Finding[];
  event_threads?: EventThread[];
  reliability_note?: string;
  temporal_context?: TemporalContext;
}

export function serializeState(state: ExplorationState): SerializedState {
  return {
    visited: [...state.visited.entries()],
    frontier: state.frontier,
    paths: [...state.paths.entries()],
    entity_flags: state.entity_flags,
    cluster_flags: state.cluster_flags,
    key_insights: state.key_insights,
    raw_event_archive: state.raw_event_archive,
    exploration_log: state.exploration_log,
    budget: state.budget,
    step_count: state.step_count,
    depth: state.depth,
    phase: state.phase,
    mcp_degraded: state.mcp_degraded,
    force_strategy: state.force_strategy,
    force_sufficient: state.force_sufficient,
    injectHint: state.injectHint,
    last_n_decisions: state.last_n_decisions,
    last_n_finding_counts: state.last_n_finding_counts,
    known_clusters: [...state.known_clusters],
    nameIndex: [...state.nameIndex.entries()],
    last_tool_results_raw: state.last_tool_results_raw,
    tool_call_failures: state.tool_call_failures,
    token_warnings: state.token_warnings,
    final_findings: state.final_findings,
    event_threads: state.event_threads,
    reliability_note: state.reliability_note,
    temporal_context: state.temporal_context,
  };
}

export function deserializeState(s: SerializedState): ExplorationState {
  return {
    visited: new Map(s.visited),
    frontier: s.frontier,
    paths: new Map(s.paths),
    entity_flags: s.entity_flags,
    cluster_flags: s.cluster_flags,
    key_insights: s.key_insights,
    raw_event_archive: s.raw_event_archive,
    exploration_log: s.exploration_log,
    budget: s.budget,
    step_count: s.step_count,
    depth: s.depth,
    phase: s.phase,
    mcp_degraded: s.mcp_degraded,
    force_strategy: s.force_strategy,
    force_sufficient: s.force_sufficient,
    injectHint: s.injectHint,
    last_n_decisions: s.last_n_decisions,
    last_n_finding_counts: s.last_n_finding_counts,
    known_clusters: new Set(s.known_clusters),
    nameIndex: new Map(s.nameIndex),
    last_tool_results_raw: s.last_tool_results_raw,
    tool_call_failures: s.tool_call_failures,
    token_warnings: s.token_warnings,
    final_findings: s.final_findings,
    event_threads: s.event_threads,
    reliability_note: s.reliability_note,
    temporal_context: s.temporal_context,
  };
}
