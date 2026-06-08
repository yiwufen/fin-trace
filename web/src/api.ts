// API client — 封装后端 HTTP 调用

import type { Session, SessionSummary, ExploreRequest, FollowupRequest } from "./types";

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
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
    api_key_configured: boolean;
  };
  mcp: {
    knowledge_graph_url: string | null;
    transport: "streamable-http" | "sse";
    api_key_configured: boolean;
  };
}

export interface SettingsUpdate {
  llm?: {
    api_key?: string;
    provider?: "anthropic" | "openai";
    base_url?: string;
    model?: string;
  };
  mcp?: {
    knowledge_graph_url?: string;
    transport?: "streamable-http" | "sse";
    api_key?: string;
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

export interface ChatSSEHandlers {
  onTextDelta: (text: string) => void;
  onToolStart: (event: unknown) => void;
  onToolResult: (event: unknown) => void;
  onStep: (event: unknown) => void;
  onFinalize: (event: unknown) => void;
  onMessageComplete: () => void;
  onError: (error: string) => void;
}

export function createChatSSEConnection(
  sessionId: string,
  handlers: ChatSSEHandlers,
): EventSource {
  const es = new EventSource(`/api/sessions/${sessionId}/stream`);

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
    if (es.readyState === EventSource.CLOSED) return;
    try {
      const data = e instanceof MessageEvent ? JSON.parse(e.data) : null;
      if (data?.error) handlers.onError(data.error);
    } catch {
      // 连接层面错误
    }
  });

  return es;
}
