import { useState, useCallback, useRef, useEffect } from "react";
import type {
  SessionSummary, ChatMessage, ChatContentBlock, StepEvent,
  ToolStartEvent, ExplorationSummary, TurnSegment,
} from "./types";
import {
  listSessions, createSession, deleteSession as deleteSessionApi,
  getSession, sendMessage, createChatSSEConnection, getSessionStatus, cancelExploration,
  AuthError, setAuthLostHandler, logout, getMe,
} from "./api";
import { SessionList } from "./components/SessionList";
import { ChatView } from "./components/ChatView";
import { SettingsModal } from "./components/SettingsModal";
import { AdminGate } from "./components/AdminGate";
import { ShareView } from "./components/ShareView";
import { ShareTokenManager } from "./components/ShareTokenManager";
import { AuthOverlay } from "./components/AuthOverlay";
import { UserAuthPage } from "./components/UserAuthPage";
import { UserGate } from "./components/UserGate";
import { UserApp } from "./components/UserApp";
import { UserManageModal } from "./components/UserManageModal";
import { OnboardingPage } from "./components/OnboardingPage";

const MAX_CACHED_SESSIONS = 10;

// ─── 每个会话的持久状态（存在 ref Map 中，切换 UI 不丢失）───

interface SessionData {
  messages: ChatMessage[];
  isProcessing: boolean;
  segments: TurnSegment[];
  es: EventSource | null;
  /** SSE 断线后正在尝试重连 */
  reconnecting: boolean;
  /** 重连定时器句柄 */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

function createSessionData(): SessionData {
  return {
    messages: [],
    isProcessing: false,
    segments: [],
    es: null,
    reconnecting: false,
    reconnectTimer: null,
  };
}

// ─── / 路径重定向：根据用户登录态分流 ───
// 未登录 → /login；已登录 → /app。
// 让 / 成为用户主入口，admin 移到 /admin，PWA 安装行为天然正确。
function RootRedirect() {
  useEffect(() => {
    getMe()
      .then((me) => {
        window.location.replace(me ? "/app" : "/login");
      })
      .catch(() => {
        window.location.replace("/login");
      });
  }, []);
  return (
    <div className="h-dvh flex items-center justify-center text-gray-400 text-sm">
      加载中...
    </div>
  );
}

// ─── App ───

export default function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // 所有会话的持久状态 — source of truth，独立于组件挂载/卸载
  const sessionsRef = useRef<Map<string, SessionData>>(new Map());
  const activeIdRef = useRef<string | null>(null);
  const messageCache = useRef<Map<string, ChatMessage[]>>(new Map());

