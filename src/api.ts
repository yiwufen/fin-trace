// HTTP API 层 + SSE 推送 — 对应 design-docs/frontend-design.md 第五节
//
// 路由:
//   GET  /api/sessions                  — 会话列表
//   POST /api/sessions                  — 创建会话
//   GET  /api/sessions/:id              — 会话详情
//   PATCH /api/sessions/:id             — 更新会话（重命名）
//   DELETE /api/sessions/:id            — 删除会话
//   POST /api/sessions/:id/explore      — 启动探索
//   GET  /api/sessions/:id/stream       — SSE 步骤推送
//   POST /api/sessions/:id/followup     — 追问
//   GET  /api/settings/status            — API Key 配置状态
//   PUT  /api/settings                   — 更新 API Key

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { serializeState, deserializeState } from "./agent/state.js";
import type { StepEvent, ExplorationState } from "./agent/state.js";
import { runExploration, initState } from "./agent/loop.js";
import {
  createSession,
  getSession,
  listSessions,
  updateSession,
  deleteSession,
  createExploration,
  appendStep,
  completeExploration,
  failExploration,
  appendChatMessages,
} from "./session-store.js";
import { handleUserMessage } from "./chat/loop.js";
import type { ChatMessage } from "./chat/types.js";
import { readSettings, writeSettings } from "./settings-store.js";
import type { SettingsStore } from "./settings-store.js";
import { clearConfigCache } from "./agent/config.js";

// ─── SSE 连接管理 ───

const sseConnections = new Map<string, Set<ServerResponse>>();

function addSSEConnection(sessionId: string, res: ServerResponse): void {
  let set = sseConnections.get(sessionId);
  if (!set) {
    set = new Set();
    sseConnections.set(sessionId, set);
  }
  set.add(res);
}

function removeSSEConnection(sessionId: string, res: ServerResponse): void {
  const set = sseConnections.get(sessionId);
  if (set) {
    set.delete(res);
    if (set.size === 0) sseConnections.delete(sessionId);
  }
}

function broadcastSSE(sessionId: string, eventType: string, data: unknown): void {
  // 写入缓冲（新 SSE 连接可重放）
  let buffer = stepBuffers.get(sessionId);
  if (!buffer) {
    buffer = [];
    stepBuffers.set(sessionId, buffer);
  }
  buffer.push({ eventType, data });
  // 只缓冲 step/finalize 事件，complete/error/cancelled 不需要
  if (buffer.length > 50) buffer.splice(0, buffer.length - 50);

  // 推送给已连接的客户端
  const set = sseConnections.get(sessionId);
  if (!set) return;
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try {
      res.write(payload);
    } catch {
      set.delete(res);
    }
  }
}

// ─── 运行中的探索（防重复启动） ───

const runningExplorations = new Map<string, { explorationId: string; abortController: AbortController }>();

// ─── SSE 步骤缓冲 — 新连接建立时重放未消费的事件 ───

const stepBuffers = new Map<string, { eventType: string; data: unknown }[]>();

// ─── 追问用的 State 暂存 ───

// 追问时需要从文件恢复 ExplorationState，存在内存中避免频繁读文件
const stateCache = new Map<string, ExplorationState>();

// ─── JSON 解析辅助 ───

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ─── CORS ───

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function corsPreflight(res: ServerResponse): void {
  res.writeHead(204, CORS_HEADERS);
  res.end();
}

function corsHeaders(res: ServerResponse): void {
  res.writeHead(res.statusCode ?? 200, { ...CORS_HEADERS, "Content-Type": "application/json" });
}

// ─── 路由匹配 ───

// URL pattern: /api/sessions/:id/:action
interface RouteMatch {
  sessionId: string | null;
  action: string | null;
}

function matchRoute(url: string): RouteMatch {
  const path = url.split("?")[0];
  const parts = path.replace(/^\/api\/sessions\/?/, "").split("/").filter(Boolean);

  if (parts.length === 0) return { sessionId: null, action: null };
  if (parts.length === 1) return { sessionId: parts[0], action: null };
  return { sessionId: parts[0], action: parts[1] };
}

