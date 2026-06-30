// 用户会话 token 管理
//
// 用户登录后下发独立的会话 token（cookie 名 fin-trace-user），
// 区别于管理员的 fin-trace-admin-token。
//
// 存储: 内存 Map（重启后所有用户需重新登录）。
// 验证期可接受；未来如需持久化，可落盘 data/user-sessions.json。

import { randomBytes } from "node:crypto";

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

interface SessionEntry {
  userId: string;
  expires: number;
}

// sessionToken → { userId, expires }
const sessions = new Map<string, SessionEntry>();

/** 定期清理过期 token（每 10 分钟）*/
setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of sessions) {
    if (entry.expires < now) sessions.delete(token);
  }
}, 10 * 60 * 1000).unref?.();

/** 创建新会话 token 并关联 userId */
export function createSessionToken(userId: string): string {
  const token = randomBytes(24).toString("base64url");
  sessions.set(token, { userId, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

/** 校验 token，返回 userId；过期或不存在返回 null */
export function getUserIdFromToken(token: string): string | null {
  const entry = sessions.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return entry.userId;
}

/** 撤销单个 token（登出） */
export function revokeSessionToken(token: string): void {
  sessions.delete(token);
}

/** 撤销某用户的所有 token（禁用用户、改密码时用） */
export function revokeAllUserSessions(userId: string): void {
  for (const [token, entry] of sessions) {
    if (entry.userId === userId) sessions.delete(token);
  }
}

/** Cookie 名 */
export const USER_COOKIE_NAME = "fin-trace-user";
