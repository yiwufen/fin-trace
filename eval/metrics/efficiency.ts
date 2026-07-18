// 探索效率指标。只产出两个独立计数，不算比值（比值由 scorecard 渲染时算）。
import type { StateView, EfficiencyReport } from "../types.js";

export function computeEfficiency(view: StateView): EfficiencyReport {
  return {
    useful_events_count: view.thread_ku_ids.length,     // 分子：进入 thread 的去重 ku_id 数
    total_events_count: view.raw_event_archive_ku_ids.length,  // 分母：archive 里的 ku_id 数
  };
}
