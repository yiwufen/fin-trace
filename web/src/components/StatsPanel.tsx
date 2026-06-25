import { useState } from "react";

interface Props {
  meta: {
    completion_reason: string;
    stats: {
      steps: number;
      entities_visited: number;
      findings_count: number;
      events_buffered: number;
      tokens_used: number;
    };
    reliability_note: string | null;
  };
}

export function StatsPanel({ meta }: Props) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="relative">
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-xs text-gray-400 hover:text-gray-600"
      >
        统计 {expanded ? "▲" : "▼"}
      </button>
      {expanded && (
        <div className="absolute top-6 right-0 z-10 w-64 max-w-[85vw] bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs space-y-1.5">
          <div className="flex justify-between">
            <span className="text-gray-500">完成原因</span>
            <span className="text-gray-800">{meta.completion_reason}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">步数</span>
            <span className="text-gray-800">{meta.stats.steps}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">实体数</span>
            <span className="text-gray-800">{meta.stats.entities_visited}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">发现数</span>
            <span className="text-gray-800">{meta.stats.findings_count}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">事件数</span>
            <span className="text-gray-800">{meta.stats.events_buffered}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-500">Token</span>
            <span className="text-gray-800">{meta.stats.tokens_used.toLocaleString()}</span>
          </div>
          {meta.reliability_note && (
            <div className="pt-1.5 border-t border-gray-100">
              <span className="text-amber-600">{meta.reliability_note}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
