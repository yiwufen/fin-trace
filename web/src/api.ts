// API client — 封装后端 HTTP 调用

import type { Session, SessionSummary, ExploreRequest, FollowupRequest, ChatMessage } from "./types";

const BASE = "/api";

// ─── 认证（Cookie-based，替代 localStorage）───
// 管理端通过 POST /api/auth/login 验证令牌，服务端设置 httpOnly Cookie。
// 后续所有同源请求（fetch + EventSource）自动携带 Cookie，无需前端手动管理 token。
// XSS 无法读取 httpOnly Cookie，相比 localStorage 更安全。
// SSE 也不再需要通过 URL 查询参数传递 token。

/** 登录：验证 admin token 并设置 Cookie */
export async function login(token: string): Promise<{ ok: boolean; required: boolean }> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

/** 登出：清除认证 Cookie */
export async function logout(): Promise<void> {
  await fetch(`${BASE}/auth/logout`, { method: "POST" }).catch(() => {});
}

export interface AuthStatus {
  required: boolean;
  authenticated: boolean;
}

/** 查询认证状态（无需鉴权） */
export async function checkAuth(): Promise<AuthStatus> {
  const res = await fetch(`${BASE}/auth/status`);
  if (!res.ok) return { required: false, authenticated: false };
  return res.json();
}

function adminHeaders(): Record<string, string> {
  return { "Content-Type": "application/json" };
}

// ─── 全局 401 拦截 ───

/** 鉴权错误 — 用于区分普通 HTTP 错误和 token 失效 */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

let onAuthLost: (() => void) | null = null;