// ─── 请求分发 ───

export async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "/";
  if (!url.startsWith("/api/")) return false;

  // CORS preflight
  if (req.method === "OPTIONS") {
    corsPreflight(res);
    return true;
  }

  // 只处理 /api/sessions 或 /api/settings 路径

  // /api/settings — API Key 配置
  if (url.startsWith("/api/settings")) {
    await handleSettings(req, res);
    return true;
  }

  if (!url.startsWith("/api/sessions")) {
    sendJSON(res, 404, { error: "Not found" });
    return true;
  }

  const match = matchRoute(url);

  try {
    // /api/sessions — 列表 / 创建
    if (!match.sessionId) {
      if (req.method === "GET") {
        const sessions = await listSessions();
        res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify(sessions));
        return true;
      }
      if (req.method === "POST") {
        const body = await readBody(req);
        const { title } = JSON.parse(body || "{}");
        const session = await createSession(title);
        res.writeHead(201, { ...CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
        return true;
      }
      sendJSON(res, 405, { error: "Method not allowed" });
      return true;
    }

    // /api/sessions/:id — 需要校验 session 存在
    const session = await getSession(match.sessionId);
    if (!session) {
      sendJSON(res, 404, { error: "Session not found" });
      return true;
    }

    // /api/sessions/:id (no action) — 详情 / 更新 / 删除
    if (!match.action) {
      if (req.method === "GET") {
        res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify(session));
        return true;
      }
      if (req.method === "PATCH") {
        const body = await readBody(req);
        const patch = JSON.parse(body || "{}");
        const updated = await updateSession(match.sessionId, patch);
        res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
        res.end(JSON.stringify(updated));
        return true;
      }
      if (req.method === "DELETE") {
        await deleteSession(match.sessionId);
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return true;
      }
      sendJSON(res, 405, { error: "Method not allowed" });
      return true;
    }

    // /api/sessions/:id/explore — 启动探索
    if (match.action === "explore" && req.method === "POST") {
      await handleExplore(match.sessionId, req, res);
      return true;
    }

    // /api/sessions/:id/stream — SSE
    if (match.action === "stream" && req.method === "GET") {
      handleSSE(match.sessionId, req, res);
      return true;
    }

    // /api/sessions/:id/followup — 追问
    if (match.action === "followup" && req.method === "POST") {
      await handleFollowup(match.sessionId, req, res);
      return true;
    }

    // /api/sessions/:id/cancel — 取消探索
    if (match.action === "cancel" && req.method === "POST") {
      handleCancel(match.sessionId, res);
      return true;
    }

    // /api/sessions/:id/chat — 聊天
    if (match.action === "chat" && req.method === "POST") {
      await handleChat(match.sessionId, req, res);
      return true;
    }

    sendJSON(res, 404, { error: "Not found" });
    return true;
  } catch (err) {
    console.error("[api] error:", err);
    sendJSON(res, 500, { error: "Internal server error" });
    return true;
  }
}

// ─── 启动探索 ───

