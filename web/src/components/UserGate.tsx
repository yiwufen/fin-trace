import { useState, useEffect } from "react";
import { getMe } from "../api";

interface Props {
  children: React.ReactNode;
}

type GateState = "checking" | "authenticated" | "unauthenticated";

/**
 * 用户态守卫。
 * 未登录 → 重定向 /login；已登录 → 渲染 children。
 * 仿 AdminGate 模式，但用户态来自 /api/account/me（fin-trace-user cookie）。
 */
export function UserGate({ children }: Props) {
  const [state, setState] = useState<GateState>("checking");

  useEffect(() => {
    getMe().then((me) => {
      if (me) setState("authenticated");
      else {
        // 未登录，跳转登录页
        window.location.href = "/login";
      }
    }).catch(() => {
      window.location.href = "/login";
    });
  }, []);

  if (state === "checking") {
    return (
      <div className="h-dvh flex items-center justify-center text-gray-400 text-sm">
        加载中...
      </div>
    );
  }

  if (state === "authenticated") {
    return <>{children}</>;
  }

  // unauthenticated: 重定向中，渲染占位
  return (
    <div className="h-dvh flex items-center justify-center text-gray-400 text-sm">
      正在跳转登录...
    </div>
  );
}
