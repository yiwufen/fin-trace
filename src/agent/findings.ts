// Key Findings — 提取/去重/confidence 分级 — v3: 路由到三层
//
// LLM 输出的 new_findings 可以携带 flag_target 来指定路由:
// - "entity" → entity_flags（基础设施告警，代码保障注入 Prompt）
// - "cluster" → cluster_flags（数据质量标记，随 cluster 数据绑定）
// - 默认 → key_insights（跨轮合成洞察）

import { randomUUID } from "node:crypto";
import type { ExplorationState, Finding, ToolResult, RawEvent, EventDataType } from "./state.js";

// ─── LLM 输出的原始 Finding（含路由提示）───

export interface RawFinding {
  category: "pattern_violation" | "concentration" | "chain" | "absence";
  statement: string;
  confidence: "high" | "medium" | "low";
  entities_involved: string[];
  relation_to_goal: string;
  // 路由提示（可选）
  flag_target?: "entity" | "cluster";
  cluster_id?: string;              // flag_target="cluster" 时必填
}

// ─── 提取时机判断 ───

export function shouldExtractFindings(state: ExplorationState): boolean {
  if (state.step_count === 3 || state.step_count === 5) return true;
  if (state.step_count > 5 && (state.step_count - 5) % 3 === 0) return true;

  if (state.last_n_decisions.length >= 2) {
    const prev = state.last_n_decisions[state.last_n_decisions.length - 2];
    const curr = state.last_n_decisions[state.last_n_decisions.length - 1];
    if (
      (prev === "expand" && curr === "deep_dive") ||
      (prev === "deep_dive" && curr === "verify")
    ) {
      return true;
    }
  }

  if (
    state.last_n_decisions.length > 0 &&
    state.last_n_decisions[state.last_n_decisions.length - 1] === "sufficient"
  ) {
    return true;
  }

  return false;
}

// ─── Evidence 提取 ───

export function extractEvidenceFromLastResults(
  raw: RawFinding,
  results: ToolResult[],
): string[] {
  const kuIds: string[] = [];

  for (const result of results) {
    if (result.error || !result.data) continue;

    const data = result.data as Record<string, unknown>;
    const units = data.knowledge_units;
    if (!Array.isArray(units)) continue;

    for (const unit of units) {
      const u = unit as Record<string, unknown>;
      if (typeof u.ku_id !== "string") continue;

      const unitEntities = Array.isArray(u.entities) ? u.entities : [];
      const mentions: string[] = [];
      for (const e of unitEntities) {
        if (typeof e !== "object" || e === null) continue;
        const obj = e as Record<string, unknown>;
        if (typeof obj.mention === "string") mentions.push(obj.mention);
        else if (typeof obj.canonical_name === "string") mentions.push(obj.canonical_name);
      }

      const hasOverlap = raw.entities_involved.some((target) =>
        mentions.some((m) => m.includes(target) || target.includes(m)),
      );

      if (hasOverlap) kuIds.push(u.ku_id);
    }
  }

  return [...new Set(kuIds)];
}

// 从 raw_event_archive 中按实体名匹配提取 KU ID
export function extractEvidenceFromArchive(
  raw: RawFinding,
  state: ExplorationState,
): string[] {
  const kuIds: string[] = [];

  for (const entry of state.raw_event_archive) {
    const hasOverlap = raw.entities_involved.some(
      (target) => entry.entity.includes(target) || target.includes(entry.entity),
    );
    if (hasOverlap) kuIds.push(entry.ku_id);
  }

  return [...new Set(kuIds)];
}

// ─── 相似度判断 ───

