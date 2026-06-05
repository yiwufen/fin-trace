import { useState, useRef, useEffect } from "react";
import type { Exploration, StepEvent } from "../types";
import { ChatMessages, type ChatMessage } from "./ChatMessages";

interface Props {
  explorations: Exploration[];
  liveSteps: StepEvent[];
  isRunning: boolean;
  onExplore: (goal: string, seedEntities: string[], maxDepth?: number) => void;
  onFollowup: (goal: string, extraSeeds?: string[]) => void;
  onCancel: () => void;
}

export function ChatArea({ explorations, liveSteps, isRunning, onExplore, onFollowup, onCancel }: Props) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasStarted = explorations.length > 0 || liveSteps.length > 0;
  const hasCompletedExplorations = explorations.some((e) => e.output);

  const handleExport = () => {
    const completed = explorations.filter((e) => e.output);
    if (completed.length === 0) return;
    const report = {
      exported_at: new Date().toISOString(),
      explorations: completed.map((e) => ({
        goal: e.goal,
        seed_entities: e.seed_entities,
        started_at: e.started_at,
        completed_at: e.completed_at,
        output: e.output,
      })),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fin-trace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // 构建 chat 消息列表
  const messages = buildMessages(explorations, liveSteps, isRunning, onCancel);

  // 自动滚到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, liveSteps.length]);

  const handleSend = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");

    if (!hasStarted) {
      // 首次：解析为探索参数
      const { goal, seeds } = parseExplorationInput(text);
      onExplore(goal, seeds);
    } else {
      // 追问
      onFollowup(text);
    }
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 消息流 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {!hasStarted ? (
          <EmptyState />
        ) : (
          <ChatMessages messages={messages} />
        )}
      </div>

      {/* 底部输入 */}
      <div className="border-t border-gray-200 bg-white p-4">
        <div className="max-w-3xl mx-auto flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
            placeholder={hasStarted ? "继续追问..." : "描述你想探索的问题，如：芯片管制对英伟达供应链的影响"}
            disabled={isRunning}
            className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isRunning}
            className="px-5 py-2.5 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-700 disabled:bg-gray-300 transition-colors font-medium"
          >
            {hasStarted ? "追问" : "探索"}
          </button>
          {hasCompletedExplorations && !isRunning && (
            <button
              onClick={handleExport}
              className="px-4 py-2.5 border border-gray-300 text-gray-600 text-sm rounded-xl hover:bg-gray-50 transition-colors"
              title="导出 JSON 报告"
            >
              导出
            </button>
          )}
        </div>
      </div>
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

function buildMessages(
  explorations: Exploration[],
  liveSteps: StepEvent[],
  isRunning: boolean,
  onCancel: () => void,
): ChatMessage[] {
  const msgs: ChatMessage[] = [];

  for (let i = 0; i < explorations.length; i++) {
    const ex = explorations[i];
    // 用户消息
    msgs.push({ role: "user", content: ex.goal });
    // 参数确认
    msgs.push({ role: "confirm", goal: ex.goal, seedEntities: ex.seed_entities, maxDepth: ex.max_depth });
    // 步骤气泡
    if (ex.steps.length > 0) {
      msgs.push({
        role: "steps",
        steps: ex.steps as StepEvent[],
        explorationIndex: i,
        isRunning: ex.status === "running",
        onCancel,
      });
    }
    // 结果
    if (ex.output) {
      msgs.push({ role: "results", output: ex.output, explorationIndex: i });
    }
    // 错误
    if (ex.status === "error" && !ex.output) {
      msgs.push({ role: "error", content: "探索过程中发生错误" });
    }
  }

  // 实时进度（最新一轮）
  if (liveSteps.length > 0) {
    msgs.push({
      role: "steps",
      steps: liveSteps,
      explorationIndex: explorations.length,
      isRunning,
      onCancel,
    });
  }

  return msgs;
}

// 简单解析用户输入 → goal + seed entities
// TODO: 应由 LLM 做意图解析和实体抽取（待设计）
function parseExplorationInput(text: string): { goal: string; seeds: string[] } {
  // 尝试提取中文实体：简单策略是按"对"分割，或者按逗号/顿号提取
  // 这只是 MVP，后续由 Agent LLM 接管
  const seeds: string[] = [];

  // 常见模式："X对Y的影响"
  const impactMatch = text.match(/(.+?)(?:对|对于|和|与|跟)(.+?)(?:的|之)?(?:影响|关系|作用|布局|供应链|产业链|风险)/);
  if (impactMatch) {
    const left = impactMatch[1].trim();
    const right = impactMatch[2].trim();
    if (left.length >= 2 && left.length <= 10) seeds.push(left);
    if (right.length >= 2 && right.length <= 10) seeds.push(right);
  }

  // 如果没提取到实体，至少用第一个有意义的词
  if (seeds.length === 0) {
    // 提取 2-6 字的中文名（公司/人名）
    const nameMatch = text.match(/[一-鿿]{2,6}/g);
    if (nameMatch) {
      seeds.push(nameMatch[0]);
    }
  }

  return { goal: text, seeds: [...new Set(seeds)] };
}
