import { useState, useCallback, useRef, useEffect } from "react";
import type {
  ChatMessage, ChatContentBlock, TurnSegment,
  StepEvent, ToolStartEvent, ExplorationSummary,
} from "../types";
import {
  getMe, accountLogout,
  listUserSessions, createUserSession, getUserSessionMessages, deleteUserSessionApi,
  getUserSessionStatus, sendUserChat, createUserSSEConnection,
  type AccountUser, type UserSessionSummary,
} from "../api";
import { ChatView } from "./ChatView";

/**
 * 用户会话界面（登录后访问 /app）。
 * 以 ShareView 为骨架，去掉 token 概念，改为 user-based：
 *   - 用户信息（email、剩余额度）从 getMe 获取
 *   - 会话 CRUD 用 listUserSessions/createUserSession 等
 *   - SSE/chat/status 复用断线恢复逻辑
 *
 * 与 ShareView 的差异：
 *   - 无 token、无动态 manifest
 *   - 配额用完显示"联系管理员"
 *   - 顶栏显示用户邮箱 + 登出按钮
 */
export function UserApp() {
  const [user, setUser] = useState<AccountUser | null>(null);
  const [sessions, setSessions] = useState<UserSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // 每会话状态 — source of truth
  const sessionsRef = useRef<Map<string, SessionData>>(new Map());
  const activeIdRef = useRef<string | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 视图状态
  const [viewMessages, setViewMessages] = useState<ChatMessage[]>([]);
  const [viewProcessing, setViewProcessing] = useState(false);
  const [viewSegments, setViewSegments] = useState<TurnSegment[]>([]);
  const [reconnectingBanner, setReconnectingBanner] = useState(false);

  interface SessionData {
    messages: ChatMessage[];
    isProcessing: boolean;
    segments: TurnSegment[];
    es: EventSource | null;
    reconnecting: boolean;
    reconnectTimer: ReturnType<typeof setTimeout> | null;
  }

  function createSessionData(): SessionData {
    return { messages: [], isProcessing: false, segments: [], es: null, reconnecting: false, reconnectTimer: null };
  }

  const syncView = useCallback((sessionId: string) => {
    if (activeIdRef.current !== sessionId) return;
    const data = sessionsRef.current.get(sessionId);
    if (!data) return;
    setViewMessages([...data.messages]);
    setViewProcessing(data.isProcessing);
    setViewSegments([...data.segments]);
    setReconnectingBanner(!!data.reconnecting);
  }, []);

  const refreshUser = useCallback(async () => {
    const me = await getMe();
    if (me) {
      setUser(me.user);
      setSessions(me.sessions);
    }
  }, []);

  // ─── SSE 连接工厂 ───
  const connectSSE = useCallback((sessionId: string): EventSource => {
    const es = createUserSSEConnection(sessionId, {
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
        d.reconnecting = false;
        d.segments = [];
        syncView(sessionId);
        refreshUser();
        listUserSessions().then(setSessions).catch(() => {});
      },
      onError: (error) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const errMsg: ChatMessage = { role: "assistant", content: `处理出错：${error}`, created_at: new Date().toISOString() };
        d.messages.push(errMsg);
        if (d.es) { d.es.close(); d.es = null; }
        d.isProcessing = false;
        d.reconnecting = false;
        d.segments = [];
        syncView(sessionId);
        refreshUser();
      },
      onConnectionLost: () => {
        const d = sessionsRef.current.get(sessionId);
        if (!d || !d.isProcessing) return;
        if (d.es) { d.es.close(); d.es = null; }
        d.reconnecting = true;
        syncView(sessionId);
        const scheduleRecover = (attempt: number) => {
          if (attempt >= 3) {
            recoverRef.current?.(sessionId);
            return;
          }
          const delay = 5000 * Math.pow(2, attempt);
          d.reconnectTimer = setTimeout(() => {
            const cur = sessionsRef.current.get(sessionId);
            if (!cur || !cur.isProcessing) return;
            recoverRef.current?.(sessionId);
          }, delay);
        };
        scheduleRecover(0);
      },
    });
    return es;
  }, [syncView, refreshUser]);

  // ─── 完成 turn ───
  const finishTurn = useCallback((sessionId: string) => {
    const d = sessionsRef.current.get(sessionId);
    if (!d) return;
    if (d.es) { d.es.close(); d.es = null; }
    if (d.reconnectTimer) { clearTimeout(d.reconnectTimer); d.reconnectTimer = null; }
    d.isProcessing = false;
    d.reconnecting = false;
    d.segments = [];
    syncView(sessionId);
    refreshUser();
    listUserSessions().then(setSessions).catch(() => {});
  }, [syncView, refreshUser]);

  // ─── 断线恢复 ───
  const recoverRef = useRef<((sessionId: string) => void) | null>(null);

  const attemptRecover = useCallback(async (sessionId: string) => {
    const d = sessionsRef.current.get(sessionId);
    if (!d || !d.isProcessing) return;
    const { running } = await getUserSessionStatus(sessionId);
    if (!d.isProcessing) return;
    if (running) {
      d.reconnecting = true;
      if (d.reconnectTimer) { clearTimeout(d.reconnectTimer); d.reconnectTimer = null; }
      d.segments = [];
      syncView(sessionId);
      d.es = connectSSE(sessionId);
    } else {
      const res = await getUserSessionMessages(sessionId);
      if (!d.isProcessing) return;
      d.messages = res.messages;
      finishTurn(sessionId);
    }
  }, [connectSSE, syncView, finishTurn]);

  useEffect(() => { recoverRef.current = attemptRecover; }, [attemptRecover]);

  // visibilitychange 恢复
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      const id = activeIdRef.current;
      if (!id) return;
      const d = sessionsRef.current.get(id);
      if (!d || !d.isProcessing) return;
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
      const me = await getMe();
      if (cancelled) return;
      if (!me) { window.location.href = "/login"; return; }
      setUser(me.user);

      let list = me.sessions;
      if (list.length === 0) {
        try {
          const created = await createUserSession();
          list = [{ id: created.id, title: created.title, created_at: created.created_at, updated_at: created.created_at, message_count: 0 }];
        } catch { if (!cancelled) setLoaded(true); return; }
      }
      if (cancelled) return;
      setSessions(list);

      await Promise.all(list.map(async (s) => {
        try {
          const res = await getUserSessionMessages(s.id);
          const data = createSessionData();
          data.messages = res.messages;
          sessionsRef.current.set(s.id, data);
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
  }, [syncView, connectSSE]);

  // ─── 发送消息 ───
  const handleSend = useCallback((text: string) => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    let data = sessionsRef.current.get(sessionId);
    if (!data) {
      data = createSessionData();
      sessionsRef.current.set(sessionId, data);
    }
    if (data.isProcessing) return;

    data.isProcessing = true;
    data.reconnecting = false;
    data.segments = [];

    const userMsg: ChatMessage = { role: "user", content: text, created_at: new Date().toISOString() };
    data.messages.push(userMsg);
    syncView(sessionId);

    data.es = connectSSE(sessionId);
    data.es.addEventListener("connected", () => {
      sendUserChat(sessionId, text).catch((err) => {
        console.error("[user] send error:", err);
        finishTurn(sessionId);
      });
    }, { once: true });
  }, [connectSSE, syncView, finishTurn]);

  const handleStop = useCallback(() => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const d = sessionsRef.current.get(sessionId);
    if (!d?.isProcessing) return;
    if (d.es) { d.es.close(); d.es = null; }
    d.segments = d.segments.map((s) =>
      s.type === "tool" && s.status === "running" ? { ...s, status: "completed" as const } : s
    );
    finishTurn(sessionId);
  }, [finishTurn]);

  // ─── 会话切换 ───
  const switchToSession = useCallback(async (sessionId: string) => {
    activeIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setSidebarOpen(false);

    let data = sessionsRef.current.get(sessionId);
    if (!data) {
      data = createSessionData();
      sessionsRef.current.set(sessionId, data);
      try {
        const res = await getUserSessionMessages(sessionId);
        data.messages = res.messages;
        if (res.processing && !data.isProcessing) {
          data.isProcessing = true;
          data.es = connectSSE(sessionId);
        }
      } catch { /* ignore */ }
    } else {
      const sseBroken = !data.es || data.es.readyState === EventSource.CLOSED;
      if (sseBroken) {
        try {
          const { running } = await getUserSessionStatus(sessionId);
          if (running && !data.isProcessing) {
            data.isProcessing = true;
            data.segments = [];
            data.es = connectSSE(sessionId);
          } else if (!running && data.isProcessing) {
            const res = await getUserSessionMessages(sessionId);
            data.messages = res.messages;
            finishTurn(sessionId);
          }
        } catch { /* ignore */ }
      }
    }
    syncView(sessionId);
  }, [connectSSE, syncView, finishTurn]);

  // ─── 会话操作 ───
  const [creatingSession, setCreatingSession] = useState(false);
  const handleCreateSession = useCallback(async () => {
    setCreatingSession(true);
    try {
      const s = await createUserSession();
      sessionsRef.current.set(s.id, createSessionData());
      setSessions((prev) => [...prev, {
        id: s.id, title: s.title, created_at: s.created_at, updated_at: s.created_at, message_count: 0,
      }]);
      await switchToSession(s.id);
    } catch (err) {
      console.error("[user] create session:", err);
    } finally {
      setCreatingSession(false);
    }
  }, [switchToSession]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    if (sessions.length <= 1 || sessions[0]?.id === sessionId) return;
    if (!confirm("确认删除此会话？对话记录将无法恢复。")) return;
    try {
      const d = sessionsRef.current.get(sessionId);
      if (d?.es) { d.es.close(); }
      sessionsRef.current.delete(sessionId);
      await deleteUserSessionApi(sessionId);
      const remaining = sessions.filter((s) => s.id !== sessionId);
      setSessions(remaining);
      if (activeIdRef.current === sessionId && remaining.length > 0) {
        await switchToSession(remaining[0].id);
      }
    } catch (err) {
      console.error("[user] delete session:", err);
    }
  }, [sessions, switchToSession]);

  // 登出
  const handleLogout = useCallback(async () => {
    if (!confirm("确认登出？")) return;
    await accountLogout();
    window.location.href = "/login";
  }, []);

  // 清理
  useEffect(() => {
    return () => {
      sessionsRef.current.forEach((d) => {
        if (d.reconnectTimer) clearTimeout(d.reconnectTimer);
        if (d.es) d.es.close();
      });
    };
  }, []);

  // ─── 渲染 ───
  if (!loaded) {
    return (
      <div className="h-dvh flex items-center justify-center bg-gray-50">
        <p className="text-gray-400 text-sm">加载中...</p>
      </div>
    );
  }

  const remaining = user?.remaining ?? 0;
  const exhausted = user !== null && remaining === 0;

  return (
    <div className="h-dvh flex bg-gray-50">
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}
      {/* 左侧会话列表 */}
      <aside className={`fixed md:relative z-40 inset-y-0 left-0 w-64 border-r border-gray-200 bg-white flex flex-col shrink-0 transition-transform duration-300 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-3 border-b border-gray-200 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-medium text-sm text-gray-700 truncate">{user?.display_name ?? "用户"}</span>
            <button
              onClick={handleCreateSession}
              disabled={creatingSession}
              className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {creatingSession ? "..." : "+ 新会话"}
            </button>
          </div>
          {user && (
            <div className="flex items-center justify-between text-xs text-gray-400">
              <span className={`${exhausted ? "text-red-500" : remaining <= 3 ? "text-amber-500" : ""}`}>
                剩余 {remaining} 次
              </span>
              <button onClick={handleLogout} className="text-gray-400 hover:text-gray-600">登出</button>
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
                onClick={() => { if (s.id !== activeSessionId) switchToSession(s.id); }}
              >
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">
                      {running && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5 animate-pulse" />}
                      {s.title}
                    </p>
                    <p className="text-xs text-gray-400 mt-0.5">{formatTime(s.updated_at)}</p>
                  </div>
                  {!isFirst && (
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDeleteSession(s.id); }}
                      className="text-gray-400 hover:text-red-500 text-xs p-1 rounded hover:bg-gray-100 md:opacity-0 md:group-hover:opacity-100 opacity-100 transition-opacity"
                      aria-label="删除会话"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
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
            {user?.display_name ?? "Graph Explorer"}
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
              <p className="text-sm text-gray-400">使用次数已用完</p>
              <p className="text-xs text-gray-300">如需继续使用，请联系管理员增加额度</p>
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
