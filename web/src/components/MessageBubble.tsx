import type { ChatMessage, ChatContentBlock, ExplorationSummary } from "../types";
import { StreamingText } from "./StreamingText";
import { FindingCard } from "./FindingCard";
import { ThreadTimeline } from "./ThreadTimeline";

interface Props {
  message: ChatMessage;
}

export function MessageBubble({ message }: Props) {
  const isUser = message.role === "user";

  if (isUser) {
    // user 消息里如果只有 tool_result，渲染为探索结果而非聊天气泡
    if (Array.isArray(message.content) && message.content.every((b) => b.type === "tool_result")) {
      return (
        <div className="space-y-3 max-w-[90%]">
          {message.content.map((block, i) => (
            <ContentBlockView key={i} block={block} />
          ))}
        </div>
      );
    }

    return (
      <div className="flex justify-end">
        <div className="bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-br-md max-w-[80%] text-sm leading-relaxed">
          {typeof message.content === "string" ? message.content : renderTextBlocks(message.content)}
        </div>
      </div>
    );
  }

  // 助手消息：可能包含 text + tool_use（tool_result 已拆分到 user 消息）
  if (typeof message.content === "string") {
    return (
      <div className="flex justify-start">
        <div className="bg-gray-100 px-4 py-2.5 rounded-2xl rounded-bl-md max-w-[85%] text-sm leading-relaxed text-gray-800">
          <StreamingText text={message.content} />
        </div>
      </div>
    );
  }

  // 混合内容块
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] space-y-3">
        {message.content.map((block, i) => (
          <ContentBlockView key={i} block={block} />
        ))}
      </div>
    </div>
  );
}

function ContentBlockView({ block }: { block: ChatContentBlock }) {
  switch (block.type) {
    case "text":
      return (
        <div className="bg-gray-100 px-4 py-2.5 rounded-2xl rounded-bl-md text-sm leading-relaxed text-gray-800">
          <StreamingText text={block.text} />
        </div>
      );

    case "tool_use":
      return (
        <div className="ml-4 border-l-2 border-blue-200 pl-3 py-1">
          <span className="text-xs text-gray-500 font-medium">
            graph_explore
          </span>
          {block.input.goal != null && (
            <p className="text-xs text-gray-400 mt-0.5">
              目标：{String(block.input.goal)}
            </p>
          )}
        </div>
      );

    case "tool_result": {
      if (block.is_error) {
        return (
          <div className="bg-red-50 border border-red-200 px-4 py-2.5 rounded-2xl text-sm text-red-700">
            {block.content}
          </div>
        );
      }

      let summary: ExplorationSummary | null = null;
      try {
        summary = JSON.parse(block.content) as ExplorationSummary;
      } catch {
        return null;
      }

      return <ExplorationResultInline summary={summary} />;
    }

    default:
      return null;
  }
}

function renderTextBlocks(blocks: ChatContentBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// ─── 内联探索结果 ───

export function ExplorationResultInline({ summary }: { summary: ExplorationSummary }) {
  const hasFindings = summary.findings.length > 0;
  const hasThreads = summary.event_threads.length > 0;

  return (
    <div className="bg-white border border-gray-200 rounded-2xl rounded-bl-md p-4 space-y-3">
      <div className="flex items-center gap-2 text-xs text-gray-500">
        <span className="font-medium text-gray-700">探索完成</span>
        <span>深度 {summary.stats.steps} 步</span>
        <span>·</span>
        <span>{summary.stats.entities_visited} 实体</span>
        <span>·</span>
        <span>{summary.stats.findings_count} 发现</span>
      </div>

      {hasFindings && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            Findings ({summary.findings.length})
          </h4>
          {summary.findings.slice(0, 10).map((f) => (
            <FindingCard key={f.id} finding={f} />
          ))}
          {summary.findings.length > 10 && (
            <p className="text-xs text-gray-400">
              ... 还有 {summary.findings.length - 10} 条 finding
            </p>
          )}
        </div>
      )}

      {hasThreads && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-gray-500 uppercase tracking-wide">
            事件脉络 ({summary.event_threads.length})
          </h4>
          {summary.event_threads.map((t) => (
            <ThreadTimeline key={t.id} thread={t} />
          ))}
        </div>
      )}

      {!hasFindings && !hasThreads && (
        <p className="text-sm text-gray-400">未发现相关线索</p>
      )}
    </div>
  );
}
