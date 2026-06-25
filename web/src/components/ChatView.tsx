import { useRef, useEffect } from "react";
import type { ChatMessage, TurnSegment, ToolSegment } from "../types";
import { MessageBubble, ExplorationResultInline } from "./MessageBubble";
import { ChatInput } from "./ChatInput";
import { StreamingText } from "./StreamingText";
import { StepProgress } from "./StepProgress";

interface Props {
  sessionId: string;
  messages: ChatMessage[];
  isProcessing: boolean;
  segments: TurnSegment[];
  onSend: (text: string) => void;
  onStop: () => void;
}

export function ChatView({
  messages,
  isProcessing,
  segments,
  onSend,
  onStop,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // 自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, segments.length]);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {!hasMessages && !isProcessing ? (
          <EmptyState />
        ) : (
          <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
            {/* 历史消息 */}
            {messages.map((msg, i) => (
              <MessageBubble key={i} message={msg} />
            ))}

            {/* 实时流式 segments */}
            {isProcessing && segments.length > 0 && (
              <div className="space-y-3">
                {segments.map((seg, i) => {
                  if (seg.type === "text") {
                    return (
                      <div key={i} className="flex justify-start">
                        <div className="bg-gray-100 px-4 py-2.5 rounded-2xl rounded-bl-md max-w-[85%] text-sm leading-relaxed text-gray-800">
                          <StreamingText text={seg.text} streaming={seg.streaming} />
                        </div>
                      </div>
                    );
                  }
                  // tool segment
                  return <ExplorationBlock key={seg.tool_use_id} segment={seg} />;
                })}
              </div>
            )}

            {/* 思考中指示器 — 等待首个 SSE 事件 */}
            {isProcessing && segments.length === 0 && (
              <div className="flex justify-start">
                <div className="bg-gray-100 px-4 py-2.5 rounded-2xl rounded-bl-md text-sm text-gray-500 flex items-center gap-2">
                  <span className="inline-flex gap-1">
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="w-1.5 h-1.5 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  <span>思考中</span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <ChatInput onSend={onSend} isProcessing={isProcessing} onStop={onStop} />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center h-full">
      <div className="text-center space-y-3">
        <div className="text-4xl">🔍</div>
        <h2 className="text-lg font-semibold text-gray-700">Graph Explorer</h2>
        <p className="text-sm text-gray-400 max-w-sm">
          描述你想探索的问题，Agent 会在金融知识图谱上进行多跳推理
        </p>
        <div className="text-xs text-gray-300 space-y-1 pt-2">
          <p>例如："芯片管制对英伟达供应链的影响"</p>
          <p>例如："宁德时代的欧洲布局和台积电的关系"</p>
        </div>
      </div>
    </div>
  );
}

// ─── 实时探索块 — 单次 graph_explore 调用的完整生命周期 ───

function ExplorationBlock({ segment }: { segment: ToolSegment }) {
  const isRunning = segment.status === "running";
  const hasAnalysisSteps = segment.steps.some(
    (s) => s.type === "analyzing_events" || s.type === "extracting_findings" || s.type === "building_threads" || s.type === "validating"
  );

  return (
    <div className="ml-4 border-l-2 border-blue-200 pl-3 py-1 space-y-1.5">
      {/* 头部 */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 font-medium">
          {hasAnalysisSteps ? "探索 & 分析" : "探索中"}
        </span>
        {isRunning && <span className="text-xs text-blue-600 animate-pulse">进行中</span>}
        {segment.status === "completed" && (
          <span className="text-xs text-green-600">已完成</span>
        )}
        {segment.status === "error" && (
          <span className="text-xs text-red-600">{segment.error ?? "失败"}</span>
        )}
      </div>

      {/* 步骤气泡 */}
      {segment.steps.map((step, i) => (
        <StepProgress key={i} step={step} />
      ))}

      {/* 结果内联展示 */}
      {segment.result && (
        <div className="mt-2">
          <ExplorationResultInline summary={segment.result} />
        </div>
      )}
    </div>
  );
}