async function handleExplore(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 防止重复启动
  if (runningExplorations.has(sessionId)) {
    sendJSON(res, 409, { error: "Exploration already running" });
    return;
  }

  const body = await readBody(req);
  const { goal, seed_entities, max_depth, time_range } = JSON.parse(body);

  if (!goal || !Array.isArray(seed_entities) || seed_entities.length === 0) {
    sendJSON(res, 400, { error: "goal and seed_entities are required" });
    return;
  }

  const depth = typeof max_depth === "number" ? max_depth : 3;
  const exploration = createExploration(goal, seed_entities, depth);

  // 保存到 session
  const session = await getSession(sessionId);
  if (!session) {
    sendJSON(res, 404, { error: "Session not found" });
    return;
  }
  session.explorations.push(exploration);
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await writeFile(
    join(process.cwd(), "data", "sessions", `${sessionId}.json`),
    JSON.stringify(session, null, 2),
    "utf-8",
  );

  runningExplorations.set(sessionId, { explorationId: exploration.id, abortController: new AbortController() });

  // 异步启动探索
  const onStep = buildOnStepCallback(sessionId, exploration.id);
  runExploration(
    { goal, seed_entities, max_depth: depth, time_range: typeof time_range === "string" ? time_range : undefined },
    onStep,
  )
    .then(async ({ output, state }) => {
      const serialized = serializeState(state);
      await completeExploration(sessionId, exploration.id, output, serialized);
      broadcastSSE(sessionId, "complete", { exploration_id: exploration.id, output });
    })
    .catch(async (err) => {
      console.error("[api] exploration error:", err);
      await failExploration(sessionId, exploration.id, String(err?.message ?? err));
      broadcastSSE(sessionId, "error", { exploration_id: exploration.id, error: String(err?.message ?? err) });
    })
    .finally(() => {
      runningExplorations.delete(sessionId);
      // 延迟清理缓冲，确保 SSE 客户端收到 complete
      setTimeout(() => stepBuffers.delete(sessionId), 5000);
    });

  // 返回 202 Accepted
  res.writeHead(202, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify({ exploration_id: exploration.id, status: "running" }));
}

// ─── 追问 ───

