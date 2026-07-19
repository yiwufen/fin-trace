// 探索质量 - 召回层（需 ground truth，Recall 为主）。
import type {
  StateView, RecallReport, AuditPending, AuditPendingItem,
  GroundTruth, FindingImportance,
} from "../types.js";
import { matchFinding, matchThread, isApproximateCandidate } from "./lib/match-rule.js";

export interface RecallComputeInput {
  view: StateView;
  groundTruth: GroundTruth;
}

export interface RecallComputeOutput {
  report: RecallReport;
  audit: AuditPending;
}

export function computeRecall(input: RecallComputeInput): RecallComputeOutput {
  const { view, groundTruth } = input;
  const agentFindings = view.agent_findings;
  const agentThreads = view.agent_threads;

  // ─── Finding recall ───
  const buckets: Record<FindingImportance, { hit: number; total: number }> = {
    must_find: { hit: 0, total: 0 },
    should_find: { hit: 0, total: 0 },
    nice_to_find: { hit: 0, total: 0 },
  };
  const auditItems: AuditPendingItem[] = [];

  for (const gt of groundTruth.known_findings) {
    buckets[gt.importance].total += 1;
    const result = matchFinding(gt, agentFindings);
    if (result.matched) {
      buckets[gt.importance].hit += 1;
    } else if (result.matched_finding_id && isApproximateCandidate(result.rule_scores)) {
      // 近似但未命中 → 写入 audit-pending
      const candidate = agentFindings.find((f) => f.id === result.matched_finding_id);
      auditItems.push({
        gt_id: gt.id,
        gt_statement: gt.statement,
        gt_importance: gt.importance,
        candidate_finding_id: result.matched_finding_id,
        candidate_statement: candidate?.statement ?? null,
        rule_scores: result.rule_scores,
        verdict: "unjudged",
      });
    } else {
      // 完全未命中且无近似候选 → 也写入 audit-pending（candidate_finding_id = null）
      auditItems.push({
        gt_id: gt.id,
        gt_statement: gt.statement,
        gt_importance: gt.importance,
        candidate_finding_id: null,
        candidate_statement: null,
        rule_scores: result.rule_scores,
        verdict: "unjudged",
      });
    }
  }

  // ─── Thread recall ───
  let threadFull = 0;
  let threadFullPartial = 0;
  for (const gt of groundTruth.known_threads) {
    let best: "mismatch" | "partial" | "full" = "mismatch";
    for (const at of agentThreads) {
      const kind = matchThread(gt, at);
      if (kind === "full") { best = "full"; break; }
      if (kind === "partial" && best === "mismatch") best = "partial";
    }
    if (best === "full") {
      threadFull += 1;
      threadFullPartial += 1;
    } else if (best === "partial") {
      threadFullPartial += 1;
    }
  }

  // ─── known_false 触发检测 ───
  let knownFalseTriggered = 0;
  for (const fp of groundTruth.known_false) {
    const re = safeRegex(fp.pattern);
    for (const f of agentFindings) {
      const text = `${f.statement} ${f.entities_involved.join(" ")}`;
      if (re?.test(text)) {
        knownFalseTriggered += 1;
        break;  // 每个 false pattern 只计一次
      }
    }
  }

  const report: RecallReport = {
    recall_must: buckets.must_find,
    recall_should: buckets.should_find,
    recall_nice: buckets.nice_to_find,
    thread_full_rate: { full: threadFull, total: groundTruth.known_threads.length },
    thread_full_partial_rate: { full_partial: threadFullPartial, total: groundTruth.known_threads.length },
    known_false_triggered: knownFalseTriggered,
    reliability_note: view.reliability_note,
  };

  const audit: AuditPending = {
    scenario: groundTruth.scenario,
    items: auditItems,
  };

  return { report, audit };
}

function safeRegex(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern);
  } catch {
    // pattern 不是合法 regex —— 退化为子串匹配
    try {
      return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    } catch {
      return null;
    }
  }
}
