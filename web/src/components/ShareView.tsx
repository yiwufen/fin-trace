import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ChatMessage, ChatContentBlock, TurnSegment,
  StepEvent, ToolStartEvent, ExplorationSummary,
} from "../types";
import {
  getPublicTokenInfo, sendPublicChat, createPublicSSEConnection,
  listPublicSessions, createPublicSession, getPublicSessionMessages, deletePublicSession,
  getPublicSessionStatus,
  type PublicTokenInfo, type TokenSessionSummary,
} from "../api";
import { ChatView } from "./ChatView";

interface Props {
  token: string;
}

// ─── 每会话持久状态（存在 ref Map 中，切换视图不丢失）───

interface SessionData {
  messages: ChatMessage[];
  isProcessing: boolean;
  segments: TurnSegment[];
  es: EventSource | null;
  /** SSE 断线后正在尝试重连（区别于正常处理中） */
  reconnecting: boolean;
  /** 重连定时器句柄（用于清理） */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** 重连尝试次数 */
  reconnectAttempts: number;
}

function createSessionData(): SessionData {
  return { messages: [], isProcessing: false, segments: [], es: null, reconnecting: false, reconnectTimer: null, reconnectAttempts: 0 };
}

/**
 * 访客视图（通过 /s/<token> 访问）。
 * 布局与主页面一致：左侧会话列表 + 右侧聊天区域。
 * 第一个默认会话不可删除。
 * SSE 连接跨会话存活 — 切换会话只改视图指针，不杀连接。
 */
