// 生成 scorecard.json + scorecard.md。比值在这里算（不在 metrics 层算）。
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  EfficiencyReport, StructuralQualityReport, RecallReport, RunManifest,
} from "../types.js";

export interface ScenarioScorecard {
  scenario: string;
  run_id: string;
  run_status: "ok" | "failed";
  efficiency: EfficiencyReport | null;
  structural: StructuralQualityReport | null;
  recall: RecallReport | null;
  audit_items_count: number;
  reliability_note: string | null;
  // 失败信息
  error?: string;
}

function readJsonIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

export function buildScenarioScorecard(
  runId: string,
  scenarioId: string,
): ScenarioScorecard {
  const base = resolve("eval/runs", runId, scenarioId);
  const errorPath = resolve(base, "run-error.json");
  if (existsSync(errorPath)) {
    const err = JSON.parse(readFileSync(errorPath, "utf-8"));
    return {
      scenario: scenarioId, run_id: runId, run_status: "failed",
      efficiency: null, structural: null, recall: null, audit_items_count: 0,
      reliability_note: null, error: err.error,
    };
  }

  const efficiency = readJsonIfExists(resolve(base, "metrics/efficiency.json")) as EfficiencyReport | null;
  const structural = readJsonIfExists(resolve(base, "metrics/quality-structural.json")) as StructuralQualityReport | null;
  const recall = readJsonIfExists(resolve(base, "metrics/quality-recall.json")) as RecallReport | null;
  const audit = readJsonIfExists(resolve(base, "audit-pending.json")) as { items: unknown[] } | null;

  return {
    scenario: scenarioId, run_id: runId, run_status: "ok",
    efficiency, structural, recall,
    audit_items_count: audit?.items?.length ?? 0,
    reliability_note: recall?.reliability_note ?? null,
  };
}

export interface BaselineWarning {
  field: "git_sha" | "config_hash" | "llm_model" | "kg_endpoint" | "golden_set_sha";
  severity: "yellow" | "red";
  current: string;
  baseline: string;
}

export function compareManifests(current: RunManifest, baseline: RunManifest): BaselineWarning[] {
  const warnings: BaselineWarning[] = [];
  const rules: { field: BaselineWarning["field"]; severity: "yellow" | "red" }[] = [
    { field: "git_sha", severity: "yellow" },
    { field: "config_hash", severity: "red" },
    { field: "llm_model", severity: "yellow" },
    { field: "kg_endpoint", severity: "red" },
    { field: "golden_set_sha", severity: "red" },
  ];
  for (const r of rules) {
    if (current[r.field] !== baseline[r.field]) {
      warnings.push({ ...r, current: current[r.field], baseline: baseline[r.field] });
    }
  }
  return warnings;
}

