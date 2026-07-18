// 评测阶段共享类型定义
// 本文件仅包含 export interface / export type，无逻辑代码。
// 由后续 task (state-view, metrics, run, judge, report) 共同消费。

// Mirror of ExplorationInput for YAML loading
export interface Scenario {
  id: string;
  goal: string;
  seed_entities: string[];
  max_depth: number;
  time_range?: string;
}

// ─── Ground truth (golden set) ───
export type FindingCategory = "pattern_violation" | "concentration" | "chain" | "absence";
export type FindingImportance = "must_find" | "should_find" | "nice_to_find";

export interface KnownFinding {
  id: string;
  statement: string;
  category: FindingCategory;
  importance: FindingImportance;
  key_entities: string[];
  min_evidence: number;
  aliases: string[]; // human-judgment 回填
}

export interface KnownThreadKeyEvent {
  ku_id: string;
}

export interface KnownThread {
  id: string;
  description: string;
  key_events: KnownThreadKeyEvent[]; // 有序
  causal_direction: "forward" | "reverse";
  aliases: string[];
}

export interface KnownFalsePattern {
  id: string;
  pattern: string; // regex or natural language
  why: string;
}

export interface GroundTruth {
  scenario: string;
  annotation_meta: {
    annotator: string;
    annotation_date: string;
    kg_scope: string;
    notes: string;
  };
  known_findings: KnownFinding[];
  known_threads: KnownThread[];
  known_false: KnownFalsePattern[];
}

// ─── StateView (produced by state-view.ts, Task 3) ───
export interface StateView {
  raw_event_archive_ku_ids: string[];
  thread_ku_ids: string[]; // 去重
  findings_evidence_ku_ids: string[];
  thread_relationships: ThreadRelType[];
  per_thread_ku_ids: string[][];
  reliability_note: string | null;
  agent_findings: AgentFindingView[];
  agent_threads: AgentThreadView[];
}
export type ThreadRelType = "causal" | "temporal" | "entity_shared" | "contradiction";

export interface AgentFindingView {
  id: string;
  statement: string;
  category: string;
  confidence: string;
  entities_involved: string[];
  evidence: string[];
}

export interface AgentThreadView {
  id: string;
  title: string;
  thread_event_ku_ids: string[]; // 有序
  relationships: { from_idx: number; to_idx: number; type: ThreadRelType }[];
}

// ─── Metrics outputs ───
export interface EfficiencyReport {
  useful_events_count: number; // 分子
  total_events_count: number; // 分母
  // NO ratio — computed only at scorecard render time
}

export interface StructuralQualityReport {
  ku_id_provenance: { matched: number; total: number }; // ratio = matched/total
  thread_causal_depth: { causal_temporal: number; total: number };
  thread_redundancy: number; // count of ku_ids appearing in >=2 threads
}

export interface RecallReport {
  recall_must: { hit: number; total: number };
  recall_should: { hit: number; total: number };
  recall_nice: { hit: number; total: number };
  thread_full_rate: { full: number; total: number };
  thread_full_partial_rate: { full_partial: number; total: number };
  known_false_triggered: number;
  reliability_note: string | null;
}

// ─── Audit pending (Task 5 副产物) ───
export interface AuditPendingItem {
  gt_id: string;
  gt_statement: string;
  gt_importance: FindingImportance;
  candidate_finding_id: string | null;
  rule_scores: { jaccard: number; keyword_overlap: number; category_match: boolean };
  verdict: "unjudged";
}
export interface AuditPending {
  scenario: string;
  items: AuditPendingItem[];
}

// ─── Run manifest ───
export interface RunManifest {
  run_id: string;
  timestamp: string; // ISO 8601
  git_sha: string;
  config_hash: string; // hash of config.json WITHOUT api keys
  llm_model: string;
  kg_endpoint: string;
  golden_set_sha: string; // git short sha of eval/golden/
}
