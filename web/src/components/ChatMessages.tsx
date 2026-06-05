import type { Exploration, StepEvent } from "../types";
import { StepProgress } from "./StepProgress";
import { ResultsPanel } from "./ResultsPanel";

// ─── 消息类型 ───

export type ChatMessage =
  | { role: "user"; content: string }
  | { role: "agent"; content: string }
  | { role: "confirm"; goal: string; seedEntities: string[]; maxDepth: number }
  | { role: "steps"; steps: StepEvent[]; explorationIndex: number; isRunning: boolean; onCancel: () => void }
  | { role: "results"; output: Exploration["output"]; explorationIndex: number }
  | { role: "error"; content: string };

interface Props {
  messages: ChatMessage[];
}

export function ChatMessages({ messages }: Props) {
  return (
    <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
      {messages.map((msg, i) => (
        <MessageBubble key={i} message={msg} />
      ))}
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  switch (message.role) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="bg-blue-600 text-white px-4 py-2.5 rounded-2xl rounded-br-md max-w-[80%] text-sm leading-relaxed">
            {message.content}
          </div>
        </div>
      );

    case "agent":
      return (
        <div className="flex justify-start">
          <div className="bg-gray-100 px-4 py-2.5 rounded-2xl rounded-bl-md max-w-[80%] text-sm leading-relaxed text-gray-800">
            {message.content}
          </div>
        </div>
      );

    case "confirm":
      return (
        <div className="flex justify-start">
          <div className="bg-white border border-gray-200 px-4 py-3 rounded-2xl rounded-bl-md max-w-[80%] text-sm space-y-1.5">
            <p className="text-gray-500 text-xs font-medium">参数确认</p>
            <p><span className="text-gray-500">目标：</span>{message.goal}</p>
            <p><span className="text-gray-500">实体：</span>{message.seedEntities.join("、")}</p>
            <p><span className="text-gray-500">深度：</span>{message.maxDepth} 跳</p>
          </div>
        </div>
      );

    case "steps":
      return (
        <div className="space-y-1.5 ml-4 border-l-2 border-blue-200 pl-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-gray-500 font-medium">探索 #{message.explorationIndex + 1}</span>
            {message.isRunning && (
              <>
                <span className="text-xs text-blue-600 animate-pulse">进行中</span>
                <button
                  onClick={message.onCancel}
                  className="text-xs px-2 py-0.5 rounded bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                >
                  终止
                </button>
              </>
            )}
          </div>
          {message.steps.map((step, j) => (
            <StepProgress key={j} step={step} />
          ))}
        </div>
      );

    case "results":
      return message.output ? (
        <ResultsPanel output={message.output} />
      ) : null;

    case "error":
      return (
        <div className="flex justify-start">
          <div className="bg-red-50 border border-red-200 px-4 py-2.5 rounded-2xl rounded-bl-md text-sm text-red-700">
            {message.content}
          </div>
        </div>
      );
  }
}
