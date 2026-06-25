import { useState, useCallback, useRef, useEffect } from "react";
import type {
  Session, ChatMessage, ChatContentBlock, TurnSegment,
  StepEvent, ToolStartEvent, ExplorationSummary,
} from "../types";
import {
  getPublicDemo, getPublicTokenInfo, sendPublicChat, createPublicSSEConnection,
  type PublicTokenInfo,
} from "../api";
import { MessageBubble } from "./MessageBubble";
import { StreamingText } from "./StreamingText";
import { StepProgress } from "./StepProgress";
import { ExplorationResultInline } from "./MessageBubble";
import { ChatInput } from "./ChatInput";

interface Props {
  token: string;
}

/**
 * HR 视图（通过 /s/<token> 访问）。
 * - 顶部只读展示 demo 会话（不计次），方便了解产品能力
 * - 底部聊天框，每发一条消息消耗 1 次配额
 */
export function HRView({ token }: Props) {
  // demo（只读）
  const [demo, setDemo] = useState<Session | null>(null);
  const [demoLoading, setDemoLoading] = useState(true);

  // 配额
  const [info, setInfo] = useState<PublicTokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // HR 自己的对话（从懒创建的 hr_session 恢复）
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [segments, setSegments] = useState<TurnSegment[]>([]);
  // segments 的 ref 镜像 — SSE 回调里读取最新值，避免在 setState updater 内做副作用
  const segmentsRef = useRef<TurnSegment[]>([]);
  const esRef = useRef<EventSource | null>(null);

  const commitSegments = useCallback((next: TurnSegment[]) => {
    segmentsRef.current = next;
    setSegments(next);
  }, []);

  const refreshInfo = useCallback(async () => {
    const i = await getPublicTokenInfo(token);
    if (!i) {
      setTokenError("链接无效或已禁用");
      return;
    }
    setInfo(i);
    setTokenError(null);
  }, [token]);

  useEffect(() => {
    // 加载 demo（只读）
    getPublicDemo().then((s) => {
      setDemo(s);
      setDemoLoading(false);
    });
    refreshInfo();
  }, [refreshInfo]);

  // ─── 构建 HR 回复消息 ───
  const buildFinalMessage = useCallback((segs: TurnSegment[]) => {
    if (segs.length === 0) return null;

    const assistantBlocks: ChatContentBlock[] = [];
    const toolResultBlocks: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];

    for (const seg of segs) {
      if (seg.type === "text") {
        if (seg.text) assistantBlocks.push({ type: "text", text: seg.text });
      } else {
        assistantBlocks.push({ type: "tool_use", id: seg.tool_use_id, name: seg.tool_name, input: seg.args });
        if (seg.result) {
          toolResultBlocks.push({ type: "tool_result", tool_use_id: seg.tool_use_id, content: JSON.stringify(seg.result) });
        } else if (seg.status === "error") {
          toolResultBlocks.push({ type: "tool_result", tool_use_id: seg.tool_use_id, content: seg.error ?? "探索失败", is_error: true });
        }
      }
    }

    const result: ChatMessage[] = [];
    if (assistantBlocks.length > 0) {
      result.push({ role: "assistant", content: assistantBlocks, created_at: new Date().toISOString() });
    }
    if (toolResultBlocks.length > 0) {
      result.push({ role: "user", content: toolResultBlocks, created_at: new Date().toISOString() });
    }
    return result;
  }, []);

  /** 完成一轮：用 segmentsRef 当前值构建最终消息，重置状态 */
  const finalizeTurn = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    const built = buildFinalMessage(segmentsRef.current);
    setIsProcessing(false);
    commitSegments([]);
    if (built && built.length > 0) {
      setMessages((prev) => [...prev, ...built]);
    }
    refreshInfo();
  }, [buildFinalMessage, commitSegments, refreshInfo]);

  // ─── 发送 ───
  const handleSend = useCallback((text: string) => {
    if (isProcessing) return;

    const userMsg: ChatMessage = { role: "user", content: text, created_at: new Date().toISOString() };
    setMessages((prev) => [...prev, userMsg]);
    setIsProcessing(true);
    commitSegments([]);

    const es = createPublicSSEConnection(token, {
      onTextDelta: (t) => {
        const segs = [...segmentsRef.current];
        const last = segs[segs.length - 1];
        if (last && last.type === "text") {
          last.text += t;
        } else {
          segs.push({ type: "text", text: t, streaming: true });
        }
        commitSegments(segs);
      },
      onToolStart: (e) => {
        const segs = [...segmentsRef.current];
        const last = segs[segs.length - 1];
        if (last && last.type === "text") last.streaming = false;
        const ev = e as ToolStartEvent;
        segs.push({ type: "tool", tool_use_id: ev.tool_use_id, tool_name: ev.tool_name, args: ev.args, steps: [], result: null, status: "running" });
        commitSegments(segs);
      },
      onToolResult: (e) => {
        const ev = e as { tool_use_id?: string; result?: ExplorationSummary; is_error?: boolean; error?: string };
        const tid = ev.tool_use_id;
        if (!tid) return;
        const segs = segmentsRef.current.map((s) => {
          if (s.type === "tool" && s.tool_use_id === tid) {
            if (ev.result) return { ...s, result: ev.result, status: "completed" as const };
            if (ev.is_error) return { ...s, status: "error" as const, error: ev.error };
          }
          return s;
        });
        commitSegments(segs);
      },
      onStep: (e) => {
        const ev = e as StepEvent;
        const tid = ev.tool_use_id;
        if (!tid) return;
        const segs = segmentsRef.current.map((s) => {
          if (s.type === "tool" && s.tool_use_id === tid) {
            return { ...s, steps: [...s.steps, ev] };
          }
          return s;
        });
        commitSegments(segs);
      },
      onFinalize: () => {},
      onMessageComplete: () => {
        finalizeTurn();
      },
      onError: (error) => {
        const errMsg: ChatMessage = { role: "assistant", content: `处理出错：${error}`, created_at: new Date().toISOString() };
        if (esRef.current) { esRef.current.close(); esRef.current = null; }
        setIsProcessing(false);
        setSegments([]);
        setMessages((prev) => [...prev, errMsg]);
        refreshInfo();
      },
      onConnectionLost: () => {
        finalizeTurn();
      },
    });

    esRef.current = es;

    sendPublicChat(token, text).catch((err) => {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      setIsProcessing(false);
      commitSegments([]);
      const errMsg: ChatMessage = { role: "assistant", content: `发送失败：${(err as Error).message}`, created_at: new Date().toISOString() };
      setMessages((prev) => [...prev, errMsg]);
      refreshInfo();
    });
  }, [isProcessing, token, commitSegments, finalizeTurn, refreshInfo]);

  const handleStop = useCallback(() => {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    // 截断运行中的 segment
    const truncated = segmentsRef.current.map((s) =>
      s.type === "tool" && s.status === "running" ? { ...s, status: "completed" as const } : s
    );
    segmentsRef.current = truncated;
    const built = buildFinalMessage(truncated);
    setIsProcessing(false);
    commitSegments([]);
    if (built && built.length > 0) {
      setMessages((prev) => [...prev, ...built]);
    }
    refreshInfo();
  }, [buildFinalMessage, commitSegments, refreshInfo]);

  // 清理 SSE
  useEffect(() => {
    return () => {
      if (esRef.current) { esRef.current.close(); }
    };
  }, []);

  const remaining = info?.remaining ?? 0;
  const limit = info?.limit ?? 0;
  const exhausted = info !== null && remaining === 0;

  // ─── 令牌无效 ───
  if (tokenError) {
    return (
      <div className="h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center space-y-2 max-w-sm px-4">
          <div className="text-4xl">🔒</div>
          <h2 className="text-lg font-semibold text-gray-700">链接已失效</h2>
          <p className="text-sm text-gray-400">{tokenError}。请联系分享者获取新的链接。</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-50">
      {/* 顶栏 */}
      <header className="border-b border-gray-200 bg-white px-4 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-gray-800">Graph Explorer</span>
          {info && (
            <span className="text-xs text-gray-400">· {info.label}</span>
          )}
        </div>
        {info && (
          <span className={`text-xs px-2.5 py-1 rounded-full ${exhausted ? "bg-red-50 text-red-600" : remaining <= 1 ? "bg-amber-50 text-amber-600" : "bg-gray-100 text-gray-500"}`}>
            剩余 {remaining}/{limit} 次
          </span>
        )}
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-4 space-y-6">
          {/* Demo 展示区（只读） */}
          <section className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-2">
              <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
              案例展示
            </h3>
            {demoLoading ? (
              <div className="text-sm text-gray-400 py-8 text-center">加载案例中...</div>
            ) : demo ? (
              <DemoSessionView session={demo} />
            ) : (
              <div className="text-sm text-gray-400 py-8 text-center bg-white rounded-xl border border-gray-100">
                暂未配置展示案例
              </div>
            )}
          </section>

          {/* HR 对话区 */}
          {(messages.length > 0 || isProcessing) && (
            <section className="space-y-3">
              <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-green-400" />
                我的对话
              </h3>
              <div className="space-y-4">
                {messages.map((msg, i) => (
                  <MessageBubble key={i} message={msg} />
                ))}
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
                      return <ExplorationBlock key={seg.tool_use_id} segment={seg} />;
                    })}
                  </div>
                )}
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
            </section>
          )}
        </div>
      </div>

      {/* 输入框 */}
      {exhausted ? (
        <div className="border-t border-gray-200 bg-white p-4">
          <div className="max-w-3xl mx-auto text-center text-sm text-gray-400">
            本链接的使用次数已用完，如需继续请联系分享者。
          </div>
        </div>
      ) : (
        <ChatInput onSend={handleSend} isProcessing={isProcessing} onStop={handleStop} />
      )}
    </div>
  );
}