export function renderScenarioScorecardMd(sc: ScenarioScorecard): string {
  const lines: string[] = [];
  lines.push(`# Evaluation Scorecard — ${sc.scenario}`);
  lines.push("");
  lines.push("## 运行概要");
  lines.push("| 项目 | 值 |");
  lines.push("|------|----|");
  lines.push(`| Run ID | ${sc.run_id} |`);
  if (sc.run_status === "failed") {
    lines.push(`| Status | ❌ failed |`);
    lines.push(`| Error | ${sc.error ?? "unknown"} |`);
    lines.push("");
    lines.push("> 该场景 run 失败，所有指标为 null。");
    return lines.join("\n");
  }
  if (sc.reliability_note) {
    lines.push(`| Reliability Note | ${sc.reliability_note} |`);
  }

  // 探索效率
  lines.push("");
  lines.push("## 探索效率");
  lines.push("| 项目 | 值 | 状态 |");
  lines.push("|------|----|------|");
  if (sc.efficiency) {
    const ratio = sc.efficiency.total_events_count === 0
      ? 0
      : sc.efficiency.useful_events_count / sc.efficiency.total_events_count;
    lines.push(`| Useful Events | ${sc.efficiency.useful_events_count} | |`);
    lines.push(`| Total Events | ${sc.efficiency.total_events_count} | |`);
    lines.push(`| Efficiency Ratio | ${sc.efficiency.useful_events_count}/${sc.efficiency.total_events_count} (${(ratio * 100).toFixed(1)}%) | ${ratio < 0.1 && sc.reliability_note ? "⚠️ 看可靠性说明" : ""} |`);
  } else {
    lines.push(`| Efficiency | null | ⚠️ 未计算 |`);
  }

  // 结构层
  lines.push("");
  lines.push("## 探索质量 - 结构层");
  lines.push("| 指标 | 值 | 状态 |");
  lines.push("|------|----|------|");
  if (sc.structural) {
    const prov = sc.structural.ku_id_provenance;
    const provRatio = prov.total === 0 ? 1 : prov.matched / prov.total;
    lines.push(`| ku_id 存证率 | ${prov.matched}/${prov.total} (${(provRatio * 100).toFixed(0)}%) | ${provRatio === 1 ? "✅" : "🔴 <100% 是 agent 代码 bug"} |`);
    const depth = sc.structural.thread_causal_depth;
    const depthRatio = depth.total === 0 ? 0 : depth.causal_temporal / depth.total;
    lines.push(`| Thread 因果深度 | ${depth.causal_temporal}/${depth.total} (${(depthRatio * 100).toFixed(0)}%) | ${depthRatio >= 0.5 ? "✅" : "⚠️ <50%"} |`);
    lines.push(`| Thread 冗余度 | ${sc.structural.thread_redundancy} | ${sc.structural.thread_redundancy === 0 ? "✅" : "—"} |`);
  } else {
    lines.push(`| (structural) | null | ⚠️ 未计算 |`);
  }

  // 召回层
  lines.push("");
  lines.push("## 探索质量 - 召回层");
  lines.push("| 指标 | 值 | 状态 |");
  lines.push("|------|----|------|");
  if (sc.recall) {
    const must = sc.recall.recall_must;
    // total=0 表示该 scenario 尚未标注 GT，渲染为 "—" 而非误导性的 "0/0 (100%) ✅"
    if (must.total === 0) {
      lines.push(`| Recall_must | 0/0 | — (GT 未标注) |`);
    } else {
      const mustRatio = must.hit / must.total;
      const mustHighlight = mustRatio < 1 ? "🔴 高亮（不阻断）" : "✅";
      lines.push(`| Recall_must | ${must.hit}/${must.total} (${(mustRatio * 100).toFixed(0)}%) | ${mustHighlight} |`);
    }
    const should = sc.recall.recall_should;
    if (should.total === 0) {
      lines.push(`| Recall_should | 0/0 | — (GT 未标注) |`);
    } else {
      const shouldRatio = should.hit / should.total;
      lines.push(`| Recall_should | ${should.hit}/${should.total} (${(shouldRatio * 100).toFixed(0)}%) | ${shouldRatio === 1 ? "✅" : "—"} |`);
    }
    const nice = sc.recall.recall_nice;
    lines.push(`| Recall_nice | ${nice.hit}/${nice.total} | — |`);
    const tf = sc.recall.thread_full_rate;
    lines.push(`| Thread Full Rate | ${tf.full}/${tf.total} | ${tf.total === 0 ? "—" : tf.full === tf.total ? "✅" : "—"} |`);
    const tfp = sc.recall.thread_full_partial_rate;
    lines.push(`| Thread Full+Partial | ${tfp.full_partial}/${tfp.total} | |`);
    lines.push(`| known_false 触发 | ${sc.recall.known_false_triggered} | ${sc.recall.known_false_triggered === 0 ? "✅" : "🔴"} |`);
    if (sc.audit_items_count > 0) {
      lines.push(`| 待裁决项 | ${sc.audit_items_count} | 跑 \`npx tsx eval/cli.ts judge ${sc.scenario}\` |`);
    }
  } else {
    lines.push(`| (recall) | null | ⚠️ 未计算 |`);
  }

  return lines.join("\n");
}

export function writeScenarioScorecard(runId: string, scenarioId: string, sc: ScenarioScorecard): void {
  const base = resolve("eval/runs", runId, scenarioId);
  writeFileSync(resolve(base, "scorecard.json"), JSON.stringify(sc, null, 2));
  writeFileSync(resolve(base, "scorecard.md"), renderScenarioScorecardMd(sc));
}

export function renderComparisonSection(
  current: ScenarioScorecard,
  baseline: ScenarioScorecard | null,
  warnings: BaselineWarning[],
): string {
  if (!baseline) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push(`## 跨 run 对比（vs baseline ${baseline.run_id}）`);
  if (warnings.length > 0) {
    lines.push("");
    lines.push("> ⚠️ manifest 字段不一致，对比仅供参考或无意义：");
    lines.push("");
    for (const w of warnings) {
      const icon = w.severity === "red" ? "🔴" : "🟡";
      lines.push(`> ${icon} ${w.field}: ${w.current} vs ${w.baseline}`);
    }
    lines.push("");
  }
  lines.push("| 指标 | 当前 | baseline |");
  lines.push("|------|------|----------|");
  if (current.efficiency && baseline.efficiency) {
    const r = (e: EfficiencyReport) => e.total_events_count === 0 ? 0 : e.useful_events_count / e.total_events_count;
    lines.push(`| Efficiency Ratio | ${(r(current.efficiency) * 100).toFixed(1)}% | ${(r(baseline.efficiency) * 100).toFixed(1)}% |`);
  }
  if (current.recall && baseline.recall) {
    const rMust = (x: RecallReport) => x.recall_must.total === 0 ? 1 : x.recall_must.hit / x.recall_must.total;
    lines.push(`| Recall_must | ${(rMust(current.recall) * 100).toFixed(0)}% | ${(rMust(baseline.recall) * 100).toFixed(0)}% |`);
  }
  return lines.join("\n");
}
