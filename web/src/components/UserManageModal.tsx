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
  disabled: boolean;
  created_at: string;
}

interface FullSettings {
  web?: {
    invite_codes?: string[];
    user_signup_quota?: number;
    user_registration_enabled?: boolean;
  };
}

/**
 * 用户管理面板（admin）。
 * 验证期精简版：生成邀请码、查看注册用户、开关注册。
 * 用户禁用/调额度需后端补端点（当前先展示，后续扩展）。
 */
export function UserManageModal({ open, onClose }: Props) {
  const [inviteCodes, setInviteCodes] = useState<string[]>([]);
  const [quota, setQuota] = useState(20);
  const [registrationEnabled, setRegistrationEnabled] = useState(true);
  const [users, setUsers] = useState<UserInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      // 设置 + 用户列表
      const [s, usersRes] = await Promise.all([
        getSettings() as Promise<FullSettings>,
        fetch("/api/admin/users").then((r) => r.ok ? r.json() : []).catch(() => []) as Promise<UserInfo[]>,
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

  // 生成新邀请码
  const handleGenerateCode = useCallback(async () => {
    const code = Math.random().toString(36).slice(2, 10);
    const newCodes = [...inviteCodes, code];
    setInviteCodes(newCodes);
    await saveSettings({ invite_codes: newCodes });
  }, [inviteCodes]);

  // 删除邀请码
  const handleDeleteCode = useCallback(async (code: string) => {
    const newCodes = inviteCodes.filter((c) => c !== code);
    setInviteCodes(newCodes);
    await saveSettings({ invite_codes: newCodes });
  }, [inviteCodes]);

  // 保存设置
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

  const handleSaveQuota = useCallback(() => {
    saveSettings({ user_signup_quota: quota });
  }, [quota, saveSettings]);

  const handleToggleRegistration = useCallback(() => {
    const newVal = !registrationEnabled;
    setRegistrationEnabled(newVal);
    saveSettings({ user_registration_enabled: newVal });
  }, [registrationEnabled, saveSettings]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl mx-4 my-8 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">用户管理</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>

        {loading && <p className="text-sm text-gray-400 text-center py-4">加载中...</p>}

        {/* 注册开关 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">注册设置</legend>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-600">开放注册</span>
            <button
              onClick={handleToggleRegistration}
              disabled={saving}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                registrationEnabled ? "bg-blue-600" : "bg-gray-300"
              }`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                registrationEnabled ? "translate-x-6" : "translate-x-1"
              }`} />
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
            <button
              onClick={handleSaveQuota}
              disabled={saving}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 whitespace-nowrap"
            >
              保存
            </button>
          </div>
        </div>

        {/* 邀请码管理 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">邀请码</legend>
            <button
              onClick={handleGenerateCode}
              disabled={saving}
              className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              + 生成
            </button>
          </div>
          {inviteCodes.length === 0 ? (
            <p className="text-xs text-gray-400 py-2">
              暂无邀请码。{registrationEnabled ? "当前开放注册，无需邀请码" : "注册已关闭"}
            </p>
          ) : (
            <div className="space-y-1.5">
              {inviteCodes.map((code) => (
                <div key={code} className="flex items-center gap-2">
                  <code className="flex-1 px-2 py-1.5 bg-gray-50 border border-gray-200 rounded text-xs text-gray-700 font-mono">
                    {code}
                  </code>
                  <button
                    onClick={() => handleDeleteCode(code)}
                    className="text-xs px-2 py-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded"
                  >
                    删除
                  </button>
                </div>
              ))}
              <p className="text-xs text-gray-400 pt-1">
                配置了邀请码后，新用户注册必须填写其中之一。
              </p>
            </div>
          )}
        </div>

        {/* 用户列表 */}
        <div className="border border-gray-200 rounded-lg p-4 space-y-2">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">
            注册用户 ({users.length})
          </legend>
          {users.length === 0 ? (
            <p className="text-xs text-gray-400 py-2 text-center">暂无注册用户</p>
          ) : (
            users.map((u) => (
              <div key={u.id} className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
                <div className="min-w-0">
                  <p className="text-sm text-gray-800 truncate">
                    {u.display_name}
                    {u.disabled && <span className="ml-2 text-xs text-red-500">已禁用</span>}
                  </p>
                  <p className="text-xs text-gray-400 truncate">{u.email}</p>
                </div>
                <div className="text-xs text-gray-500 shrink-0 ml-2">
                  {Math.max(0, u.usage_limit - u.usage_count)}/{u.usage_limit} 次
                </div>
              </div>
            ))
          )}
        </div>

        {message && <p className="text-sm text-center text-blue-600">{message}</p>}

        <div className="flex justify-end pt-1">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">关闭</button>
        </div>
      </div>
    </div>
  );
}
