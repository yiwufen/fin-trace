// 隔离层：从 ExplorationState + ExplorationOutput 提取扁平 StateView。
// metrics 模块只依赖 StateView，绝不直接 import src/agent/state。
import type { ExplorationOutput, ExplorationState, SerializedState, Finding, EventThread } from "../../../src/agent/state.js";
import { deserializeState } from "../../../src/agent/state.js";
import type { StateView, AgentFindingView, AgentThreadView, ThreadRelType } from "../../types.js";

export interface StateViewInput {
  output: ExplorationOutput;
  state: ExplorationState | SerializedState;   // 接受两种形式
}

export function buildStateView(input: StateViewInput): StateView {
  const { output } = input;
  const state: ExplorationState =
    isSerializedState(input.state) ? deserializeState(input.state) : input.state;

  // 分母：raw_event_archive 里的 ku_id
  const raw_event_archive_ku_ids = (state.raw_event_archive ?? [])
    .map((e) => e.ku_id)
    .filter((k): k is string => typeof k === "string");

  // 分子：进入任一 thread 的 ku_id（去重）
  const threads: EventThread[] = output.event_threads ?? [];
  const thread_ku_id_set = new Set<string>();
  const per_thread_ku_ids: string[][] = [];
  for (const t of threads) {
    const kuIds = (t.thread_events ?? []).map((e) => e.ku_id).filter((k): k is string => !!k);
    per_thread_ku_ids.push(kuIds);
    for (const k of kuIds) thread_ku_id_set.add(k);
  }
  const thread_ku_ids = [...thread_ku_id_set];

  // ku_id 存证率来源
  const findings_evidence_ku_ids = uniq(
    (output.findings ?? []).flatMap((f) => f.evidence ?? []),
  );

  // thread 关系类型
  const thread_relationships: ThreadRelType[] = threads.flatMap((t) =>
    (t.relationships ?? []).map((r) => r.type as ThreadRelType),
  );

  // agent_findings 投影
  const agent_findings: AgentFindingView[] = (output.findings ?? []).map((f: Finding) => ({
    id: f.id,
    statement: f.statement,
    category: f.category,
    confidence: f.confidence,
    entities_involved: f.entities_involved ?? [],
    evidence: f.evidence ?? [],
  }));

  // agent_threads 投影
  const agent_threads: AgentThreadView[] = threads.map((t: EventThread) => ({
    id: t.id,
    title: t.title,
    thread_event_ku_ids: (t.thread_events ?? []).map((e) => e.ku_id),
    relationships: (t.relationships ?? []).map((r) => ({
      from_idx: r.from_idx,
      to_idx: r.to_idx,
      type: r.type as ThreadRelType,
    })),
  }));

  return {
    raw_event_archive_ku_ids,
    thread_ku_ids,
    findings_evidence_ku_ids,
    thread_relationships,
    per_thread_ku_ids,
    reliability_note: state.reliability_note ?? output.exploration_meta?.reliability_note ?? null,
    agent_findings,
    agent_threads,
  };
}

function isSerializedState(s: unknown): s is SerializedState {
  return (
    typeof s === "object" && s !== null &&
    "raw_event_archive" in s &&
    Array.isArray((s as SerializedState).frontier) &&
    // SerializedState 用数组存 Map，ExplorationState 用 Map —— 靠 visited 字段类型区分
    Array.isArray((s as SerializedState).visited)
  );
}

function uniq<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}
