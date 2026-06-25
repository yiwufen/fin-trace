import { useState, useEffect, useCallback } from "react";
import { getAdminToken, setAdminToken, checkAdminRequired } from "../api";

interface Props {
  children: React.ReactNode;
}

type GateState = "checking" | "required" | "open";

/**
 * 后端配置了 admin_token 时，要求输入管理令牌才能进入管理 UI。
 * 支持 ?admin=<token> 深链自动登录。
 * 后端未配置 admin_token（本地开发）时直接放行。
 */
export function AdminGate({ children }: Props) {
  const [state, setState] = useState<GateState>("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 启动时判断：后端是否需要门禁，以及本地是否已有有效 token
  useEffect(() => {
    // 深链登录：?admin=<token>
    const params = new URLSearchParams(window.location.search);
    const deepToken = params.get("admin");
    if (deepToken) {
      setAdminToken(deepToken);
      // 清掉 url 中的 token，避免泄露
      const url = new URL(window.location.href);
      url.searchParams.delete("admin");
      window.history.replaceState({}, "", url.toString());
    }

    checkAdminRequired().then((required) => {
      if (!required) {
        setState("open");
        return;
      }
      // 后端需要门禁 — 检查本地是否已有 token（已登录过）
      if (getAdminToken()) {
        setState("open");
      } else {
        setState("required");
      }
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    setError(null);
    setAdminToken(input.trim());
    // 用新 token 验证
    const required = await checkAdminRequired();
    if (required) {
      // 仍然 401 → token 错误
      setError("令牌无效");
    } else {
      setState("open");
    }
  }, [input]);

  if (state === "checking") {
    return (
      <div className="h-screen flex items-center justify-center text-gray-400 text-sm">
        验证访问权限...
      </div>
    );
  }

  if (state === "open") {
    return <>{children}</>;
  }

  return (
    <div className="h-screen flex items-center justify-center bg-gray-50">
      <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-sm space-y-4">
        <div className="text-center space-y-1">
          <div className="text-2xl">🔐</div>
          <h2 className="text-lg font-semibold text-gray-800">管理后台</h2>
          <p className="text-xs text-gray-400">请输入管理令牌</p>
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
          disabled={!input.trim()}
          className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          进入
        </button>
      </div>
    </div>
  );
}
