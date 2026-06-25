import { useState, useCallback } from "react";
import { login, logout } from "../api";

interface Props {
  onLoginSuccess: () => void;
}

/**
 * 鉴权失效浮层 — 当运行时检测到 admin token 不可靠时覆盖全屏。
 * 用户重新输入有效 token 后通过 httpOnly Cookie 认证，关闭浮层后底层 UI 状态保留不变。
 */
export function AuthOverlay({ onLoginSuccess }: Props) {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed) return;
    setError(null);
    setChecking(true);
    try {
      await login(trimmed);
      onLoginSuccess();
    } catch {
      setError("令牌无效");
      logout(); // 清除可能的残留 Cookie
    }
    setChecking(false);
  }, [input, onLoginSuccess]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-lg border border-gray-200 p-8 w-full max-w-sm space-y-4">
        <div className="text-center space-y-1">
          <div className="text-2xl">🔐</div>
          <h2 className="text-lg font-semibold text-gray-800">登录已过期</h2>
          <p className="text-xs text-gray-400">管理令牌已失效，请重新输入</p>
        </div>
        <input
          type="password"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          placeholder="admin token"
          autoFocus
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        {error && <p className="text-xs text-red-500 text-center">{error}</p>}
        <button
          onClick={handleSubmit}
          disabled={!input.trim() || checking}
          className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {checking ? "验证中..." : "重新进入"}
        </button>
      </div>
    </div>
  );
}