async function handleFollowup(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (runningExplorations.has(sessionId)) {
    sendJSON(res, 409, { error: "Exploration already running" });
    return;
  }

  const body = await readBody(req);
  const { goal, extra_seeds, time_range } = JSON.parse(body);
  if (!goal) {
    sendJSON(res, 400, { error: "goal is required" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    sendJSON(res, 404, { error: "Session not found" });
    return;
  }

  // 从上一次探索恢复 State
  const lastExploration = session.explorations[session.explorations.length - 1];
  const baseSeeds = lastExploration?.seed_entities ?? [];
  const seeds = [...new Set([...baseSeeds, ...(extra_seeds ?? [])])];
  const depth = lastExploration?.max_depth ?? 3;

  // 恢复上一次探索的 State（如果有）
  let restoredState: ExplorationState | undefined;
  if (lastExploration?.serialized_state) {
    try {
      restoredState = deserializeState(lastExploration.serialized_state);
      // 追问时重置 phase 和控制标志，保留 visited/findings/archive
      restoredState.phase = "EXPLORING";
      restoredState.force_sufficient = false;
      restoredState.force_strategy = undefined;
      restoredState.injectHint = undefined;
      // 追加新 seed 到 frontier
      for (const seed of (extra_seeds ?? [])) {
        const resolved = restoredState.nameIndex.get(seed) ?? seed;
        if (!restoredState.visited.has(resolved)) {
          restoredState.frontier.push({
            name: seed,
            source: "followup",
            source_reason: "追问补充实体",
          });
        }
      }
    } catch (err) {
      console.error("[api] failed to restore state for followup:", err);
    }
  }

  const exploration = createExploration(goal, seeds, depth);
  session.explorations.push(exploration);
  const { writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await writeFile(
    join(process.cwd(), "data", "sessions", `${sessionId}.json`),
    JSON.stringify(session, null, 2),
    "utf-8",
  );

  runningExplorations.set(sessionId, { explorationId: exploration.id, abortController: new AbortController() });

  const onStep = buildOnStepCallback(sessionId, exploration.id);
  runExploration(
    { goal, seed_entities: seeds, max_depth: depth, time_range: typeof time_range === "string" ? time_range : undefined },
    onStep,
    restoredState,
  )
    .then(async ({ output, state }) => {
      const serialized = serializeState(state);
      await completeExploration(sessionId, exploration.id, output, serialized);
      broadcastSSE(sessionId, "complete", { exploration_id: exploration.id, output });
    })
    .catch(async (err) => {
      console.error("[api] followup error:", err);
      await failExploration(sessionId, exploration.id, String(err?.message ?? err));
      broadcastSSE(sessionId, "error", { exploration_id: exploration.id, error: String(err?.message ?? err) });
    })
    .finally(() => {
      runningExplorations.delete(sessionId);
      // 延迟清理缓冲，确保 SSE 客户端收到 complete
      setTimeout(() => stepBuffers.delete(sessionId), 5000);
    });

  res.writeHead(202, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify({ exploration_id: exploration.id, status: "running" }));
}

// ─── 取消探索 ───

function handleCancel(sessionId: string, res: ServerResponse): void {
  const entry = runningExplorations.get(sessionId);
  if (!entry) {
    sendJSON(res, 404, { error: "No running exploration" });
    return;
  }

  entry.abortController.abort();
  runningExplorations.delete(sessionId);
  broadcastSSE(sessionId, "cancelled", { exploration_id: entry.explorationId });
  sendJSON(res, 200, { status: "cancelled" });
}

// ─── 设置 ───

async function handleSettings(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // POST /api/settings/validate — 测试 KG 连通性
  if (path === "/api/settings/validate" && req.method === "POST") {
    await handleValidate(req, res);
    return;
  }

  // GET /api/settings — 返回完整配置（api_key 脱敏）
  if (path === "/api/settings" && req.method === "GET") {
    handleGetSettings(res);
    return;
  }

  // PUT /api/settings — 更新配置
  if (path === "/api/settings" && req.method === "PUT") {
    await handlePutSettings(req, res);
    return;
  }

  // DELETE /api/settings — 清除配置
  if (path === "/api/settings" && req.method === "DELETE") {
    const empty: SettingsStore = {};
    writeSettings(empty);
    clearConfigCache();
    sendJSON(res, 200, { ok: true });
    return;
  }

  sendJSON(res, 405, { error: "Method not allowed" });
}

function handleGetSettings(res: ServerResponse): void {
  const settings = readSettings();
  const apiKey = settings.llm?.api_key;
  sendJSON(res, 200, {
    llm: {
      provider: settings.llm?.provider ?? null,
      base_url: settings.llm?.base_url ?? null,
      model: settings.llm?.model ?? null,
      api_key_configured: !!apiKey && apiKey.length > 0,
    },
    mcp: {
      knowledge_graph_url: settings.mcp?.knowledge_graph_url ?? null,
    },
  });
}

async function handlePutSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { llm, mcp } = JSON.parse(body || "{}");

  const current = readSettings();

  // LLM 配置
  if (llm && typeof llm === "object") {
    const merged: SettingsStore["llm"] = { ...current.llm };
    if (typeof llm.api_key === "string" && llm.api_key.trim().length > 0) {
      merged.api_key = llm.api_key.trim();
    }
    if (llm.provider === "anthropic" || llm.provider === "openai") {
      merged.provider = llm.provider;
    }
    if (typeof llm.base_url === "string" && llm.base_url.trim().length > 0) {
      merged.base_url = llm.base_url.trim();
    }
    if (typeof llm.model === "string" && llm.model.trim().length > 0) {
      merged.model = llm.model.trim();
    }
    current.llm = merged;
  }

  // MCP 配置
  if (mcp && typeof mcp === "object") {
    const merged: SettingsStore["mcp"] = { ...current.mcp };
    if (typeof mcp.knowledge_graph_url === "string" && mcp.knowledge_graph_url.trim().length > 0) {
      merged.knowledge_graph_url = mcp.knowledge_graph_url.trim();
    }
    current.mcp = merged;
  }

  writeSettings(current);
  clearConfigCache();
  sendJSON(res, 200, { ok: true });
}

/** 测试 KG MCP 服务连通性 — 发送 initialize 请求 */
async function handleValidate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const settings = readSettings();
  const kgUrl = settings.mcp?.knowledge_graph_url;

  if (!kgUrl) {
    sendJSON(res, 400, { error: "knowledge_graph_url 未配置" });
    return;
  }

  try {
    const response = await fetch(kgUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "validate",
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "graph-explorer", version: "1.0.0" } },
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      sendJSON(res, 200, { ok: false, error: `HTTP ${response.status}` });
      return;
    }

    const data = await response.json() as Record<string, unknown>;
    if (data.error) {
      sendJSON(res, 200, { ok: false, error: String((data.error as Record<string, string>).message ?? JSON.stringify(data.error)) });
      return;
    }

    sendJSON(res, 200, { ok: true, server: data.result });
  } catch (err) {
    sendJSON(res, 200, { ok: false, error: String((err as Error).message) });
  }
}