// ─── Demo 会话只读渲染 ───

function DemoSessionView({ session }: { session: Session }) {
  const msgs = session.messages ?? [];
  if (msgs.length === 0) {
    return <div className="text-sm text-gray-400 py-4">该案例暂无内容</div>;
  }
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-4 space-y-3">
      <div className="text-sm text-gray-500 font-medium pb-1 border-b border-gray-50">
        {session.title}
      </div>
      {msgs.map((msg, i) => (
        <MessageBubble key={i} message={msg} />
      ))}
    </div>
  );
}

// ─── 实时探索块 ───

function ExplorationBlock({ segment }: { segment: Extract<TurnSegment, { type: "tool" }> }) {
  const isRunning = segment.status === "running";
  const hasAnalysisSteps = segment.steps.some(
    (s) => s.type === "analyzing_events" || s.type === "extracting_findings" || s.type === "building_threads" || s.type === "validating"
  );

  return (
    <div className="ml-4 border-l-2 border-blue-200 pl-3 py-1 space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 font-medium">
          {hasAnalysisSteps ? "探索 & 分析" : "探索中"}
        </span>
        {isRunning && <span className="text-xs text-blue-600 animate-pulse">进行中</span>}
        {segment.status === "completed" && <span className="text-xs text-green-600">已完成</span>}
        {segment.status === "error" && <span className="text-xs text-red-600">{segment.error ?? "失败"}</span>}
      </div>
      {segment.steps.map((step, i) => (
        <StepProgress key={i} step={step} />
      ))}
      {segment.result && (
        <div className="mt-2">
          <ExplorationResultInline summary={segment.result} />
        </div>
      )}
    </div>
  );
}
