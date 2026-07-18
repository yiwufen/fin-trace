// 探索质量 - 结构层（零标注）：ku_id 存证率、Thread 因果深度、Thread 冗余度。
import type { StateView, StructuralQualityReport } from "../types.js";

export function computeStructuralQuality(view: StateView): StructuralQualityReport {
  // ku_id 存证率：findings evidence 中的 ku_id 有多少真实存在于 raw_event_archive
  const archiveSet = new Set(view.raw_event_archive_ku_ids);
  const evidenceKuIds = view.findings_evidence_ku_ids;
  let matched = 0;
  for (const k of evidenceKuIds) {
    if (archiveSet.has(k)) matched += 1;
  }

  // Thread 因果深度：(causal + temporal) / 总关系数
  let causalTemporal = 0;
  for (const t of view.thread_relationships) {
    if (t === "causal" || t === "temporal") causalTemporal += 1;
  }

  // Thread 冗余度：同一 ku_id 出现在 ≥2 个 thread 的次数（计重复的 ku_id 数，非 thread 对数）
  const threadCount = new Map<string, number>();
  for (const kuIds of view.per_thread_ku_ids) {
    const seen = new Set(kuIds);   // 同一 thread 内重复只算 1 次
    for (const k of seen) {
      threadCount.set(k, (threadCount.get(k) ?? 0) + 1);
    }
  }
  let redundancy = 0;
  for (const count of threadCount.values()) {
    if (count >= 2) redundancy += 1;
  }

  return {
    ku_id_provenance: { matched, total: evidenceKuIds.length },
    thread_causal_depth: { causal_temporal: causalTemporal, total: view.thread_relationships.length },
    thread_redundancy: redundancy,
  };
}
