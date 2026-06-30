import { useState, useEffect, useCallback } from "react";
import { getSettings, updateSettings } from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface UserInfo {
  id: string;
  email: string;
  display_name: string;
  usage_limit: number;
  usage_count: number;
  session_count: number;
  disabled: boolean;
  created_at: string;
  last_active_at: string | null;
}

interface FullSettings {
  web?: {
    invite_codes?: string[];
    user_signup_quota?: number;
    user_registration_enabled?: boolean;
  };
}

type SortKey = "recent" | "usage" | "created";
type FilterKey = "all" | "active" | "exhausted" | "inactive" | "disabled";

/**
 * 用户管理面板（admin）。
 * 投放就绪包：用量统计、活跃度排序/筛选、重置密码、邀请码管理。
 * 隐私边界：只展示统计，不展示对话内容。
 */
export function UserManageModal({ open, onClose }: Props) {
  const [inviteCodes, setInviteCodes] = useState<string[]>([]);
  const [quota, setQuota] = useState(20);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("recent");
  const [filterKey, setFilterKey] = useState<FilterKey>("all");

  // 重置密码对话框状态
  const [resetTarget, setResetTarget] = useState<UserInfo | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetting, setResetting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, usersRes] = await Promise.all([
        getSettings() as Promise<FullSettings>,
        fetch("/api/admin/users").then((r) => (r.ok ? r.json() : [])).catch(() => []) as Promise<UserInfo[]>,
      ]);
      setInviteCodes(s.web?.invite_codes ?? []);
      setQuota(s.web?.user_signup_quota ?? 20);
      setRegistrationEnabled(s.web?.user_registration_enabled !== false);
      setUsers(usersRes);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setMessage(null);
    refresh();
  }, [open, refresh]);

  const saveSettings = useCallback(async (patch: NonNullable<FullSettings["web"]>) => {
    setSaving(true);
    setMessage(null);
    try {
      await updateSettings({ web: patch });
      setMessage("已保存");
      setTimeout(() => setMessage(null), 1500);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, []);

  const handleGenerateCode = useCallback(async () => {
    const code = Math.random().toString(36).slice(2, 10);
    const newCodes = [...inviteCodes, code];
    setInviteCodes(newCodes);
    await saveSettings({ invite_codes: newCodes });
  }, [inviteCodes, saveSettings]);

  const handleDeleteCode = useCallback(async (code: string) => {
    const newCodes = inviteCodes.filter((c) => c !== code);
    setInviteCodes(newCodes);
    await saveSettings({ invite_codes: newCodes });
  }, [inviteCodes, saveSettings]);

  const handleSaveQuota = useCallback(() => {
    saveSettings({ user_signup_quota: quota });
  }, [quota, saveSettings]);

  const handleToggleRegistration = useCallback(() => {
    const newVal = !registrationEnabled;
    setRegistrationEnabled(newVal);
    saveSettings({ user_registration_enabled: newVal });
  }, [registrationEnabled, saveSettings]);

  // 用户操作：禁用/启用、调额度、重置密码
  const patchUser = useCallback(
    async (userId: string, patch: Record<string, unknown>) => {
      setMessage(null);
      try {
        const res = await fetch(`/api/admin/users/${userId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        await refresh();
        setMessage("操作成功");
        setTimeout(() => setMessage(null), 1500);
      } catch (err) {
        setMessage((err as Error).message);
      }
    },
    [refresh],
  );

  const handleToggleDisable = useCallback(
    (u: UserInfo) => {
      patchUser(u.id, { disabled: !u.disabled });
    },
    [patchUser],
  );

  const handleAdjustQuota = useCallback(
    (u: UserInfo, delta: number) => {
      patchUser(u.id, { usage_limit: Math.max(0, u.usage_limit + delta) });
    },
    [patchUser],
  );

  const handleResetPassword = useCallback(async () => {
    if (!resetTarget) return;
    if (newPassword.length < 8) {
      setMessage("密码至少 8 位");
      return;
    }
    setResetting(true);
    try {
      await patchUser(resetTarget.id, { new_password: newPassword });
      setResetTarget(null);
      setNewPassword("");
    } finally {
      setResetting(false);
    }
  }, [resetTarget, newPassword, patchUser]);

  // 过滤 + 排序
  const filteredUsers = users
    .filter((u) => {
      const remaining = u.usage_limit - u.usage_count;
      switch (filterKey) {
        case "active":
          return u.last_active_at !== null && remaining > 0 && !u.disabled;
        case "exhausted":
          return remaining <= 0 && !u.disabled;
        case "inactive":
          return u.last_active_at === null && !u.disabled;
        case "disabled":
          return u.disabled;
        default:
          return true;
      }
    })
    .sort((a, b) => {
      switch (sortKey) {
        case "usage":
          return b.usage_count - a.usage_count;
        case "created":
          return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case "recent":
        default:
          return new Date(b.last_active_at ?? 0).getTime() - new Date(a.last_active_at ?? 0).getTime();
      }
    });

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-3xl mx-4 my-8 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">用户管理</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {loading && <p className="text-sm text-gray-400 text-center py-4">加载中...</p>}

        {/* 注册设置 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">注册设置</legend>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">开放注册</span>
            <button
              onClick={handleToggleRegistration}
              disabled={saving}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${registrationEnabled ? "bg-blue-600" : "bg-gray-300"}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${registrationEnabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>
          <div className="flex items-end gap-2">
            <div className="flex-1 space-y-1">
              <label className="block text-xs text-gray-500">新用户注册赠送额度</label>
              <input
                type="number"
                min={0}
                value={quota}
                onChange={(e) => setQuota(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button onClick={handleSaveQuota} disabled={saving} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap">保存</button>
          </div>
        </div>

        {/* 邀请码 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">邀请码</legend>
            <button onClick={handleGenerateCode} disabled={saving} className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">+ 生成</button>
          </div>
          {inviteCodes.length === 0 ? (
            <p className="text-xs text-gray-400 py-2">暂无邀请码。{registrationEnabled ? "当前开放注册，无需邀请码" : "注册已关闭"}</p>
          ) : (
            <div className="space-y-1.5">
              {inviteCodes.map((code) => (
                <div key={code} className="flex items-center gap-2">
                  <code className="flex-1 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 font-mono">{code}</code>
                  <button onClick={() => handleDeleteCode(code)} className="text-xs px-2 py-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded">删除</button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 用户列表 + 统计 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">注册用户 ({filteredUsers.length}/{users.length})</legend>
            <div className="flex items-center gap-2 text-xs">
              <select value={filterKey} onChange={(e) => setFilterKey(e.target.value as FilterKey)} className="border border-gray-300 rounded px-2 py-1">
                <option value="all">全部</option>
                <option value="active">活跃中</option>
                <option value="exhausted">已用完</option>
                <option value="inactive">从未使用</option>
                <option value="disabled">已禁用</option>
              </select>
              <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} className="border border-gray-300 rounded px-2 py-1">
                <option value="recent">最近活跃</option>
                <option value="usage">用量高</option>
                <option value="created">注册时间</option>
              </select>
            </div>
          </div>

          {filteredUsers.length === 0 ? (
            <p className="text-xs text-gray-400 py-2 text-center">{users.length === 0 ? "暂无注册用户" : "无符合条件的用户"}</p>
          ) : (
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {filteredUsers.map((u) => {
                const remaining = u.usage_limit - u.usage_count;
                return (
                  <div key={u.id} className={`p-3 rounded-lg border ${u.disabled ? "bg-gray-50 border-gray-200 opacity-60" : "border-gray-200"}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="text-sm text-gray-800 truncate font-medium">{u.display_name}</p>
                          {u.disabled && <span className="text-xs text-red-500">已禁用</span>}
                          {remaining <= 0 && !u.disabled && <span className="text-xs text-amber-600">已用完</span>}
                        </div>
                        <p className="text-xs text-gray-400 truncate">{u.email}</p>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-gray-500">
                          <span>
                            剩余 <strong className={remaining <= 3 ? "text-amber-600" : "text-gray-700"}>{remaining}</strong>/{u.usage_limit}
                          </span>
                          <span>· 会话 {u.session_count}</span>
                          <span>· 注册 {formatDate(u.created_at)}</span>
                          <span>· {u.last_active_at ? `活跃 ${formatRelative(u.last_active_at)}` : "从未使用"}</span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1 shrink-0">
                        <div className="flex items-center gap-1">
                          <button onClick={() => handleAdjustQuota(u, 10)} title="+10 次" className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 text-gray-600">+10</button>
                          <button onClick={() => setResetTarget(u)} title="重置密码" className="text-xs px-2 py-1 border border-gray-300 rounded hover:bg-gray-50 text-gray-600">密码</button>
                          <button
                            onClick={() => handleToggleDisable(u)}
                            title={u.disabled ? "启用" : "禁用"}
                            className={`text-xs px-2 py-1 border rounded ${u.disabled ? "border-green-300 text-green-600 hover:bg-green-50" : "border-red-300 text-red-500 hover:bg-red-50"}`}
                          >
                            {u.disabled ? "启用" : "禁用"}
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {message && <p className="text-sm text-center text-blue-600">{message}</p>}

        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">关闭</button>
        </div>
      </div>

      {/* 重置密码对话框 */}
      {resetTarget && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40" onClick={() => setResetTarget(null)}>
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm mx-4 p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-gray-800">重置密码</h3>
            <p className="text-xs text-gray-500">
              为 <strong>{resetTarget.display_name}</strong> ({resetTarget.email}) 设置新密码。用户需用新密码重新登录。
            </p>
            <input
              type="text"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密码（至少 8 位）"
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <div className="flex justify-end gap-2">
              <button onClick={() => { setResetTarget(null); setNewPassword(""); }} className="px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">取消</button>
              <button onClick={handleResetPassword} disabled={resetting || newPassword.length < 8} className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {resetting ? "重置中..." : "确认重置"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}天前`;
  return formatDate(iso);
}
