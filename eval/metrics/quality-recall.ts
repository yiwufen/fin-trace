// 探索质量 - 召回层（需 ground truth，Recall 为主）。
// 三层匹配（spec §3.3 修订）：alias cache → rule pre-filter → LLM-as-Judge
import type {
  StateView, RecallReport, AuditPending, AuditPendingItem,
  GroundTruth, FindingImportance,
} from "../types.js";
import { matchFinding, matchThread, type MatchContext } from "./lib/match-rule.js";

export interface RecallComputeInput {
  view: StateView;
  groundTruth: GroundTruth;
  /** 匹配上下文（spec §三）。run 模式下 scenarioDir 必填；report/单独 recall 子命令下可为 null（不写 cache） */
  matchContext: MatchContext;
}

export interface RecallComputeOutput {
  report: RecallReport;
  audit: AuditPending;
  /** 触发自动 alias 回填的项（gt_id + agent_statement），调用方写回 GT yaml */
  aliasBackfills: { gt_id: string; agent_statement: string }[];
}

export async function computeRecall(input: RecallComputeInput): Promise<RecallComputeOutput> {
  const { view, groundTruth, matchContext: ctx } = input;
  const agentFindings = view.agent_findings;
  const agentThreads = view.agent_threads;

  // ─── Finding recall ───
  const buckets: Record<FindingImportance, { hit: number; total: number }> = {
    must_find: { hit: 0, total: 0 },
    should_find: { hit: 0, total: 0 },
    nice_to_find: { hit: 0, total: 0 },
  };
  const auditItems: AuditPendingItem[] = [];
  const aliasBackfills: { gt_id: string; agent_statement: string }[] = [];

  for (const gt of groundTruth.known_findings) {
    buckets[gt.importance].total += 1;
    const result = await matchFinding(gt, agentFindings, ctx);
    if (result.matched) {
      buckets[gt.importance].hit += 1;
      // Layer 2 LLM 判 match/partial → 自动回填 alias
      if (result.shouldBackfillAlias && result.matched_finding_id) {
        const agentF = agentFindings.find((f) => f.id === result.matched_finding_id);
        if (agentF && !gt.aliases.includes(agentF.statement)) {
          gt.aliases.push(agentF.statement);
          aliasBackfills.push({ gt_id: gt.id, agent_statement: agentF.statement });
        }
      }
    } else {
      // 未命中 → 写入 audit-pending。
      // 区分两种 source：llm_judge_failed（需人工裁决）vs 其他（rule 已确认 no_match，记录供人工复核）
      const candidate = result.matched_finding_id
        ? agentFindings.find((f) => f.id === result.matched_finding_id) : null;
      auditItems.push({
        gt_id: gt.id,
        gt_statement: gt.statement,
        gt_importance: gt.importance,
        candidate_finding_id: result.matched_finding_id,
        candidate_statement: candidate?.statement ?? null,
        rule_scores: result.rule_scores,
        verdict: "unjudged",
        // source 字段供 worksheet 区分"LLM 调用失败"vs"规则判定 no_match"
        // AuditPendingItem 暂未加 source 字段，这里通过 reason 间接体现
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

  return { report, audit, aliasBackfills };
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
