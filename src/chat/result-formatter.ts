// 探索结果格式化 — ExplorationOutput → ExplorationSummary
//
// 职责：
//   1. findings > 30 按 confidence 排序截断到 top 15
//   2. 排除 exploration_log（太大会撑爆外层上下文）
//   3. 排除 reliability_note（外层 LLM 不需要这个元信息）

import type { ExplorationOutput, Finding } from "../agent/state.js";
import type { ExplorationSummary } from "./types.js";

const MAX_FINDINGS = 30;
const TOP_FINDINGS = 15;

const CONFIDENCE_ORDER: Record<Finding["confidence"], number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export function formatExplorationResult(
  output: ExplorationOutput,
  goal: string,
  seedEntities: string[],
): ExplorationSummary {
  let findings = output.findings;

  // 截断：超过 30 条时按 confidence 排序，取 top 15
  if (findings.length > MAX_FINDINGS) {
    findings = [...findings]
      .sort((a, b) => CONFIDENCE_ORDER[a.confidence] - CONFIDENCE_ORDER[b.confidence])
      .slice(0, TOP_FINDINGS);
  }

  return {
    goal,
    seed_entities: seedEntities,
    findings,
    event_threads: output.event_threads,
    stats: {
      steps: output.exploration_meta.stats.steps,
      entities_visited: output.exploration_meta.stats.entities_visited,
      findings_count: output.exploration_meta.stats.findings_count,
      events_buffered: output.exploration_meta.stats.events_buffered,
      completion_reason: output.exploration_meta.completion_reason,
    },
  };
}
