// 前端类型定义 — 与后端 state.ts / session-store.ts 对齐

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

// ─── EventThread ───

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

// ─── ExplorationOutput ───

export interface ExplorationOutput {
  findings: Finding[];
  event_threads: EventThread[];
  exploration_meta: {
    completion_reason: string;
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

export interface LogEntry {
  step: number;
  phase: "EXPLORING" | "FINALIZE";
  decision: string;
  tool_calls_count: number;
  new_findings_count: number;
}

// ─── Session / Exploration ───

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  explorations: Exploration[];
  messages?: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  explorations: Exploration[];
}

export interface Exploration {
  id: string;
  goal: string;
  seed_entities: string[];
  max_depth: number;
  status: "running" | "completed" | "error" | "cancelled";
  output: ExplorationOutput | null;
  steps: StepSnapshot[];
  started_at: string;
  completed_at: string | null;
}

export interface StepSnapshot {
  step: number;
  phase: "EXPLORING" | "FINALIZE";
  decision?: string;
  tools_used?: string[];
  new_entities?: string[];
  new_findings_count?: number;
  total_findings?: number;
  total_entities?: number;
  total_events?: number;
}

// ─── SSE 事件 ───

export interface StepEvent {
  type: "step_complete" | "finding" | "analyzing_events" | "extracting_findings" | "building_threads" | "validating" | "finalize" | "error";
  step: number;
  phase: "EXPLORING" | "FINALIZE";
  decision?: string;
  tools_used?: string[];
  new_entities?: string[];
  new_findings_count?: number;
  total_findings?: number;
  total_entities?: number;
  total_events?: number;
  budget_used?: number;
  budget_limit?: number;
  findings?: Finding[];
  event_threads?: EventThread[];
  exploration_meta?: ExplorationOutput["exploration_meta"];
  error?: string;
  // 分析阶段中间步骤
  detail?: string;
  events_analyzed?: number;
  findings_extracted?: number;
  findings_dropped?: number;
  threads_built?: number;
  threads_dropped?: number;
  // 聊天 SSE 上下文（外层 loop 注入，用于路由到对应 ToolSegment）
  tool_use_id?: string;
}

// ─── Turn Segment 模型 — 表示一个 turn 内的有序段序列 ───

export type TurnSegment = TextSegment | ToolSegment;

export interface TextSegment {
  type: "text";
  text: string;
  streaming: boolean;
}

export interface ToolSegment {
  type: "tool";
  tool_use_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  steps: StepEvent[];
  result: ExplorationSummary | null;
  status: "running" | "completed" | "error";
  error?: string;
}

// ─── API 请求类型 ───

export interface ExploreRequest {
  goal: string;
  seed_entities: string[];
  max_depth?: number;
}

export interface FollowupRequest {
  goal: string;
  extra_seeds?: string[];
}

// ─── 聊天类型（v3 外层对话）───

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ChatContentBlock[];
  created_at: string;
}

export type ChatContentBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface ExplorationSummary {
  goal: string;
  seed_entities: string[];
  findings: Finding[];
  event_threads: EventThread[];
  stats: {
    steps: number;
    entities_visited: number;
    findings_count: number;
    events_buffered: number;
    completion_reason: string;
  };
}

// ─── 聊天 SSE 事件类型 ───

export interface ToolStartEvent {
  tool_name: string;
  tool_use_id: string;
  args: Record<string, unknown>;
}

export interface ToolResultEvent {
  tool_name: string;
  tool_use_id: string;
  result?: ExplorationSummary;
  is_error?: boolean;
  error?: string;
}
