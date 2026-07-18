import { useState, useEffect, useCallback } from "react";
import { login, checkAuth } from "../api";

interface Props {
  children: React.ReactNode;
}

type GateState = "checking" | "required" | "open" | "error";

/**
 * 后端配置了 admin_token 时，要求输入管理令牌才能进入管理 UI。
 * 通过 httpOnly Cookie 管理认证状态（XSS 无法窃取）。
 * 后端未配置 admin_token（本地开发）时直接放行。
 *
 * 健壮性：checkAuth 自带 8s 超时 + try/catch，永不 reject。
 * 但仍加一层 .catch 兜底，并在请求失败（status.error）或极端异常时
 * 切换到 error 态，展示"无法连接服务器"+重试按钮，避免永久卡在"验证访问权限..."。
 */
export function AdminGate({ children }: Props) {
  const [state, setState] = useState<GateState>("checking");
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    checkAuth()
      .then((status) => {
        if (cancelled) return;
        if (status.error) {
          // 请求失败（网络/超时）→ 展示错误态，而非误判为本地开发放行
          setState("error");
        } else if (!status.required) {
          // 后端未配置 admin_token，直接放行
          setState("open");
        } else if (status.authenticated) {
          // Cookie 中已有有效 token
          setState("open");
        } else {
          setState("required");
        }
      })
      .catch(() => {
        // checkAuth 自带 try/catch，此处理论上不触发；兜底防 res.json() 异常等极端情况
        if (!cancelled) setState("error");
      });
    return () => { cancelled = true; };
  }, [retryKey]);

  const retry = useCallback(() => {
    setState("checking");
    setRetryKey((k) => k + 1);
  }, []);

  const handleSubmit = useCallback(async () => {
    setError(null);
    try {
      const result = await login(input.trim());
      if (result.ok) {
        setState("open");
      } else {
        setError("令牌无效");
      }
    } catch (err) {
      setError("令牌无效");
    }
  }, [input]);

  if (state === "checking") {
    return (
      <div className="h-dvh flex items-center justify-center text-gray-400 text-sm">
        验证访问权限...
      </div>
    );
  }

  if (state === "open") {
    return <>{children}</>;
  }

  if (state === "error") {
    return (
      <div className="h-dvh flex items-center justify-center bg-gray-50">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 w-full max-w-sm space-y-4 text-center">
          <div className="text-2xl">⚠️</div>
          <h2 className="text-lg font-semibold text-gray-800">无法连接服务器</h2>
          <p className="text-xs text-gray-400">验证服务不可用，请检查网络或后端服务后重试。</p>
          <button
            onClick={retry}
            className="w-full px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-dvh flex items-center justify-center bg-gray-50">
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
