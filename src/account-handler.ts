// 账号体系路由 handler — 挂载在 /api/account/*
//
// 与现有体系的关系:
//   - /api/public/* （访客 token 模式）保留不动
//   - admin 门禁（/api/sessions* 等）保留不动
//   - 本模块走独立命名空间，插入在 admin 门禁之前（免 admin 鉴权）
//
// 鉴权: 用户 cookie "fin-trace-user" → 内存会话 token → userId → User
// 用户会话端点（sessions/*）额外校验会话归属

import type { IncomingMessage, ServerResponse } from "node:http";
import {
  findUserByEmail, getUser, createUser, listUsers,
  incrementUserUsage, disableUser, setUserQuota, deleteUser,
  createUserSession, listUserSessions, getUserSession, deleteUserSession,
  type User,
} from "./user-store.js";
import { hashPassword, verifyPassword, validatePasswordStrength } from "./auth/password.js";
import {
  createSessionToken, getUserIdFromToken, revokeSessionToken, revokeAllUserSessions,
  USER_COOKIE_NAME,
} from "./auth/session.js";
import { getCookie, setCookie, clearCookie, isProductionSecure } from "./auth/cookies.js";
import { readSettings } from "./settings-store.js";
import { createLogger } from "./logger.js";

// 从 api.ts 复用的工具
import { sendJSON, readBody, CORS_HEADERS, handleChat, handleSSE, isExplorationRunning } from "./api.js";

const log = createLogger("account");
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 天，与 auth/session.ts 的 TTL 一致

// ─── 简易 IP 限流（防爆破，验证期内存计数）───
const ipHits = new Map<string, { count: number; reset: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 分钟窗口
const RATE_LIMIT_MAX = 10; // 每窗口每 IP 最多 10 次注册/登录

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  let entry = ipHits.get(ip);
  if (!entry || entry.reset < now) {
    entry = { count: 0, reset: now + RATE_LIMIT_WINDOW };
    ipHits.set(ip, entry);
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

function getClientIp(req: IncomingMessage): string {
  return (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

// ─── 鉴权辅助 ───

/** 从请求中解析已登录用户。未登录返回 null */
export function requireUser(req: IncomingMessage): User | null {
  const token = getCookie(req, USER_COOKIE_NAME);
  if (!token) return null;
  const userId = getUserIdFromToken(token);
  if (!userId) return null;
  const user = getUser(userId);
  if (!user || user.disabled) return null;
  return user;
}

/** 脱敏用户信息（不含 password_hash） */
export function publicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    display_name: user.display_name,
    usage_limit: user.usage_limit,
    usage_count: user.usage_count,
    remaining: Math.max(0, user.usage_limit - user.usage_count),
    created_at: user.created_at,
  };
}

function setUserCookie(res: ServerResponse, token: string): void {
  setCookie(res, USER_COOKIE_NAME, token, {
    maxAge: SESSION_TTL_SECONDS,
    secure: isProductionSecure(),
  });
}

// ─── 主分发 ───

export async function handleAccount(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // ─── 无需登录的端点 ───

  // POST /api/account/register
  if (path === "/api/account/register" && req.method === "POST") {
    await handleRegister(req, res);
    return;
  }

  // POST /api/account/login
  if (path === "/api/account/login" && req.method === "POST") {
    await handleLogin(req, res);
    return;
  }

  // GET /api/account/config — 注册页前置信息（是否开放注册、是否需邀请码）
  if (path === "/api/account/config" && req.method === "GET") {
    const web = readSettings().web ?? {};
    sendJSON(res, 200, {
      registration_enabled: web.user_registration_enabled !== false,
      invite_code_required: Array.isArray(web.invite_codes) && web.invite_codes.length > 0,
    });
    return;
  }

  // ─── 以下端点需登录 ───
  const user = requireUser(req);
  if (!user) {
    sendJSON(res, 401, { error: "未登录或会话已过期" });
    return;
  }

  // POST /api/account/logout
  if (path === "/api/account/logout" && req.method === "POST") {
    const token = getCookie(req, USER_COOKIE_NAME);
    if (token) revokeSessionToken(token);
    clearCookie(res, USER_COOKIE_NAME);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // GET /api/account/me
  if (path === "/api/account/me" && req.method === "GET") {
    const sessions = await listUserSessions(user.id);
    sendJSON(res, 200, { user: publicUser(user), sessions });
    return;
  }

  // ─── 用户会话管理 ───

  // GET /api/account/sessions — 列表
  const sessionsListMatch = path === "/api/account/sessions";
  if (sessionsListMatch && req.method === "GET") {
    const sessions = await listUserSessions(user.id);
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return;
  }

  // POST /api/account/sessions — 创建
  if (sessionsListMatch && req.method === "POST") {
    const body = await readBody(req);
    const { title } = JSON.parse(body || "{}");
    const session = await createUserSession(user.id, typeof title === "string" ? title : undefined);
    if (!session) {
      sendJSON(res, 500, { error: "创建会话失败" });
      return;
    }
    res.writeHead(201, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: session.id, title: session.title, created_at: session.created_at }));
    return;
  }

  // /api/account/sessions/:id/* — 需校验归属
  const sessionMatch = path.match(/^\/api\/account\/sessions\/([^/]+)(?:\/(.+))?$/);
  if (sessionMatch) {
    const sessionId = sessionMatch[1];
    const sub = sessionMatch[2]; // messages | chat | stream | status | undefined
    // 归属校验
    const owned = await getUserSession(user.id, sessionId);
    if (!owned) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    // 交给会话端点处理（阶段 3 实现，此处先占位）
    await handleSessionAction(req, res, user, sessionId, sub);
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
}

// ─── 注册 ───

async function handleRegister(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    sendJSON(res, 429, { error: "请求过于频繁，请稍后再试" });
    return;
  }

  const web = readSettings().web ?? {};
  if (web.user_registration_enabled === false) {
    sendJSON(res, 403, { error: "注册已关闭" });
    return;
  }

  const body = await readBody(req);
  const { email, password, invite_code, display_name } = JSON.parse(body || "{}");

  // 基础校验
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    sendJSON(res, 400, { error: "邮箱格式不正确" });
    return;
  }
  if (typeof password !== "string") {
    sendJSON(res, 400, { error: "密码必填" });
    return;
  }
  const pwdError = validatePasswordStrength(password);
  if (pwdError) {
    sendJSON(res, 400, { error: pwdError });
    return;
  }

  // 邀请码校验（配置了 invite_codes 才校验）
  if (Array.isArray(web.invite_codes) && web.invite_codes.length > 0) {
    if (typeof invite_code !== "string" || !web.invite_codes.includes(invite_code.trim())) {
      sendJSON(res, 403, { error: "邀请码无效" });
      return;
    }
  }

  // 邮箱唯一性
  if (findUserByEmail(email)) {
    sendJSON(res, 409, { error: "该邮箱已注册" });
    return;
  }

  // 创建用户
  const quota = web.user_signup_quota ?? 20;
  const passwordHash = await hashPassword(password);
  const user = createUser({
    email,
    password_hash: passwordHash,
    display_name: typeof display_name === "string" ? display_name : undefined,
    usage_limit: quota,
  });

  // 下发会话 token
  const token = createSessionToken(user.id);
  setUserCookie(res, token);

  log.info({ userId: user.id, email: user.email, ip }, "用户注册成功");
  sendJSON(res, 201, { user: publicUser(user) });
}

