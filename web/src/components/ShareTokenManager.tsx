import { useState, useEffect, useCallback } from "react";
import {
  listShareTokens,
  createShareToken,
  setShareTokenDisabled,
  deleteShareToken,
  getShareTokenSessions,
  deleteShareTokenSessions,
  buildShareLink,
  getSettings,
  updateSettings,
  listSessions,
  type ShareTokenInfo,
  type Session,
} from "../api";
import type { SessionSummary } from "../api";
import { MessageBubble } from "./MessageBubble";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 分享令牌管理（admin）。
 * 创建带使用次数限制的链接，发给访客即可访问 /s/<token>。
 * 支持查看/清除访客多会话对话数据，删除令牌时级联清理全部访客会话。
 */
export function ShareTokenManager({ open, onClose }: Props) {
  const [tokens, setTokens] = useState<ShareTokenInfo[]>([]);
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState(5);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 展示会话（Demo）
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [demoSessionId, setDemoSessionId] = useState("");
  const [demoSaving, setDemoSaving] = useState(false);

  // 访客会话查看（多会话）
  const [expandedToken, setExpandedToken] = useState<string | null>(null);
  const [viewingSessions, setViewingSessions] = useState<Session[]>([]);
  const [viewingLoading, setViewingLoading] = useState(false);
  const [viewingActiveIdx, setViewingActiveIdx] = useState(0);
  const [clearingToken, setClearingToken] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listShareTokens();
      setTokens(list);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setError(null);
    refresh();
    listSessions().then(setSessions).catch(() => setSessions([]));
    getSettings().then((s) => setDemoSessionId(s.web.demo_session_id ?? "")).catch(() => {});
  }, [open, refresh]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    setError(null);
    try {
      await createShareToken(label.trim() || "未命名", limit);
      setLabel("");
      setLimit(5);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [label, limit, refresh]);

  const handleToggleDisabled = useCallback(async (t: ShareTokenInfo) => {
    try {
      await setShareTokenDisabled(t.token, !t.disabled);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refresh]);

  const handleDelete = useCallback(async (t: ShareTokenInfo) => {
    const sessionCount = t.session_ids.length;
    const confirmMsg = sessionCount > 0
	      ? `确认删除令牌「${t.label}」？该链接将立即失效，同时删除全部 ${sessionCount} 个访客会话数据。`
      : `确认删除令牌「${t.label}」？该链接将立即失效。`;
    if (!confirm(confirmMsg)) return;
    try {
      const result = await deleteShareToken(t.token);
      if (!result.deleted) {
        setError("删除失败：令牌不存在");
        return;
      }
      await refresh();
      if (expandedToken === t.token) {
        setExpandedToken(null);
        setViewingSessions([]);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refresh, expandedToken]);

  const handleCopy = useCallback(async (t: ShareTokenInfo) => {
    const link = buildShareLink(t.token);
    try {
      await navigator.clipboard.writeText(link);
      setCopied(t.token);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setError("复制失败，请手动复制");
    }
  }, []);

  // 查看访客对话（多会话）
  const handleViewSessions = useCallback(async (t: ShareTokenInfo) => {
    if (expandedToken === t.token) {
      setExpandedToken(null);
      setViewingSessions([]);
      return;
    }
    setExpandedToken(t.token);
    setViewingActiveIdx(0);
    if (t.session_ids.length === 0) {
      setViewingSessions([]);
      return;
    }
    setViewingLoading(true);
    try {
      const sessions = await getShareTokenSessions(t.token);
      setViewingSessions(sessions);
    } catch {
      setViewingSessions([]);
    } finally {
      setViewingLoading(false);
    }
  }, [expandedToken]);

  // 清除全部访客对话
  const handleClearSessions = useCallback(async (t: ShareTokenInfo) => {
    const count = t.session_ids.length;
    if (!confirm(`确认清除「${t.label}」的全部 ${count} 个访客会话？配额将重置为 ${t.usage_limit} 次。`)) return;
    setClearingToken(t.token);
    try {
      await deleteShareTokenSessions(t.token);
      await refresh();
      setExpandedToken(null);
      setViewingSessions([]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setClearingToken(null);
    }
  }, [refresh]);

  const handleDemoChange = useCallback(async (sessionId: string) => {
    setDemoSessionId(sessionId);
    setDemoSaving(true);
    try {
      await updateSettings({ web: { demo_session_id: sessionId || null } });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDemoSaving(false);
    }
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 my-8 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">分享链接</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {/* 展示会话（Demo）选择 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">展示案例</legend>
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">选择会话作为演示案例</label>
            <select
              value={demoSessionId}
              onChange={(e) => handleDemoChange(e.target.value)}
              disabled={demoSaving}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white disabled:opacity-50"
            >
              <option value="">未选择</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({new Date(s.updated_at).toLocaleDateString()})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400">访客通过分享链接可只读查看此会话（不计次数）{demoSaving && " · 保存中..."}</p>
          </div>
        </div>

        {/* 创建表单 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">新建链接</legend>
          <div className="flex gap-2 items-end">
            <div className="flex-1 space-y-1.5">
              <label className="block text-xs text-gray-500">标签（如 张三）</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="张三"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="w-28 space-y-1.5">
              <label className="block text-xs text-gray-500">使用次数</label>
              <input
                type="number"
                min={1}
                value={limit}
                onChange={(e) => setLimit(Math.max(1, Number(e.target.value) || 1))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              {creating ? "创建中..." : "创建"}
            </button>
          </div>
        </div>

        {error && <p className="text-sm text-red-500">{error}</p>}

        {/* 令牌列表 */}
        <div className="space-y-2">
          {tokens.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-6">暂无分享链接</p>
          ) : (
            tokens.map((t) => {
              const remaining = Math.max(0, t.usage_limit - t.usage_count);
              const link = buildShareLink(t.token);
              const isExpanded = expandedToken === t.token;
              const sessionCount = t.session_ids.length;
              const hasSessions = sessionCount > 0;
              return (
                <div key={t.token} className={`border rounded-lg p-3 space-y-2 ${t.disabled ? "border-gray-200 bg-gray-50 opacity-60" : "border-gray-200"}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700">{t.label}</span>
                      {t.disabled && <span className="text-xs text-red-500">已禁用</span>}
                    </div>
                    <div className="flex items-center gap-3">
                      {hasSessions && (
                        <span className="text-xs text-gray-400" title={`${sessionCount} 个访客会话`}>
                          💬 {sessionCount} 个会话
                        </span>
                      )}
                      <span className={`text-xs ${remaining === 0 ? "text-red-500" : "text-gray-500"}`}>
                        剩余 {remaining}/{t.usage_limit} 次
                      </span>
                    </div>
                  </div>
                  {/* 链接 + 复制 */}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      readOnly
                      value={link}
                      className="flex-1 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-600 font-mono"
                      onFocus={(e) => e.target.select()}
                    />
                    <button
                      onClick={() => handleCopy(t)}
                      className="px-3 py-1.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 whitespace-nowrap"
                    >
                      {copied === t.token ? "已复制" : "复制链接"}
                    </button>
                  </div>
                  {/* 操作 */}
                  <div className="flex gap-2 flex-wrap items-center">
                    <button
                      onClick={() => handleToggleDisabled(t)}
                      className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
                    >
                      {t.disabled ? "启用" : "禁用"}
                    </button>
                    {hasSessions && (
                      <>
                        <button
                          onClick={() => handleViewSessions(t)}
                          className={`text-xs px-2 py-1 rounded ${isExpanded ? "text-blue-600 bg-blue-50" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"}`}
                        >
                          {isExpanded ? "收起对话" : "查看对话"}
                        </button>
                        <button
                          onClick={() => handleClearSessions(t)}
                          disabled={clearingToken === t.token}
                          className="text-xs px-2 py-1 text-amber-500 hover:text-amber-600 hover:bg-amber-50 rounded disabled:opacity-50"
                        >
                          {clearingToken === t.token ? "清除中..." : "清除全部"}
                        </button>
                      </>
                    )}
                    <button
                      onClick={() => handleDelete(t)}
                      className="text-xs px-2 py-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      删除
                    </button>
                    {t.last_used_at && (
                      <span className="text-xs text-gray-400 ml-auto">
                        最近使用 {new Date(t.last_used_at).toLocaleString()}
                      </span>
                    )}
                  </div>

                  {/* 展开的访客多会话查看区 */}
                  {isExpanded && (
                    <div className="border-t border-gray-100 pt-3 mt-2 space-y-2">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
                          访客会话记录 ({viewingSessions.length})
                        </h4>
                      </div>
                      {viewingLoading ? (
                        <p className="text-xs text-gray-400 py-3 text-center">加载中...</p>
                      ) : !hasSessions ? (
                        <p className="text-xs text-gray-400 py-3 text-center">暂无访客会话</p>
                      ) : viewingSessions.length === 0 ? (
                        <p className="text-xs text-gray-400 py-3 text-center">暂无消息</p>
                      ) : (
                        <>
                          {/* 会话 tab 切换 */}
                          {viewingSessions.length > 1 && (
                            <div className="flex gap-1 overflow-x-auto pb-1">
                              {viewingSessions.map((s, idx) => (
                                <button
                                  key={s.id}
                                  onClick={() => setViewingActiveIdx(idx)}
                                  className={`text-xs px-2.5 py-1 rounded-full shrink-0 transition-colors ${
                                    idx === viewingActiveIdx
                                      ? "bg-blue-100 text-blue-700"
                                      : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                                  }`}
                                >
                                  {s.title} ({s.messages?.length ?? 0})
                                </button>
                              ))}
                            </div>
                          )}
                          {/* 当前选中会话的消息 */}
                          {viewingSessions[viewingActiveIdx] && (
                            <div className="max-h-64 overflow-y-auto space-y-2 bg-gray-50 rounded-lg p-3">
                              {(viewingSessions[viewingActiveIdx].messages ?? []).length === 0 ? (
                                <p className="text-xs text-gray-400 text-center py-2">暂无消息</p>
                              ) : (
                                viewingSessions[viewingActiveIdx].messages!.map((msg, i) => (
                                  <MessageBubble key={i} message={msg} />
                                ))
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
          <p className="text-xs text-blue-600 leading-relaxed">
            查看演示会话不计次数；访客每发送一条消息消耗 1 次配额（跨会话共享）。删除链接时将同时清除所有访客会话数据。
          </p>
        </div>

        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">关闭</button>
        </div>
      </div>
    </div>
  );
}
