import { useState, useEffect, useCallback } from "react";
import {
  register, accountLogin, getAccountConfig,
  type AccountConfig,
} from "../api";

interface Props {
  /** "login" 或 "register" */
  mode: "login" | "register";
}

/**
 * 用户登录/注册页。
 * 双 tab 切换，移动端优先，借鉴 AdminGate 的表单样式但更完整。
 * 注册/登录成功后跳转 /app。
 */
export function UserAuthPage({ mode: initialMode }: Props) {
  const [mode, setMode] = useState<"login" | "register">(initialMode);
  const [config, setConfig] = useState<AccountConfig | null>(null);

  // 表单字段
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [displayName, setDisplayName] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 加载注册配置（判断是否需邀请码）
  useEffect(() => {
    getAccountConfig()
      .then(setConfig)
      .catch(() => setConfig({ registration_enabled: true, invite_code_required: false }));
  }, []);

  const needInviteCode = config?.invite_code_required ?? false;

  const handleSubmit = useCallback(async () => {
    setError(null);
    if (!email.trim() || !password) {
      setError("请填写邮箱和密码");
      return;
    }
    if (mode === "register" && needInviteCode && !inviteCode.trim()) {
      setError("请填写邀请码");
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "register") {
        if (config?.registration_enabled === false) {
          setError("注册已关闭");
          return;
        }
        await register(email.trim(), password, inviteCode.trim() || undefined, displayName.trim() || undefined);
        // 注册成功 → 新手引导页（首次使用）
        window.location.href = "/onboarding";
      } else {
        await accountLogin(email.trim(), password);
        // 登录成功 → 直接进 app（老用户不需引导）
        window.location.href = "/app";
      }
    } catch (err) {
      setError((err as Error).message || "操作失败");
    } finally {
      setSubmitting(false);
    }
  }, [mode, email, password, inviteCode, displayName, needInviteCode, config]);

  return (
    <div className="h-dvh flex items-center justify-center bg-gray-50 px-4">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 w-full max-w-sm overflow-hidden">
        {/* 品牌头部 */}
        <div className="text-center pt-8 pb-4 space-y-2">
          <div className="flex justify-center">
            <svg className="w-12 h-12" viewBox="0 0 48 48" fill="none" aria-hidden="true">
              <rect width="48" height="48" rx="10" fill="#863bff" />
              <path d="M27 10L14 27h7l-2 11 13-17h-7l2-11z" fill="#fff" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold text-gray-800">Graph Explorer</h1>
        </div>

        {/* Tab 切换 */}
        <div className="flex border-b border-gray-200">
          {(["login", "register"] as const).map((m) => (
            <button
              key={m}
              onClick={() => { setMode(m); setError(null); }}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                mode === m
                  ? "text-blue-600 border-b-2 border-blue-600"
                  : "text-gray-500 hover:text-gray-700"
              }`}
            >
              {m === "login" ? "登录" : "注册"}
            </button>
          ))}
        </div>

        {/* 表单 */}
        <div className="p-6 space-y-3">
          {mode === "register" && (
            <div className="space-y-1.5">
              <label className="block text-xs text-gray-500">昵称（可选）</label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="如何称呼你"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          <div className="space-y-1.5">
            <label className="block text-xs text-gray-500">邮箱</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              placeholder="you@example.com"
              autoFocus
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs text-gray-500">
              密码{mode === "register" && "（至少 8 位）"}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
              placeholder="••••••••"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {mode === "register" && needInviteCode && (
            <div className="space-y-1.5">
              <label className="block text-xs text-gray-500">邀请码</label>
              <input
                type="text"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
                placeholder="邀请码"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          )}

          {error && <p className="text-xs text-red-500 text-center pt-1">{error}</p>}

          <button
            onClick={handleSubmit}
            disabled={submitting || !email.trim() || !password}
            className="w-full px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {submitting ? "处理中..." : mode === "login" ? "登录" : "注册"}
          </button>

          <div className="pt-2 text-center">
            <a href="/app" className="text-xs text-gray-400 hover:text-gray-600">返回首页</a>
          </div>
        </div>
      </div>
    </div>
  );
}