/** 注册全局 token 失效回调（由 App 在挂载时调用） */
export function setAuthLostHandler(handler: () => void) {
  onAuthLost = handler;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: adminHeaders(),
    ...options,
  });
  if (res.status === 401) {
    onAuthLost?.();
    const body = await res.json().catch(() => ({}));
    throw new AuthError(body.error ?? "Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ─── 会话 CRUD ───

export async function listSessions(): Promise<SessionSummary[]> {
  return request("/sessions");
}

export async function createSession(title?: string): Promise<Session> {
  return request("/sessions", {
    method: "POST",
    body: JSON.stringify({ title: title || undefined }),
  });
}

export async function getSession(id: string): Promise<Session> {
  return request(`/sessions/${id}`);
}

export async function updateSession(id: string, patch: { title?: string }): Promise<Session> {
  return request(`/sessions/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export async function deleteSession(id: string): Promise<void> {
  return request(`/sessions/${id}`, { method: "DELETE" });
}

// ─── 探索 ───

export interface ExploreResponse {
  exploration_id: string;
  status: "running";
}

export async function startExploration(sessionId: string, params: ExploreRequest): Promise<ExploreResponse> {
  return request(`/sessions/${sessionId}/explore`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function startFollowup(sessionId: string, params: FollowupRequest): Promise<ExploreResponse> {
  return request(`/sessions/${sessionId}/followup`, {
    method: "POST",
    body: JSON.stringify(params),
  });
}

export async function cancelExploration(sessionId: string): Promise<{ status: string }> {
  return request(`/sessions/${sessionId}/cancel`, { method: "POST" });
}

// ─── 设置 ───

export interface SettingsResponse {
  llm: {
    provider: string | null;
    base_url: string | null;
    model: string | null;
    max_tokens: number | null;
    api_key_configured: boolean;
  };
  mcp: {
    knowledge_graph_url: string | null;
    transport: "streamable-http" | "sse";
    api_key_configured: boolean;
  };
  web: {
    demo_session_id: string | null;
    admin_token_configured: boolean;
  };
}

export interface SettingsUpdate {
  llm?: {
    api_key?: string;
  };
  mcp?: {
    api_key?: string;
  };
  web?: {
    demo_session_id?: string | null;
    admin_token?: string;
    invite_codes?: string[];
    user_signup_quota?: number;
    user_registration_enabled?: boolean;
  };
}

export interface ValidateResult {
  ok: boolean;
  error?: string;
  server?: unknown;
}

export async function getSettings(): Promise<SettingsResponse> {
  return request("/settings");
}

export async function updateSettings(patch: SettingsUpdate): Promise<{ ok: boolean }> {
  return request("/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function validateKGEndpoint(): Promise<ValidateResult> {
  return request("/settings/validate", { method: "POST" });
}

// ─── 聊天 ───

export async function sendMessage(
  sessionId: string,
  message: string,
): Promise<{ status: string }> {
  return request(`/sessions/${sessionId}/chat`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

// ─── 聊天 SSE ───

export async function getSessionStatus(sessionId: string): Promise<{ running: boolean }> {
  return request(`/sessions/${sessionId}/status`);
}

export interface ChatSSEHandlers {
  onTextDelta: (text: string) => void;
  onToolStart: (event: unknown) => void;
  onToolResult: (event: unknown) => void;
  onStep: (event: unknown) => void;
  onFinalize: (event: unknown) => void;
  /** 探索/聊天 turn 完成。payload.messages 为后端权威最终消息（可能缺失）。 */
  onMessageComplete: (payload?: { messages?: ChatMessage[] }) => void;
  onError: (error: string) => void;
  onConnectionLost?: () => void;
}

export function createChatSSEConnection(
  sessionId: string,
  handlers: ChatSSEHandlers,
): EventSource {
  // Cookie 自动携带认证信息，无需在 URL 中传递 token
  const url = `/api/sessions/${sessionId}/stream`;
  const es = new EventSource(url);

  es.addEventListener("text_delta", (e) => {
    const data = JSON.parse(e.data);
    handlers.onTextDelta(data.text ?? "");
  });

  es.addEventListener("tool_start", (e) => {
    handlers.onToolStart(JSON.parse(e.data));
  });

  es.addEventListener("tool_result", (e) => {
    handlers.onToolResult(JSON.parse(e.data));
  });

  es.addEventListener("step", (e) => {
    handlers.onStep(JSON.parse(e.data));
  });

  es.addEventListener("finalize", (e) => {
    handlers.onFinalize(JSON.parse(e.data));
  });

  es.addEventListener("message_complete", (e) => {
    let payload: { messages?: ChatMessage[] } | undefined;
    try {
      payload = e.data ? JSON.parse(e.data) : undefined;
    } catch {
      payload = undefined;
    }
    handlers.onMessageComplete(payload);
  });

  es.addEventListener("error", (e) => {
    if (es.readyState === EventSource.CLOSED) {
      handlers.onConnectionLost?.();
      return;
    }
    try {
      const data = e instanceof MessageEvent ? JSON.parse(e.data) : null;
      if (data?.error) handlers.onError(data.error);
    } catch {
      // 连接层面错误 — EventSource 可能正在重连
    }
  });

  return es;
}

// ─── 分享令牌管理（admin）───

export interface ShareTokenInfo {
  token: string;
  label: string;
  usage_limit: number;
  usage_count: number;
  session_ids: string[];
  created_at: string;
  last_used_at: string | null;
  disabled: boolean;
}

export async function listShareTokens(): Promise<ShareTokenInfo[]> {
  return request("/share-tokens");
}

export async function createShareToken(label: string, usageLimit: number): Promise<ShareTokenInfo> {
  return request("/share-tokens", {
    method: "POST",
    body: JSON.stringify({ label, usage_limit: usageLimit }),
  });
}

export async function setShareTokenDisabled(token: string, disabled: boolean): Promise<ShareTokenInfo> {
  return request(`/share-tokens/${token}`, {
    method: "PATCH",
    body: JSON.stringify({ disabled }),
  });
}

export async function deleteShareToken(token: string): Promise<{ deleted: boolean; sessions_cleaned: number }> {
  return request(`/share-tokens/${token}`, { method: "DELETE" });
}

/** 获取令牌关联的全部访客会话数据（admin 查看） */
export async function getShareTokenSessions(token: string): Promise<Session[]> {
  try {
    return await request<Session[]>(`/share-tokens/${token}/sessions`);
  } catch {
    return [];
  }
}

/** 清除令牌关联的全部访客会话数据（admin 操作） */
export async function deleteShareTokenSessions(token: string): Promise<{ ok: boolean; count: number }> {
  return request(`/share-tokens/${token}/sessions`, { method: "DELETE" });
}

/** 生成给访客的分享链接 */
export function buildShareLink(token: string): string {
  const origin = window.location.origin;
  return `${origin}/s/${token}`;
}

// ─── 公共 API（无需 admin token）───

/** 公共请求 — 不注入 admin token 头 */
async function publicRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}/public${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export interface PublicTokenInfo {
  label: string;
  remaining: number;
  limit: number;
  used: number;
}

/** 获取展示会话（只读，不计次） */
export async function getPublicDemo(): Promise<Session | null> {
  try {
    return await publicRequest<Session>("/demo");
  } catch {
    return null;
  }
}

/** 获取令牌信息（只读，不计次） */
export async function getPublicTokenInfo(token: string): Promise<PublicTokenInfo | null> {
  try {
    return await publicRequest<PublicTokenInfo>(`/token/${token}`);
  } catch {
    return null;
  }
}

/** 访客发消息（计次，需指定 session_id） */
export async function sendPublicChat(token: string, message: string, sessionId: string): Promise<void> {
  await publicRequest(`/token/${token}/chat`, {
    method: "POST",
    body: JSON.stringify({ message, session_id: sessionId }),
  });
}

/** 访客 SSE 连接（需指定 session_id） */
export function createPublicSSEConnection(
  token: string,
  sessionId: string,
  handlers: ChatSSEHandlers,
): EventSource {
  const es = new EventSource(`/api/public/token/${token}/stream?session=${encodeURIComponent(sessionId)}`);

  es.addEventListener("text_delta", (e) => {
    const data = JSON.parse(e.data);
    handlers.onTextDelta(data.text ?? "");
  });

  es.addEventListener("tool_start", (e) => {
    handlers.onToolStart(JSON.parse(e.data));
  });

  es.addEventListener("tool_result", (e) => {
    handlers.onToolResult(JSON.parse(e.data));
  });

  es.addEventListener("step", (e) => {
    handlers.onStep(JSON.parse(e.data));
  });

  es.addEventListener("finalize", (e) => {
    handlers.onFinalize(JSON.parse(e.data));
  });

  es.addEventListener("message_complete", (e) => {
    let payload: { messages?: ChatMessage[] } | undefined;
    try {
      payload = e.data ? JSON.parse(e.data) : undefined;
    } catch {
      payload = undefined;
    }
    handlers.onMessageComplete(payload);
  });

  es.addEventListener("error", (e) => {
    if (es.readyState === EventSource.CLOSED) {
      handlers.onConnectionLost?.();
      return;
    }
    try {
      const data = e instanceof MessageEvent ? JSON.parse(e.data) : null;
      if (data?.error) handlers.onError(data.error);
    } catch {
      // 连接层面错误
    }
  });

  return es;
}

// ─── 访客多会话管理 ───

export interface TokenSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/** 访客获取自己的所有会话列表 */
export async function listPublicSessions(token: string): Promise<TokenSessionSummary[]> {
  try {
    return await publicRequest<TokenSessionSummary[]>(`/token/${token}/sessions`);
  } catch {
    return [];
  }
}

/** 访客创建新会话 */
export async function createPublicSession(token: string, title?: string): Promise<{ id: string; title: string; created_at: string }> {
  return publicRequest(`/token/${token}/sessions`, {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

/** 访客获取指定会话的消息 */
export async function getPublicSessionMessages(token: string, sessionId: string): Promise<{ messages: ChatMessage[]; processing: boolean }> {
  try {
    return await publicRequest<{ messages: ChatMessage[]; processing: boolean }>(`/token/${token}/sessions/${sessionId}`);
  } catch {
    return { messages: [], processing: false };
  }
}

/** 访客查询会话是否仍在处理（轻量，用于断线重连判断后端真实状态） */
export async function getPublicSessionStatus(token: string, sessionId: string): Promise<{ running: boolean }> {
  try {
    return await publicRequest<{ running: boolean }>(`/token/${token}/sessions/${sessionId}/status`);
  } catch {
    return { running: false };
  }
}

/** 访客删除指定会话 */
export async function deletePublicSession(token: string, sessionId: string): Promise<{ ok: boolean }> {
  return publicRequest(`/token/${token}/sessions/${sessionId}`, { method: "DELETE" });
}

// ─── 账号体系 API（用户注册/登录/会话）───

/** 账号请求 — 同源自动携带 fin-trace-user cookie */
async function accountRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/account${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface AccountUser {
  id: string;
  email: string;
  display_name: string;
  usage_limit: number;
  usage_count: number;
  remaining: number;
  created_at: string;
}

export interface AccountConfig {
  registration_enabled: boolean;
  invite_code_required: boolean;
}

export interface UserSessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/** 注册页前置信息 */
export async function getAccountConfig(): Promise<AccountConfig> {
  return accountRequest<AccountConfig>("/config");
}

/** 注册 */
export async function register(email: string, password: string, inviteCode?: string, displayName?: string): Promise<{ user: AccountUser }> {
  return accountRequest<{ user: AccountUser }>("/register", {
    method: "POST",
    body: JSON.stringify({ email, password, invite_code: inviteCode, display_name: displayName }),
  });
}

/** 登录 */
export async function accountLogin(email: string, password: string): Promise<{ user: AccountUser }> {
  return accountRequest<{ user: AccountUser }>("/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

/** 登出 */
export async function accountLogout(): Promise<void> {
  await accountRequest("/logout", { method: "POST" }).catch(() => {});
}

/** 查询当前登录用户（未登录返回 null，不抛异常） */
export async function getMe(): Promise<{ user: AccountUser; sessions: UserSessionSummary[] } | null> {
  try {
    return await accountRequest<{ user: AccountUser; sessions: UserSessionSummary[] }>("/me");
  } catch {
    return null;
  }
}

/** 列出用户会话 */
export async function listUserSessions(): Promise<UserSessionSummary[]> {
  return accountRequest<UserSessionSummary[]>("/sessions");
}

/** 创建用户会话 */
export async function createUserSession(title?: string): Promise<{ id: string; title: string; created_at: string }> {
  return accountRequest("/sessions", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

/** 获取会话消息 + 处理状态 */
export async function getUserSessionMessages(sessionId: string): Promise<{ messages: ChatMessage[]; processing: boolean }> {
  return accountRequest(`/sessions/${sessionId}/messages`);
}

/** 删除用户会话 */
export async function deleteUserSessionApi(sessionId: string): Promise<{ ok: boolean }> {
  return accountRequest(`/sessions/${sessionId}`, { method: "DELETE" });
}

/** 查询会话是否仍在处理（断线恢复用） */
export async function getUserSessionStatus(sessionId: string): Promise<{ running: boolean }> {
  try {
    return await accountRequest<{ running: boolean }>(`/sessions/${sessionId}/status`);
  } catch {
    return { running: false };
  }
}

/** 用户发送消息 */
export async function sendUserChat(sessionId: string, message: string): Promise<{ status: string }> {
  return accountRequest(`/sessions/${sessionId}/chat`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** 用户 SSE 连接（复用现有 SSE 事件协议） */
export function createUserSSEConnection(sessionId: string, handlers: ChatSSEHandlers): EventSource {
  const es = new EventSource(`/api/account/sessions/${sessionId}/stream`);

  es.addEventListener("text_delta", (e) => {
    const data = JSON.parse(e.data);
    handlers.onTextDelta(data.text ?? "");
  });
  es.addEventListener("tool_start", (e) => handlers.onToolStart(JSON.parse(e.data)));
  es.addEventListener("tool_result", (e) => handlers.onToolResult(JSON.parse(e.data)));
  es.addEventListener("step", (e) => handlers.onStep(JSON.parse(e.data)));
  es.addEventListener("finalize", (e) => handlers.onFinalize(JSON.parse(e.data)));
  es.addEventListener("message_complete", (e) => {
    let payload: { messages?: ChatMessage[] } | undefined;
    try {
      payload = e.data ? JSON.parse(e.data) : undefined;
    } catch {
      payload = undefined;
    }
    handlers.onMessageComplete(payload);
  });
  es.addEventListener("error", (e) => {
    if (es.readyState === EventSource.CLOSED) {
      handlers.onConnectionLost?.();
      return;
    }
    try {
      const data = e instanceof MessageEvent ? JSON.parse(e.data) : null;
      if (data?.error) handlers.onError(data.error);
    } catch {
      // 连接层面错误 — EventSource 可能正在重连
    }
  });
  return es;
}

// 重新导出常用类型供组件使用
export type { Session, SessionSummary, ChatMessage };