function extractKeywords(text: string): string[] {
  return text
    .split(/[\s,，。、；：！？（）()\[\]【】""''\"\'·\-—\/\\]+/)
    .filter((w) => w.length >= 2);
}

export function isSimilarFinding(a: Finding, b: Finding): boolean {
  const setA = new Set(a.entities_involved);
  const setB = new Set(b.entities_involved);
  let intersection = 0;
  for (const e of setA) {
    if (setB.has(e)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  if (union === 0 || intersection / union < 0.5) return false;

  if (a.category !== b.category) return false;

  const keywordsA = extractKeywords(a.statement);
  const keywordsB = extractKeywords(b.statement);
  const shared = keywordsA.filter((k) => keywordsB.includes(k));
  const minLen = Math.min(keywordsA.length, keywordsB.length);

  return minLen > 0 && shared.length >= minLen * 0.6;
}

const NEG_PATTERNS = /没有|无|零|未|不存在|缺失/;

export function isContradictory(a: Finding, b: Finding): boolean {
  const aNeg = NEG_PATTERNS.test(a.statement);
  const bNeg = NEG_PATTERNS.test(b.statement);

  return (
    a.entities_involved.some((e) => b.entities_involved.includes(e)) &&
    a.category === b.category &&
    aNeg !== bNeg
  );
}

// ─── Confidence 分级 ───

const EVENT_TYPE_WEIGHT: Record<EventDataType, number> = {
  structural_fact: 1.0,
  aggregate_metric: 0.8,
  streaming_snapshot: 0.4,
  unknown: 0.6,
};

function weightedEvidenceCount(evidence: string[], archive: RawEvent[]): number {
  let total = 0;
  for (const kuId of evidence) {
    const event = archive.find((e) => e.ku_id === kuId);
    total += EVENT_TYPE_WEIGHT[event?.event_data_type ?? "unknown"];
  }
  return total;
}

export function adjustConfidence(
  confidence: Finding["confidence"],
  evidenceCount: number,
): Finding["confidence"] {
  // evidenceCount 已加权：structural_fact × 1.0, aggregate_metric × 0.8, streaming_snapshot × 0.4
  if (confidence === "high" && evidenceCount >= 3) return "high";
  if (confidence === "high" && evidenceCount < 3) return "medium";
  if (confidence === "medium" && evidenceCount >= 5) return "high";
  if (confidence === "medium" && evidenceCount < 2) return "low";
  if (confidence === "low" && evidenceCount >= 5) return "medium";
  return confidence;
}

function mergeConfidence(
  a: Finding["confidence"],
  b: Finding["confidence"],
): Finding["confidence"] {
  const order = { low: 0, medium: 1, high: 2 } as const;
  return order[a] >= order[b] ? a : b;
}

// ─── 核心: 处理新 Findings → 路由到 entity_flags / cluster_flags / key_insights ───

export function processNewFindings(
  newFindings: RawFinding[],
  state: ExplorationState,
): void {
  for (const raw of newFindings) {
    // ── 路由 1: entity_flags（基础设施告警）──
    if (raw.flag_target === "entity") {
      const alreadyFlagged = state.entity_flags.some(
        (f) => f.entity_name === raw.entities_involved[0] && f.description === raw.statement
      );
      if (!alreadyFlagged) {
        state.entity_flags.push({
          entity_name: raw.entities_involved[0] ?? "unknown",
          flag_type: "unreliable_mapping",
          description: raw.statement,
          source_step: state.step_count,
        });
      }
      continue;
    }

    // ── 路由 2: cluster_flags（数据质量标记）──
    if (raw.flag_target === "cluster" && raw.cluster_id) {
      const alreadyFlagged = state.cluster_flags.some(
        (f) => f.cluster_id === raw.cluster_id && f.description === raw.statement
      );
      if (!alreadyFlagged) {
        state.cluster_flags.push({
          cluster_id: raw.cluster_id,
          flag_type: "data_conflict",
          description: raw.statement,
          source_step: state.step_count,
        });
      }
      continue;
    }

    // ── 路由 3: key_insights（跨轮合成洞察）──
    let evidence = extractEvidenceFromLastResults(raw, state.last_tool_results_raw);
    if (evidence.length === 0) {
      evidence = extractEvidenceFromArchive(raw, state);
    }
    console.log(`[findings] statement="${raw.statement.slice(0, 60)}" evidence=${evidence.length} entities=${raw.entities_involved.join(",")}`);
    const weightedCount = weightedEvidenceCount(evidence, state.raw_event_archive);
    const finding: Finding = {
      id: `finding_${randomUUID()}`,
      category: raw.category,
      statement: raw.statement,
      confidence: adjustConfidence(raw.confidence, weightedCount),
      evidence,
      entities_involved: raw.entities_involved,
      relation_to_goal: raw.relation_to_goal,
      discovered_at_step: state.step_count,
    };

    // 质量控制: 必须有 evidence
    if (finding.evidence.length === 0) {
      // 无 evidence 的不进入 key_insights（丢弃，非低置信度存储）
      continue;
    }

    // 去重检查
    const existing = state.key_insights.find((f) => isSimilarFinding(f, finding));

    if (existing) {
      if (isContradictory(existing, finding)) {
        existing.conflict_with = finding.statement;
        finding.conflict_with = existing.statement;
        state.key_insights.push(finding);
      } else {
        existing.evidence = [...new Set([...existing.evidence, ...finding.evidence])];
        existing.confidence = mergeConfidence(existing.confidence, finding.confidence);
      }
    } else {
      state.key_insights.push(finding);
    }
  }
}