// ─── 聊天 ───

async function handleChat(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 防并发：同一 session 不能同时聊天和探索
  if (runningExplorations.has(sessionId)) {
    sendJSON(res, 409, { error: "Exploration already running" });
    return;
  }

  const body = await readBody(req);
  const { message, mode } = JSON.parse(body || "{}");

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    sendJSON(res, 400, { error: "message is required" });
    return;
  }

  const chatMode = mode === "agent" ? "agent" : "human";

  // 读 session 获取对话历史
  const session = await getSession(sessionId);
  if (!session) {
    sendJSON(res, 404, { error: "Session not found" });
    return;
  }

  const history: ChatMessage[] = session.messages ?? [];
  const chatSessionId = sessionId;

  // 首次聊天时自动更新会话标题
  if (history.length === 0 && session.title === "新会话") {
    const newTitle = message.trim().slice(0, 40);
    updateSession(sessionId, { title: newTitle }).catch((err) => {
      console.error("[api] failed to update session title:", err);
    });
  }

  runningExplorations.set(sessionId, {
    explorationId: `chat_${Date.now()}`,
    abortController: new AbortController(),
  });

  // 202 Accepted — 异步处理
  res.writeHead(202, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "accepted" }));

  // 异步执行
  const userMsg: ChatMessage = {
    role: "user",
    content: message.trim(),
    created_at: new Date().toISOString(),
  };

  handleUserMessage(history, message.trim(), (eventType: string, data: unknown) =>
    broadcastSSE(chatSessionId, eventType, data),
  chatMode)
    .then(async (newMessages) => {
      // 原子写入：userMsg + assistant 回复 一次性持久化，避免两次 append 的读写竞态
      await appendChatMessages(chatSessionId, [userMsg, ...newMessages]);
    })
    .catch(async (err) => {
      console.error("[api] chat error:", err);
      // 即使出错也至少持久化用户消息
      appendChatMessages(chatSessionId, [userMsg]).catch(() => {});
      broadcastSSE(sessionId, "error", {
        error: String((err as Error)?.message ?? err),
      });
    })
    .finally(() => {
      runningExplorations.delete(sessionId);
      // 延迟清理缓冲
      setTimeout(() => stepBuffers.delete(sessionId), 5000);
    });
}

// ─── SSE 端点 ───

function handleSSE(
  sessionId: string,
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...CORS_HEADERS,
  });

  // 发送初始连接确认
  res.write(`event: connected\ndata: ${JSON.stringify({ session_id: sessionId })}\n\n`);

  addSSEConnection(sessionId, res);

  // 重放缓冲的步骤事件（解决 SSE 连接竞态）
  const buffer = stepBuffers.get(sessionId);
  if (buffer) {
    for (const item of buffer) {
      res.write(`event: ${item.eventType}\ndata: ${JSON.stringify(item.data)}\n\n`);
    }
  }

  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      removeSSEConnection(sessionId, res);
    }
  }, 15000);

  res.on("close", () => {
    clearInterval(heartbeat);
    removeSSEConnection(sessionId, res);
  });
}

// ─── onStep 回调工厂 ───

function buildOnStepCallback(
  sessionId: string,
  explorationId: string,
): (event: StepEvent) => void {
  return (event: StepEvent) => {
    // 异步写入文件（不阻塞 loop）
    appendStep(sessionId, explorationId, event).catch((err) => {
      console.error("[api] appendStep error:", err);
    });

    // 实时推送给 SSE 客户端
    if (event.type === "finalize") {
      broadcastSSE(sessionId, "finalize", event);
    } else if (event.type === "error") {
      broadcastSSE(sessionId, "error", { exploration_id: explorationId, error: event.error });
    } else {
      broadcastSSE(sessionId, "step", event);
    }
  };
}
