import type { ExplorationOutput } from "../types";
import { FindingCard } from "./FindingCard";
import { ThreadTimeline } from "./ThreadTimeline";
import { StatsPanel } from "./StatsPanel";

interface Props {
  output: ExplorationOutput;
}

export function ResultsPanel({ output }: Props) {
  const hasFindings = output.findings.length > 0;
  const hasThreads = output.event_threads.length > 0;

  return (
    <div className="space-y-4 mt-4">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold text-gray-800">探索结果</h3>
        <StatsPanel meta={output.exploration_meta} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Findings 面板 */}
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Findings ({output.findings.length})
          </h4>
          {hasFindings ? (
            output.findings.map((f) => <FindingCard key={f.id} finding={f} />)
          ) : (
            <div className="text-sm text-gray-400 py-8 text-center">
              该知识库范围内未发现明显模式
            </div>
          )}
        </div>

        {/* Event Threads 面板 */}
        <div className="space-y-3">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Event Threads ({output.event_threads.length})
          </h4>
          {hasThreads ? (
            output.event_threads.map((t) => <ThreadTimeline key={t.id} thread={t} />)
          ) : (
            <div className="text-sm text-gray-400 py-8 text-center">
              无事件脉络
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
