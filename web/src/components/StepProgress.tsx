import { useState } from "react";
import type { StepEvent } from "../types";

interface Props {
  step: StepEvent;
  compact?: boolean;
}

export function StepProgress({ step, compact }: Props) {
  const [expanded, setExpanded] = useState(false);

  if (step.type === "error") {
    return (
      <div className="px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
        错误: {step.error ?? "未知错误"}
      </div>
    );
  }

  // ─── 分析阶段中间步骤 ───

  if (step.type === "analyzing_events") {
    return (
      <div className="px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg text-sm">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full bg-indigo-500 text-white text-[10px] flex items-center justify-center shrink-0">1</span>
          <span className="text-indigo-800">{step.detail ?? `正在分析 ${step.events_analyzed ?? 0} 条原始事件`}</span>
        </div>
      </div>
    );
  }

  if (step.type === "extracting_findings") {
    const hasDrops = (step.findings_dropped ?? 0) > 0;
    return (
      <div className="px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full bg-amber-500 text-white text-[10px] flex items-center justify-center shrink-0">2</span>
          <span className="text-amber-800">{step.detail ?? `已抽取 ${step.findings_extracted ?? 0} 条发现`}</span>
        </div>
        {hasDrops && (
          <div className="mt-1 ml-6 text-xs text-amber-600">
            其中 {step.findings_dropped} 条因缺 evidence/statement 被丢弃
          </div>
        )}
      </div>
    );
  }

  if (step.type === "building_threads") {
    return (
      <div className="px-3 py-2 bg-teal-50 border border-teal-200 rounded-lg text-sm">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full bg-teal-500 text-white text-[10px] flex items-center justify-center shrink-0">3</span>
          <span className="text-teal-800">{step.detail ?? `已构建 ${step.threads_built ?? 0} 条事件脉络`}</span>
        </div>
      </div>
    );
  }

  if (step.type === "validating") {
    const hasDrops = (step.threads_dropped ?? 0) > 0;
    return (
      <div className="px-3 py-2 bg-emerald-50 border border-emerald-200 rounded-lg text-sm">
        <div className="flex items-center gap-2">
          <span className="w-4 h-4 rounded-full bg-emerald-500 text-white text-[10px] flex items-center justify-center shrink-0">4</span>
          <span className="text-emerald-800">{step.detail ?? `验证通过 ${step.threads_built ?? 0} 条脉络`}</span>
        </div>
        {hasDrops && (
          <div className="mt-1 ml-6 text-xs text-emerald-600">
            {step.threads_dropped} 条脉络因 ku_id 不存在或时间线不一致被丢弃
          </div>
        )}
      </div>
    );
  }

  // ─── finalize ───

  if (step.type === "finalize") {
    return (
      <div className="px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-sm">
        <span className="font-medium text-green-800">探索完成</span>
        {step.exploration_meta && (
          <span className="text-green-600 ml-2">
            {step.exploration_meta.stats.steps} 步 · {step.exploration_meta.stats.entities_visited} 实体 · {step.exploration_meta.stats.findings_count} 发现
          </span>
        )}
      </div>
    );
  }

  // ─── step_complete / finding ───

  const toolNames = step.tools_used?.join(", ") ?? "";
  const entityNames = step.new_entities?.slice(0, 3).join(", ") ?? "";
  const hasMoreEntities = (step.new_entities?.length ?? 0) > 3;

  return (
    <div
      className={`px-3 py-2 bg-white border border-gray-200 rounded-lg text-sm cursor-pointer hover:border-gray-300 transition-colors ${
        compact ? "py-1.5" : ""
      }`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center gap-2">
        <span className="text-gray-400 text-xs shrink-0">Step {step.step}</span>
        {step.decision && (
          <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{step.decision}</span>
        )}
        {toolNames && <span className="text-xs text-gray-500 truncate">{toolNames}</span>}
        {step.new_findings_count != null && step.new_findings_count > 0 && (
          <span className="text-xs text-amber-600">+{step.new_findings_count} 发现</span>
        )}
        <svg
          className={`ml-auto w-3.5 h-3.5 text-gray-300 shrink-0 transition-transform ${expanded ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-label={expanded ? "收起" : "展开"}
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      {expanded && !compact && (
        <div className="mt-2 pt-2 border-t border-gray-100 space-y-1 text-xs text-gray-500">
          {entityNames && (
            <div>
              <span className="text-gray-400">新实体: </span>
              {entityNames}{hasMoreEntities ? "..." : ""}
            </div>
          )}
          {step.total_findings != null && <div>累计发现: {step.total_findings}</div>}
          {step.total_entities != null && <div>已探索实体: {step.total_entities}</div>}
          {step.total_events != null && <div>事件数: {step.total_events}</div>}
          {step.budget_used != null && step.budget_limit != null && (
            <div>
              预算: {((step.budget_used / step.budget_limit) * 100).toFixed(0)}%
            </div>
          )}
        </div>
      )}
    </div>
  );
}