// ─── 登录 ───

async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const ip = getClientIp(req);
  if (!checkRateLimit(ip)) {
    sendJSON(res, 429, { error: "请求过于频繁，请稍后再试" });
    return;
  }

  const body = await readBody(req);
  const { email, password } = JSON.parse(body || "{}");

  if (typeof email !== "string" || typeof password !== "string") {
    sendJSON(res, 400, { error: "邮箱和密码必填" });
    return;
  }

  const user = findUserByEmail(email);
  if (!user) {
    sendJSON(res, 401, { error: "邮箱或密码错误" });
    return;
  }
  if (user.disabled) {
    sendJSON(res, 403, { error: "账号已被禁用" });
    return;
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    sendJSON(res, 401, { error: "邮箱或密码错误" });
    return;
  }

  // 下发会话 token
  const token = createSessionToken(user.id);
  setUserCookie(res, token);

  log.info({ userId: user.id, email: user.email, ip }, "用户登录成功");
  sendJSON(res, 200, { user: publicUser(user) });
}

// ─── 会话端点（messages / chat / stream / status / delete）───

async function handleSessionAction(
  req: IncomingMessage,
  res: ServerResponse,
  user: User,
  sessionId: string,
  sub: string | undefined,
): Promise<void> {
  // GET /api/account/sessions/:id/messages — 获取会话消息
  if (sub === "messages" && req.method === "GET") {
    const session = await getUserSession(user.id, sessionId);
    if (!session) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    sendJSON(res, 200, {
      messages: session.messages ?? [],
      processing: isExplorationRunning(sessionId),
    });
    return;
  }

  // POST /api/account/sessions/:id/chat — 发送消息（配额检查 + 复用 handleChat）
  if (sub === "chat" && req.method === "POST") {
    // 配额检查（在并发检查之前，避免浪费配额）
    if (user.usage_count >= user.usage_limit) {
      sendJSON(res, 403, { error: "使用次数已用完", remaining: 0, limit: user.usage_limit });
      return;
    }
    // 并发检查（不计次）
    if (isExplorationRunning(sessionId)) {
      sendJSON(res, 409, { error: "上一条消息还在处理中，请稍候", remaining: user.usage_limit - user.usage_count });
      return;
    }
    // 确认可派发 → 计次
    incrementUserUsage(user.id);
    // 预读取 body 并注入（handleChat 支持从 _preReadBody 读取，避免重复消费流）
    const body = await readBody(req);
    (req as unknown as Record<string, unknown>)._preReadBody = body;
    // 复用核心聊天逻辑（防并发、SSE 广播、断线恢复 buffer 全部共用）
    await handleChat(sessionId, req, res);
    return;
  }

  // GET /api/account/sessions/:id/stream — SSE（复用 handleSSE，断线重连 buffer 自动重放）
  if (sub === "stream" && req.method === "GET") {
    handleSSE(sessionId, req, res);
    return;
  }

  // GET /api/account/sessions/:id/status — 断线恢复状态查询
  if (sub === "status" && req.method === "GET") {
    sendJSON(res, 200, { running: isExplorationRunning(sessionId) });
    return;
  }

  // DELETE /api/account/sessions/:id — 删除会话（首个不可删）
  if (!sub && req.method === "DELETE") {
    const ok = await deleteUserSession(user.id, sessionId);
    if (!ok) {
      sendJSON(res, 404, { error: "会话不存在或不可删除" });
      return;
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  // GET /api/account/sessions/:id — 会话详情
  if (!sub && req.method === "GET") {
    const session = await getUserSession(user.id, sessionId);
    if (!session) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(session));
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
}