  // 当前激活会话的 React 视图状态（用于渲染）
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [segments, setSegments] = useState<TurnSegment[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [userManageOpen, setUserManageOpen] = useState(false);
  const [authLost, setAuthLost] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // ─── 全局 401 拦截：token 失效时弹出重登浮层 ───
  useEffect(() => {
    setAuthLostHandler(() => {
      logout();
      // 关闭活跃的 SSE 连接，避免其 error 回调干扰
      const activeId = activeIdRef.current;
      if (activeId) {
        const data = sessionsRef.current.get(activeId);
        if (data?.es) { data.es.close(); data.es = null; }
        if (data) { data.isProcessing = false; data.segments = []; }
      }
      setAuthLost(true);
    });
    return () => setAuthLostHandler(null as unknown as (() => void));
  }, []);

  // ─── 工具函数 ───

  const pruneCache = () => {
    if (messageCache.current.size > MAX_CACHED_SESSIONS) {
      const keys = [...messageCache.current.keys()];
      for (const k of keys.slice(0, keys.length - MAX_CACHED_SESSIONS)) {
        messageCache.current.delete(k);
      }
    }
  };

  /** 从 sessionsRef 同步 React 视图状态（仅当 sessionId 是当前活跃会话时） */
  const syncView = useCallback((sessionId: string) => {
    if (activeIdRef.current !== sessionId) return;
    const data = sessionsRef.current.get(sessionId);
    if (!data) return;
    setChatMessages([...data.messages]);
    setIsProcessing(data.isProcessing);
    setSegments([...data.segments]);
  }, []);

  const refreshSessions = useCallback(async () => {
    const list = await listSessions();
    setSessions(list);
    setLoaded(true);
  }, []);

  /** 完成一轮处理，重置状态并同步视图 */
  const finishTurn = useCallback((sessionId: string) => {
    const data = sessionsRef.current.get(sessionId);
    if (!data) return;
    if (data.es) { data.es.close(); data.es = null; }
    if (data.reconnectTimer) { clearTimeout(data.reconnectTimer); data.reconnectTimer = null; }
    data.isProcessing = false;
    data.reconnecting = false;
    data.segments = [];

    // 同步缓存
    messageCache.current.set(sessionId, [...data.messages]);
    pruneCache();
    syncView(sessionId);

    // 刷新会话列表
    refreshSessions();
  }, [syncView, refreshSessions]);

  // ─── 断线恢复核心：查后端真实状态，决定重连还是收尾 ───
  // 通过 ref 暴露给 connectSSE 的 onConnectionLost（避免循环依赖）
  const recoverRef = useRef<((sessionId: string) => void) | null>(null);

  /** 从 segments 构建最终的 ChatMessage[] */
  const buildFinalMessage = useCallback((sessionId: string) => {
    const data = sessionsRef.current.get(sessionId);
    if (!data || !data.isProcessing) return;

    const segs = data.segments;
    if (segs.length === 0) return;

    const assistantBlocks: ChatContentBlock[] = [];
    const toolResultBlocks: { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }[] = [];

    for (const seg of segs) {
      if (seg.type === "text") {
        if (seg.text) {
          assistantBlocks.push({ type: "text", text: seg.text });
        }
      } else {
        // tool segment
        assistantBlocks.push({
          type: "tool_use",
          id: seg.tool_use_id,
          name: seg.tool_name,
          input: seg.args,
        });
        if (seg.result) {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: seg.tool_use_id,
            content: JSON.stringify(seg.result),
          });
        } else if (seg.status === "error") {
          toolResultBlocks.push({
            type: "tool_result",
            tool_use_id: seg.tool_use_id,
            content: seg.error ?? "探索失败",
            is_error: true,
          });
        }
      }
    }

    // assistant 消息：text + tool_use 块
    if (assistantBlocks.length > 0) {
      data.messages.push({
        role: "assistant",
        content: assistantBlocks,
        created_at: new Date().toISOString(),
      });
    }

    // user 消息：所有 tool_result（Anthropic API 要求）
    if (toolResultBlocks.length > 0) {
      data.messages.push({
        role: "user",
        content: toolResultBlocks,
        created_at: new Date().toISOString(),
      });
    }
  }, []);

  // ─── SSE 连接创建（可复用：发送消息 + 刷新恢复）───

  const connectSSE = useCallback((sessionId: string): EventSource => {
    const es = createChatSSEConnection(sessionId, {
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
        if (last && last.type === "text") {
          last.streaming = false;
        }
        const ev = e as ToolStartEvent;
        segs.push({
          type: "tool",
          tool_use_id: ev.tool_use_id,
          tool_name: ev.tool_name,
          args: ev.args,
          steps: [],
          result: null,
          status: "running",
        });
        syncView(sessionId);
      },

      onToolResult: (e) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const segs = d.segments;
        const ev = e as { tool_use_id?: string; result?: ExplorationSummary; is_error?: boolean; error?: string };
        const tid = ev.tool_use_id;
        if (!tid) return;
        const toolSeg = segs.find((s) => s.type === "tool" && s.tool_use_id === tid);
        if (toolSeg && toolSeg.type === "tool") {
          if (ev.result) {
            toolSeg.result = ev.result;
            toolSeg.status = "completed";
          } else if (ev.is_error) {
            toolSeg.status = "error";
            toolSeg.error = ev.error;
          }
        }
        syncView(sessionId);
      },

      onStep: (e) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const segs = d.segments;
        const ev = e as StepEvent;
        const tid = ev.tool_use_id;
        if (!tid) return;
        const toolSeg = segs.find((s) => s.type === "tool" && s.tool_use_id === tid);
        if (toolSeg && toolSeg.type === "tool") {
          toolSeg.steps = [...toolSeg.steps, ev];
        }
        syncView(sessionId);
      },

      onFinalize: () => {
        // tool_result 已携带完整 summary，finalize 仅作为完成信号
      },

      onMessageComplete: () => {
        buildFinalMessage(sessionId);
        finishTurn(sessionId);
      },

      onError: (error) => {
        const d = sessionsRef.current.get(sessionId);
        if (!d) return;
        const errMsg: ChatMessage = {
          role: "assistant",
          content: `处理出错：${error}`,
          created_at: new Date().toISOString(),
        };
        d.messages.push(errMsg);
        finishTurn(sessionId);
      },

      onConnectionLost: () => {
        const d = sessionsRef.current.get(sessionId);
        if (!d || !d.isProcessing) return;
        // 不判死：后端可能仍在跑。标记重连中，启动指数退避。
        if (d.es) { d.es.close(); d.es = null; }
        d.reconnecting = true;
        syncView(sessionId);

        const scheduleRecover = (attempt: number) => {
          if (attempt >= 3) {
            recoverRef.current?.(sessionId);
            return;
          }
          const delay = 5000 * Math.pow(2, attempt); // 5s, 10s, 20s
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
  }, [syncView, finishTurn, buildFinalMessage]);

  // attemptRecover：查后端真实状态，running 则重连 SSE，否则收尾
  const attemptRecover = useCallback(async (sessionId: string) => {
    const d = sessionsRef.current.get(sessionId);
    if (!d || !d.isProcessing) return;
    try {
      const { running } = await getSessionStatus(sessionId);
      if (!d.isProcessing) return; // 期间可能已被 finishTurn
      if (running) {
        d.reconnecting = true;
        if (d.reconnectTimer) { clearTimeout(d.reconnectTimer); d.reconnectTimer = null; }
        d.segments = [];
        d.es = connectSSE(sessionId);
        syncView(sessionId);
      } else {
        // 后端已结束 → 拉最终结果收尾
        const session = await getSession(sessionId);
        const msgs = session?.messages ?? [];
        messageCache.current.set(sessionId, msgs);
        pruneCache();
        if (d.messages.length === 0) d.messages = msgs;
        finishTurn(sessionId);
      }
    } catch {
      // 查询失败：保守收尾，避免永久卡死
      finishTurn(sessionId);
    }
  }, [connectSSE, syncView, finishTurn]);

  // 暴露给 onConnectionLost
  useEffect(() => { recoverRef.current = attemptRecover; }, [attemptRecover]);

  // ─── 页面重新可见时，对活跃会话做断线恢复 ───
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

  // ─── 核心操作：发送消息 ───

  const handleSend = useCallback((text: string) => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;

    let data = sessionsRef.current.get(sessionId);
    if (!data) {
      data = createSessionData();
      sessionsRef.current.set(sessionId, data);
    }
    if (data.isProcessing) return;

    // 重置状态
    data.isProcessing = true;
    data.segments = [];

    // 追加用户消息
    const userMsg: ChatMessage = { role: "user", content: text, created_at: new Date().toISOString() };
    data.messages.push(userMsg);
    syncView(sessionId);

    // 建立 SSE 连接
    data.es = connectSSE(sessionId);

    // 发送 HTTP 请求
    sendMessage(sessionId, text).catch((err) => {
      if (err instanceof AuthError) return; // 401 已由全局处理，避免干扰浮层
      console.error("[chat] send error:", err);
      finishTurn(sessionId);
    });
  }, [connectSSE, finishTurn]);

  const handleStop = useCallback(() => {
    const sessionId = activeIdRef.current;
    if (!sessionId) return;
    const data = sessionsRef.current.get(sessionId);
    if (!data?.isProcessing) return;

    // 通知后端取消
    cancelExploration(sessionId).catch(() => {});

    if (data.es) { data.es.close(); data.es = null; }

    // 标记正在运行的 tool segment 为 completed（截断）
    for (const seg of data.segments) {
      if (seg.type === "tool" && seg.status === "running") {
        seg.status = "completed";
      }
    }

    // 用当前 segments 构建最终消息
    buildFinalMessage(sessionId);
    finishTurn(sessionId);
  }, [finishTurn, buildFinalMessage]);

  // ─── 会话切换：只改视角，不清理数据 ───

  const selectSession = (id: string) => {
    activeIdRef.current = id;
    setActiveId(id);

    if (!sessionsRef.current.has(id)) {
      const data = createSessionData();
      const cached = messageCache.current.get(id);
      if (cached) data.messages = cached;
      sessionsRef.current.set(id, data);
    }

    const data = sessionsRef.current.get(id);

    // 本地检查：EventSource 已关闭但 isProcessing 仍为 true → 清理
    if (data?.isProcessing && data.es?.readyState === EventSource.CLOSED) {
      buildFinalMessage(id);
      finishTurn(id);
    }

    syncView(id);

    // 始终检查后端运行状态（刷新后 isProcessing 为 false 但后端可能仍在处理）
    getSessionStatus(id).then(({ running }) => {
      const d = sessionsRef.current.get(id);
      if (!d) return;
      if (running && !d.isProcessing) {
        // 后端在运行但前端不知道 → 恢复处理状态，重建 SSE 连接
        d.isProcessing = true;
        d.segments = [];
        d.es = connectSSE(id);
        syncView(id);
      } else if (!running && d.isProcessing) {
        // 后端已停止但前端仍显示处理中 → 清理
        if (d.es) { d.es.close(); d.es = null; }
        buildFinalMessage(id);
        finishTurn(id);
      }
    }).catch(() => {});

    getSession(id)
      .then((session) => {
        const msgs = session?.messages ?? [];
        messageCache.current.set(id, msgs);
        pruneCache();
        const data = sessionsRef.current.get(id);
        if (data && data.messages.length === 0 && msgs.length > 0) {
          data.messages = msgs;
          syncView(id);
        }
      })
      .catch(() => {});
  };

  // ─── 会话列表操作 ───

  useEffect(() => {
    refreshSessions().catch(() => { setSessions([]); setLoaded(true); });
  }, [refreshSessions]);

  const handleCreate = async () => {
    const s = await createSession();
    await refreshSessions();
    selectSession(s.id);
  };

  const handleDelete = async (id: string) => {
    // 如果会话正在运行，先取消
    const data = sessionsRef.current.get(id);
    if (data?.isProcessing) {
      if (data.es) { data.es.close(); data.es = null; }
      data.isProcessing = false;
      data.segments = [];
    }
    cancelExploration(id).catch(() => {});

    sessionsRef.current.delete(id);
    messageCache.current.delete(id);
    await deleteSessionApi(id);
    await refreshSessions();
    if (activeIdRef.current === id) {
      activeIdRef.current = null;
      setActiveId(null);
      setChatMessages([]);
      setIsProcessing(false);
      setSegments([]);
    }
  };

  const handleRename = (id: string, title: string) => {
    setSessions((prev) => prev.map((s) => s.id === id ? { ...s, title } : s));
  };

  // ─── 渲染 ───

  // 路由：/s/:token → 访客视图（无需 admin token）
  const path = window.location.pathname;
  const shareMatch = path.match(/^\/s\/([^/]+)$/);
  if (shareMatch) {
    return <ShareView token={shareMatch[1]} />;
  }

  // 路由：账号体系入口
  if (path === "/login") return <UserAuthPage mode="login" />;
  if (path === "/register") return <UserAuthPage mode="register" />;
  if (path === "/onboarding") return <OnboardingPage />;
  if (path === "/app" || path.startsWith("/app")) {
    return <UserGate><UserApp /></UserGate>;
  }

  // 路由：/ → 用户主入口（PWA 安装的天然起点）
  // 未登录 → 跳 /login；已登录 → 跳 /app。
  // 这让 / 的 manifest（start_url=/）安装后直接进用户流程，而非 admin。
  if (path === "/") {
    return <RootRedirect />;
  }

  // 其他非 /admin 路径 → 回用户主入口（避免暴露 admin 给误访问者）
  if (!path.startsWith("/admin")) {
    return <RootRedirect />;
  }

  if (!loaded) {
    return <div className="h-dvh flex items-center justify-center text-gray-500">Loading...</div>;
  }

  const isActiveProcessing = activeId ? isProcessing : false;

  return (
    <AdminGate>
      <div className="h-dvh flex bg-gray-50">
        {/* 移动端遮罩 */}
        {sidebarOpen && (
          <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />
        )}
        <SessionList
          sessions={sessions}
          activeId={activeId}
          sidebarOpen={sidebarOpen}
          onSelect={(id) => { selectSession(id); setSidebarOpen(false); }}
          onCreate={handleCreate}
          onDelete={handleDelete}
          onRename={handleRename}
        />
        <main className="flex-1 flex flex-col min-w-0">
          {/* 顶栏 — 移动端汉堡 + 设置 + 分享入口 */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-gray-200 bg-white">
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-2 -ml-2 rounded-lg hover:bg-gray-100 text-gray-500"
              aria-label="打开会话列表"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="flex items-center gap-4 md:ml-auto">
            <button
              onClick={() => setShareOpen(true)}
              className="text-gray-400 hover:text-gray-600 text-sm flex items-center gap-1"
              title="分享链接"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
              </svg>
              <span>分享</span>
            </button>
            <button
              onClick={() => setUserManageOpen(true)}
              className="text-gray-400 hover:text-gray-600 text-sm flex items-center gap-1"
              title="用户管理"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <span>用户</span>
            </button>
            <button
              onClick={() => setSettingsOpen(true)}
              className="text-gray-400 hover:text-gray-600 text-sm flex items-center gap-1"
              title="设置"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>设置</span>
            </button>
            </div>
          </div>
          {activeId ? (
            <ChatView
              key={activeId}
              sessionId={activeId}
              messages={chatMessages}
              isProcessing={isActiveProcessing}
              segments={segments}
              onSend={handleSend}
              onStop={handleStop}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center text-gray-400">
              <div className="text-center">
                <p className="text-lg mb-2">Graph Explorer</p>
                <p className="text-sm">选择一个会话或创建新会话开始探索</p>
              </div>
            </div>
          )}
        </main>
        <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <ShareTokenManager open={shareOpen} onClose={() => setShareOpen(false)} />
        <UserManageModal open={userManageOpen} onClose={() => setUserManageOpen(false)} />
        {authLost && <AuthOverlay onLoginSuccess={() => setAuthLost(false)} />}
      </div>
    </AdminGate>
  );
}
