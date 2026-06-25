import { useState, useEffect, useCallback } from "react";
import {
  listShareTokens,
  createShareToken,
  setShareTokenDisabled,
  deleteShareToken,
  buildShareLink,
  type ShareTokenInfo,
} from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * 分享令牌管理（admin）。
 * 创建带使用次数限制的链接，发给 HR 即可访问 /s/<token>。
 */
export function ShareTokenManager({ open, onClose }: Props) {
  const [tokens, setTokens] = useState<ShareTokenInfo[]>([]);
  const [label, setLabel] = useState("");
  const [limit, setLimit] = useState(5);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    if (!confirm(`确认删除令牌「${t.label}」？该链接将立即失效。`)) return;
    try {
      await deleteShareToken(t.token);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }, [refresh]);

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

        {/* 创建表单 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">新建链接</legend>
          <div className="flex gap-2 items-end">
            <div className="flex-1 space-y-1.5">
              <label className="block text-xs text-gray-500">标签（如 HR-张三）</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="HR-张三"
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
              return (
                <div key={t.token} className={`border rounded-lg p-3 space-y-2 ${t.disabled ? "border-gray-200 bg-gray-50 opacity-60" : "border-gray-200"}`}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-gray-700">{t.label}</span>
                      {t.disabled && <span className="text-xs text-red-500">已禁用</span>}
                    </div>
                    <span className={`text-xs ${remaining === 0 ? "text-red-500" : "text-gray-500"}`}>
                      剩余 {remaining}/{t.usage_limit} 次
                    </span>
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
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleToggleDisabled(t)}
                      className="text-xs px-2 py-1 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded"
                    >
                      {t.disabled ? "启用" : "禁用"}
                    </button>
                    <button
                      onClick={() => handleDelete(t)}
                      className="text-xs px-2 py-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                    >
                      删除
                    </button>
                    {t.last_used_at && (
                      <span className="text-xs text-gray-400 ml-auto self-center">
                        最近使用 {new Date(t.last_used_at).toLocaleString()}
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="bg-blue-50 border border-blue-100 rounded-lg p-3">
          <p className="text-xs text-blue-600 leading-relaxed">
            查看演示会话不计次数；HR 每发送一条消息消耗 1 次配额。
          </p>
        </div>

        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">关闭</button>
        </div>
      </div>
    </div>
  );
}
