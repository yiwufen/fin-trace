// API client — 封装后端 HTTP 调用

import type { Session, SessionSummary, ExploreRequest, FollowupRequest, ChatMessage } from "./types";

const BASE = "/api";

// ─── admin token 管理 ───
// 配置了 admin_token 的部署，所有 /api/sessions*、/api/settings*、/api/share-tokens* 需注入头
const ADMIN_TOKEN_KEY = "fin-trace-admin-token";

export function getAdminToken(): string | null {
  return localStorage.getItem(ADMIN_TOKEN_KEY);
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

/** 是否已配置 admin token（后端），用于判断是否需要门禁 */
export async function checkAdminRequired(): Promise<boolean> {
  const res = await fetch(`${BASE}/sessions`, { headers: adminHeaders() });
  if (res.status === 401) return true;
  return false;
}

function adminHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const t = getAdminToken();
  if (t) headers["X-Admin-Token"] = t;
  return headers;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: adminHeaders(),
    ...options,
  });
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
  onMessageComplete: () => void;
  onError: (error: string) => void;
  onConnectionLost?: () => void;
}

export function createChatSSEConnection(
  sessionId: string,
  handlers: ChatSSEHandlers,
): EventSource {
  // EventSource 不支持自定义请求头，通过 query parameter 传递 admin token
  const token = getAdminToken();
  const url = token
    ? `/api/sessions/${sessionId}/stream?admin_token=${encodeURIComponent(token)}`
    : `/api/sessions/${sessionId}/stream`;
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

  es.addEventListener("message_complete", () => {
    handlers.onMessageComplete();
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
  hr_session_id: string | null;
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

export async function deleteShareToken(token: string): Promise<void> {
  return request(`/share-tokens/${token}`, { method: "DELETE" });
}

/** 生成给 HR 的分享链接 */
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

/** HR 发消息（计次） */
export async function sendPublicChat(token: string, message: string): Promise<void> {
  await publicRequest(`/token/${token}/chat`, {
    method: "POST",
    body: JSON.stringify({ message }),
  });
}

/** HR SSE 连接 */
export function createPublicSSEConnection(
  token: string,
  handlers: ChatSSEHandlers,
): EventSource {
  const es = new EventSource(`/api/public/token/${token}/stream`);

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

  es.addEventListener("message_complete", () => {
    handlers.onMessageComplete();
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

// 重新导出常用类型供组件使用
export type { Session, SessionSummary, ChatMessage };