export function ShareView({ token }: Props) {
  // 配额
  const [info, setInfo] = useState<PublicTokenInfo | null>(null);
  const [tokenError, setTokenError] = useState<string | null>(null);

  // ─── 动态 manifest：让 Android 安装后保留 /s/:token 作为启动 URL ───
  // 静态 manifest.webmanifest 的 start_url 是 "/"，会丢失 token 身份。
  // 挂载时生成 blob manifest，覆盖 <link rel=manifest> 指向，保留当前路径。
  useEffect(() => {
    const link = document.querySelector('link[rel="manifest"]') as HTMLLinkElement | null;
    if (!link) return;
    const originalHref = link.href;

    fetch("/manifest.webmanifest")
      .then((r) => r.json())
      .then((manifest) => {
        const customized = {
          ...manifest,
          start_url: window.location.pathname,
          scope: window.location.pathname,
        };
        const blob = new Blob([JSON.stringify(customized)], { type: "application/manifest+json" });
        link.href = URL.createObjectURL(blob);
      })
      .catch(() => { /* 静态 manifest 回退 */ });

    return () => { link.href = originalHref; };
  }, []);

  // 会话列表
  const [sessions, setSessions] = useState<TokenSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // 每会话状态 — source of truth，独立于组件挂载/卸载
  const sessionsRef = useRef<Map<string, SessionData>>(new Map());
  const activeIdRef = useRef<string | null>(null);

  // 侧栏开关（移动端抽屉）
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 当前活跃会话的 React 视图状态（从 sessionsRef 同步）
  const [viewMessages, setViewMessages] = useState<ChatMessage[]>([]);
  const [viewProcessing, setViewProcessing] = useState(false);
  const [viewSegments, setViewSegments] = useState<TurnSegment[]>([]);
  const [reconnectingBanner, setReconnectingBanner] = useState(false);

  /** 从 sessionsRef 同步 React 视图状态（仅当 sessionId 是当前活跃会话时） */
  const syncView = useCallback((sessionId: string) => {
    if (activeIdRef.current !== sessionId) return;
    const data = sessionsRef.current.get(sessionId);
    if (!data) return;
    setViewMessages([...data.messages]);
    setViewProcessing(data.isProcessing);
    setViewSegments([...data.segments]);
    setReconnectingBanner(!!data.reconnecting);
  }, []);

  const refreshInfo = useCallback(async () => {
    const i = await getPublicTokenInfo(token);
    if (!i) { setTokenError("链接无效或已禁用"); return; }
    setInfo(i);
    setTokenError(null);
  }, [token]);

  // ─── SSE 连接工厂（回调更新 sessionsRef，通过 syncView 驱动视图）───

  const connectSSE = useCallback((sessionId: string): EventSource => {
    const es = createPublicSSEConnection(token, sessionId, {
      onTextDelta: (t) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const segs = d.segments;
        const last = segs[segs.length - 1];
        if (last && last.type === "text") {
          last.text += t;
        } else {
          segs.push({ type: "text", text: t, streaming: true });
        }
        syncView(sessionId);
      },
      onToolStart: (e) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const segs = d.segments;
        const last = segs[segs.length - 1];
        if (last && last.type === "text") last.streaming = false;
        const ev = e as ToolStartEvent;
        segs.push({ type: "tool", tool_use_id: ev.tool_use_id, tool_name: ev.tool_name, args: ev.args, steps: [], result: null, status: "running" });
        syncView(sessionId);
      },
      onToolResult: (e) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const ev = e as { tool_use_id?: string; result?: ExplorationSummary; is_error?: boolean; error?: string };
        const tid = ev.tool_use_id;
        if (!tid) return;
        d.segments = d.segments.map((s) => {
          if (s.type === "tool" && s.tool_use_id === tid) {
            if (ev.result) return { ...s, result: ev.result, status: "completed" as const };
            if (ev.is_error) return { ...s, status: "error" as const, error: ev.error };
          }
          return s;
        });
        syncView(sessionId);
      },
      onStep: (e) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const ev = e as StepEvent;
        const tid = ev.tool_use_id;
        if (!tid) return;
        d.segments = d.segments.map((s) => {
          if (s.type === "tool" && s.tool_use_id === tid) {
            return { ...s, steps: [...s.steps, ev] };
          }
          return s;
        });
        syncView(sessionId);
      },
      onFinalize: () => {},
      onMessageComplete: () => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        // 用当前 segments 构建最终消息
        const segs = d.segments;
        if (segs.length > 0) {
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
          if (assistantBlocks.length > 0) {
            d.messages.push({ role: "assistant", content: assistantBlocks, created_at: new Date().toISOString() });
          }
          if (toolResultBlocks.length > 0) {
            d.messages.push({ role: "user", content: toolResultBlocks, created_at: new Date().toISOString() });
          }
        }
        if (d.es) { d.es.close(); d.es = null; }
        d.isProcessing = false;
        d.segments = [];
        syncView(sessionId);
        refreshInfo();
        listPublicSessions(token).then(setSessions).catch(() => {});
      },
      onError: (error) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const errMsg: ChatMessage = { role: "assistant", content: `处理出错：${error}`, created_at: new Date().toISOString() };
        d.messages.push(errMsg);
        if (d.es) { d.es.close(); d.es = null; }
        d.isProcessing = false;
        d.segments = [];
        syncView(sessionId);
        refreshInfo();
      },
      onConnectionLost: () => {
        const d = sessionsRef.current.get(sessionId);
        if (!d || !d.isProcessing) return;
        // 不判死：后端探索可能仍在跑。标记重连中，启动指数退避。
        if (d.es) { d.es.close(); d.es = null; }
        d.reconnecting = true;
        syncView(sessionId);

        // 指数退避：5s → 10s → 20s，每次查后端真实状态
        const scheduleRecover = (attempt: number) => {
          if (attempt >= 3) {
            // 重试耗尽，最后查一次 status 决定命运
            recoverRef.current?.(sessionId);
            return;
          }
          const delay = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s
          d.reconnectTimer = setTimeout(() => {
            const cur = sessionsRef.current.get(sessionId);
            if (!cur || !cur.isProcessing) return;
            cur.reconnectAttempts = attempt + 1;
            recoverRef.current?.(sessionId);
          }, delay);
        };
        scheduleRecover(0);
      },
    });
    return es;
  }, [token, syncView, refreshInfo]);

  // ─── 完成一轮处理 ───
  const finishTurn = useCallback((sessionId: string) => {
    const d = sessionsRef.current.get(sessionId);
    if (!d) return;
    if (d.es) { d.es.close(); d.es = null; }
    if (d.reconnectTimer) { clearTimeout(d.reconnectTimer); d.reconnectTimer = null; }
    d.isProcessing = false;
    d.reconnecting = false;
    d.reconnectAttempts = 0;
    d.segments = [];
    syncView(sessionId);
    refreshInfo();
    listPublicSessions(token).then(setSessions).catch(() => {});
  }, [syncView, refreshInfo, token]);

  // ─── 断线恢复核心：查后端真实状态，决定重连还是收尾 ───
  // 通过 ref 暴露给 connectSSE 的 onConnectionLost（避免循环依赖）
  const recoverRef = useRef<((sessionId: string) => void) | null>(null);

  const attemptRecover = useCallback(async (sessionId: string) => {
    const d = sessionsRef.current.get(sessionId);
    if (!d || !d.isProcessing) return;

    const { running } = await getPublicSessionStatus(token, sessionId);
    if (!d.isProcessing) return; // 期间可能已被 finishTurn

    if (running) {
      // 后端仍在跑 → 重连 SSE，buffer 会重放完整事件流（含 text_delta）
      d.reconnecting = true;
      d.reconnectAttempts = 0;
      if (d.reconnectTimer) { clearTimeout(d.reconnectTimer); d.reconnectTimer = null; }
      // 清空 segments，重连后由 buffer 重放重建（避免新旧事件拼接错乱）
      d.segments = [];
      syncView(sessionId);
      d.es = connectSSE(sessionId);
    } else {
      // 后端已结束 → 拉取最终结果，正常收尾
      const res = await getPublicSessionMessages(token, sessionId);
      if (!d.isProcessing) return;
      d.messages = res.messages;
      finishTurn(sessionId);
    }
  }, [token, connectSSE, syncView, finishTurn]);

  // 暴露给 onConnectionLost
  useEffect(() => { recoverRef.current = attemptRecover; }, [attemptRecover]);

  // ─── 页面重新可见时，对活跃会话做断线恢复 ───
  // 移动端用户切后台/锁屏后回来，SSE 往往已断；此处复核后端真实状态。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const id = activeIdRef.current;
      if (!id) return;
      const d = sessionsRef.current.get(id);
      if (!d || !d.isProcessing) return;
      // 仅当 SSE 已断（CLOSED 或 null）才恢复，避免重复重连
      if (d.es && d.es.readyState !== EventSource.CLOSED) return;
      attemptRecover(id);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [attemptRecover]);

  // ─── 初次加载 ───
  useEffect(() => {
    let cancelled = false;

    async function init() {
      // 加载配额信息
      const tokenInfo = await getPublicTokenInfo(token);
      if (cancelled) return;
      if (!tokenInfo) { setTokenError("链接无效或已禁用"); return; }
      setInfo(tokenInfo);

      let list: TokenSessionSummary[];
      try {
        list = await listPublicSessions(token);
      } catch { if (!cancelled) setLoaded(true); return; }
      if (cancelled) return;

      if (list.length === 0) {
        try {
          const created = await createPublicSession(token);
          list = [{ id: created.id, title: created.title, created_at: created.created_at, updated_at: created.created_at, message_count: 0 }];
        } catch { if (!cancelled) setLoaded(true); return; }
      }
      if (cancelled) return;
      setSessions(list);

      // 加载所有会话的消息（并行）
      await Promise.all(list.map(async (s) => {
        try {
          const res = await getPublicSessionMessages(token, s.id);
          const data = createSessionData();
          data.messages = res.messages;
          sessionsRef.current.set(s.id, data);
          // 如果后端仍在处理，重建 SSE 连接
          if (res.processing) {
            data.isProcessing = true;
            data.es = connectSSE(s.id);
          }
        } catch {
          sessionsRef.current.set(s.id, createSessionData());
        }
      }));
      if (cancelled) return;

      const firstId = list[0].id;
      activeIdRef.current = firstId;
      setActiveSessionId(firstId);
      syncView(firstId);
      setLoaded(true);
    }

    init();
    return () => { cancelled = true; };
  }, [token, syncView, connectSSE]);

  // ─── 发送消息 ───
  const handleSend = useCallback((text: string) => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;

    let data = sessionsRef.current.get(sessionId);
    if (!data) {
      data = createSessionData();
      sessionsRef.current.set(sessionId, data);
    }
    // 重连中或处理中：禁止重发，避免后端 409 + 状态错乱
    if (data.isProcessing) return;

    data.isProcessing = true;
    data.reconnecting = false;
    data.reconnectAttempts = 0;
    data.segments = [];

    const userMsg: ChatMessage = { role: "user", content: text, created_at: new Date().toISOString() };
    data.messages.push(userMsg);
    syncView(sessionId);

    // 建立 SSE 连接
    data.es = connectSSE(sessionId);

    // 等待 SSE connected 事件后发送 HTTP 请求
    data.es.addEventListener("connected", () => {
      sendPublicChat(token, text, sessionId).catch((err) => {
        console.error("[share] send error:", err);
        finishTurn(sessionId);
      });
    }, { once: true });
  }, [token, connectSSE, syncView, finishTurn]);

  // ─── 停止 ───
  const handleStop = useCallback(() => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const d = sessionsRef.current.get(sessionId);
    if (!d?.isProcessing) return;
    if (d.es) { d.es.close(); d.es = null; }
    // 截断运行中的 segment
    d.segments = d.segments.map((s) =>
      s.type === "tool" && s.status === "running" ? { ...s, status: "completed" as const } : s
    );
    finishTurn(sessionId);
  }, [finishTurn]);

  // ─── 会话切换：只改视角，不动 SSE ───
  const switchToSession = useCallback(async (sessionId: string) => {
    activeIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setSidebarOpen(false);

    // 确保 sessionsRef 中有该会话的数据（懒初始化 + 懒加载消息）
    let data = sessionsRef.current.get(sessionId);
    if (!data) {
      data = createSessionData();
      sessionsRef.current.set(sessionId, data);
      // 懒加载消息
      try {
        const res = await getPublicSessionMessages(token, sessionId);
        data.messages = res.messages;
        if (res.processing && !data.isProcessing) {
          data.isProcessing = true;
          data.es = connectSSE(sessionId);
        }
      } catch { /* ignore */ }
    } else {
      // data 已存在：复核后端真实状态（修复切回卡死的假完成）
      // 仅当本地认为不在处理、或 SSE 已断但可能仍在跑时查询
      const sseBroken = !data.es || data.es.readyState === EventSource.CLOSED;
      if (sseBroken) {
        try {
          const { running } = await getPublicSessionStatus(token, sessionId);
          if (running && !data.isProcessing) {
            data.isProcessing = true;
            data.segments = [];
            data.es = connectSSE(sessionId);
          } else if (!running && data.isProcessing) {
            // 后端已结束但本地仍显示处理中 → 拉最终结果收尾
            const res = await getPublicSessionMessages(token, sessionId);
            data.messages = res.messages;
            finishTurn(sessionId);
          }
        } catch { /* ignore */ }
      }
    }
    syncView(sessionId);
  }, [token, syncView, connectSSE, finishTurn]);

  // ─── 会话操作 ───
  const [creatingSession, setCreatingSession] = useState(false);
  const handleCreateSession = useCallback(async () => {
    setCreatingSession(true);
    try {
      const s = await createPublicSession(token);
      sessionsRef.current.set(s.id, createSessionData());
      setSessions((prev) => [...prev, {
        id: s.id, title: s.title,
        created_at: s.created_at, updated_at: s.created_at, message_count: 0,
      }]);
      await switchToSession(s.id);
    } catch (err) {
      setTokenError((err as Error).message);
    } finally {
      setCreatingSession(false);
    }
  }, [token, switchToSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (sessions.length <= 1 || sessions[0]?.id === sessionId) return;
    if (!confirm("确认删除此会话？对话记录将无法恢复。")) return;
    try {
      // 先关闭 SSE 并清理
      const d = sessionsRef.current.get(sessionId);
      if (d?.es) { d.es.close(); }
      sessionsRef.current.delete(sessionId);

      await deletePublicSession(token, sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (activeIdRef.current === sessionId && remaining.length > 0) {
        await switchToSession(remaining[0].id);
      }
    } catch (err) {
      setTokenError((err as Error).message);
    }
  }, [sessions, token, switchToSession]);

  // 清理
  useEffect(() => {
    return () => {
      sessionsRef.current.forEach((d) => {
        if (d.reconnectTimer) clearTimeout(d.reconnectTimer);
        if (d.es) d.es.close();
      });
    };
  }, []);

  // ─── 令牌无效 ───
  if (tokenError) {
    return (
      <div className="h-dvh flex items-center justify-center bg-gray-50">
        <div className="text-center space-y-2 max-w-sm px-4">
          <div className="flex justify-center">
            <svg className="w-12 h-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h2 className="text-lg font-semibold text-gray-700">链接已失效</h2>
          <p className="text-xs text-gray-400">{tokenError}。请联系分享者获取新的链接。</p>
        </div>
      </div>
    );
  }

  if (!loaded) {
    return (
      <div className="h-dvh flex items-center justify-center bg-gray-50">
        <p className="text-gray-400 text-sm">加载中...</p>
      </div>
    );
  }

  const remaining = info?.remaining ?? 0;
  const limit = info?.limit ?? 0;
  const exhausted = info !== null && remaining === 0;

  return (
    <div className="h-dvh flex bg-gray-50">
      {/* 移动端遮罩 */}
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      {/* 左侧会话列表 */}
      <aside className={`fixed md:relative z-40 inset-y-0 left-0 w-64 border-r border-gray-200 bg-white flex flex-col shrink-0 transition-transform duration-300 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-3 border-b border-gray-200 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm text-gray-700">会话</span>
            <button
              onClick={handleCreateSession}
              disabled={creatingSession || exhausted}
              className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {creatingSession ? "..." : "+ 新会话"}
            </button>
          </div>
          {info && (
            <div className="flex items-center gap-2 text-xs text-gray-400">
              <span>{info.label}</span>
              <span className={`${exhausted ? "text-red-500" : remaining <= 1 ? "text-amber-500" : ""}`}>
                剩余 {remaining}/{limit}
              </span>
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {sessions.map((s, idx) => {
            const isActive = s.id === activeSessionId;
            const isFirst = idx === 0;
            const sd = sessionsRef.current.get(s.id);
            const running = sd?.isProcessing ?? false;
            return (
              <div
                key={s.id}
                className={`px-3 py-2.5 cursor-pointer border-b border-gray-100 group ${
                  isActive ? "bg-blue-50 border-l-2 border-l-blue-600" : "hover:bg-gray-50"
                }`}
                onClick={() => {
                  if (s.id !== activeSessionId) switchToSession(s.id);
                }}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">
                      {running && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5 animate-pulse" />}
                      {s.title}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {formatTime(s.updated_at)}
                    </p>
                  </div>
                  {!isFirst && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                      className="text-gray-400 hover:text-red-500 text-xs opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                      title="删除会话"
                    >×</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </aside>

      {/* 右侧聊天区域 */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* 移动端顶栏 */}
        <div className="md:hidden flex items-center px-3 py-2 border-b border-gray-200 bg-white shrink-0">
          <button
            onClick={() => setSidebarOpen(true)}
            className="p-2 -ml-2 rounded-lg hover:bg-gray-100 text-gray-500"
            aria-label="打开会话列表"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
          <span className="ml-2 text-sm font-medium text-gray-700 truncate">
            {info?.label ?? "Graph Explorer"}
          </span>
        </div>
        <ChatView
          sessionId={activeSessionId ?? ""}
          messages={viewMessages}
          isProcessing={viewProcessing}
          segments={viewSegments}
          onSend={exhausted ? () => {} : handleSend}
          onStop={handleStop}
          reconnecting={reconnectingBanner}
        />
        {/* 重连提示横幅：SSE 断线后正在恢复 */}
        {reconnectingBanner && (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 shrink-0">
            <div className="max-w-3xl mx-auto flex items-center gap-2 text-xs text-amber-700">
              <svg className="w-4 h-4 animate-spin shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              <span>连接中断，正在恢复探索进度…</span>
            </div>
          </div>
        )}
        {exhausted && (
          <div className="border-t border-gray-200 bg-white p-4 shrink-0">
            <div className="max-w-3xl mx-auto text-center space-y-2">
              <p className="text-sm text-gray-400">本链接的使用次数已用完</p>
              <p className="text-xs text-gray-300">如需继续请联系分享者获取新的链接</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return d.toLocaleDateString("zh-CN");
}
