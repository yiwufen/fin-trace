import { useState } from "react";
import type { Finding } from "../types";

interface Props {
  finding: Finding;
}

const CATEGORY_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  pattern_violation: { icon: "x", color: "bg-red-100 text-red-700 border-red-200", label: "模式异常" },
  concentration: { icon: "!", color: "bg-amber-100 text-amber-700 border-amber-200", label: "集中度" },
  chain: { icon: "#", color: "bg-blue-100 text-blue-700 border-blue-200", label: "传导链" },
  absence: { icon: "?", color: "bg-gray-100 text-gray-700 border-gray-200", label: "缺失信号" },
};

const CONFIDENCE_CONFIG: Record<string, { color: string; label: string }> = {
  high: { color: "text-green-600", label: "HIGH" },
  medium: { color: "text-amber-600", label: "MEDIUM" },
  low: { color: "text-gray-400", label: "LOW" },
};

export function FindingCard({ finding }: Props) {
  const [evidenceExpanded, setEvidenceExpanded] = useState(false);

  const cat = CATEGORY_CONFIG[finding.category] ?? CATEGORY_CONFIG.chain;
  const conf = CONFIDENCE_CONFIG[finding.confidence] ?? CONFIDENCE_CONFIG.medium;

  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      {/* Header: category + confidence */}
      <div className="flex items-center gap-2 mb-2">
        <span className={`text-xs px-1.5 py-0.5 rounded border ${cat.color}`}>
          {cat.label}
        </span>
        <span className={`text-xs font-mono font-medium ${conf.color}`}>
          {conf.label}
        </span>
      </div>

      {/* Statement */}
      <p className="text-sm text-gray-800 leading-relaxed">{finding.statement}</p>

      {/* Entities */}
      {finding.entities_involved.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {finding.entities_involved.map((e) => (
            <span key={e} className="text-xs px-1.5 py-0.5 bg-gray-100 text-gray-600 rounded">
              {e}
            </span>
          ))}
        </div>
      )}

      {/* Evidence */}
      {finding.evidence.length > 0 && (
        <div className="mt-2">
	          <button
	            onClick={() => setEvidenceExpanded(!evidenceExpanded)}
	            className="text-xs text-blue-600 hover:underline py-1 px-1 -mx-1 rounded"
	          >
            {finding.evidence.length} 条证据 {evidenceExpanded ? "▲" : "▼"}
          </button>
          {evidenceExpanded && (
            <div className="mt-1 space-y-1">
              {finding.evidence.map((kuId) => (
                <div key={kuId} className="text-xs text-gray-500 bg-gray-50 px-2 py-1 rounded font-mono">
                  {kuId}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Conflict */}
      {finding.conflict_with && (
        <div className="mt-2 text-xs text-red-600">
          与 {finding.conflict_with} 矛盾
        </div>
      )}
    </div>
  );
}
