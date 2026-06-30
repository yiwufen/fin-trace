// HTTP Cookie 工具 — 从请求头解析、设置/清除响应 cookie
//
// 现有 src/api.ts 里有私有 parseCookie/extractAdminToken，本模块抽成通用版，
// 供 admin（旧）和 user（新）鉴权共用，避免重复。

import type { IncomingMessage, ServerResponse } from "node:http";

/** 从 Cookie 头中提取指定名称的值 */
export function getCookie(req: IncomingMessage, name: string): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}

interface SetCookieOptions {
  /** 生命周期（秒）。不设 = session cookie */
  maxAge?: number;
  /** 生产环境加 Secure */
  secure?: boolean;
}

/** 设置 httpOnly + SameSite=Strict cookie */
export function setCookie(
  res: ServerResponse,
  name: string,
  value: string,
  options: SetCookieOptions = {},
): void {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
  ];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** 清除 cookie（设 Max-Age=0） */
export function clearCookie(res: ServerResponse, name: string): void {
  res.setHeader("Set-Cookie", `${name}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

/** 判断是否为生产环境（影响 Secure 标志） */
export function isProductionSecure(): boolean {
  return process.env.NODE_ENV === "production";
}
