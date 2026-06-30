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
//   管理端（需 X-Admin-Token，当配置了 admin_token 时）:
//   GET    /api/share-tokens            — 分享令牌列表
//   POST   /api/share-tokens            — 创建令牌
//   PATCH  /api/share-tokens/:token     — 禁用/启用令牌
//   DELETE /api/share-tokens/:token     — 删除令牌
//   公共（无需 admin token）:
//   GET  /api/public/demo               — 展示会话（只读，不计次）
//   GET  /api/public/token/:token       — 令牌信息（只读，不计次）
//   POST /api/public/token/:token/chat  — 访客发消息（计次）
//   GET  /api/public/token/:token/stream — 访客 SSE

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
  updateSessionTitleAndAppend,
} from "./session-store.js";
import {
  listTokens,
  createToken,
  disableToken,
  deleteToken,
  getToken,
  incrementUsage,
  createTokenSession,
  listTokenSessions,
  getTokenSession,
  deleteTokenSession,
  getAllTokenSessions,
  clearTokenSessions,
} from "./share-store.js";
import { listUsers, disableUser, setUserQuota, deleteUser, setUserPassword } from "./user-store.js";
import { hashPassword } from "./auth/password.js";
import { handleAccount } from "./account-handler.js";
import { handleUserMessage } from "./chat/loop.js";
import type { ChatMessage } from "./chat/types.js";
import { readSettings, writeSettings } from "./settings-store.js";
import type { SettingsStore } from "./settings-store.js";
import { clearConfigCache, readConfig } from "./agent/config.js";
import { createLogger } from "./logger.js";

const log = createLogger("api");

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
  // 缓冲所有事件用于断线重连重放。
  // 结构事件（step/finalize/complete/message_complete/tool_start/tool_result/error）永久保留（数量少）。
  // text_delta 量大，按累计字节上限控制：超过 TEXT_BYTE_BUDGET 时丢弃最早的 text_delta。
  let buffer = stepBuffers.get(sessionId);
  if (!buffer) {
    buffer = [];
    stepBuffers.set(sessionId, buffer);
  }
  const payloadStr = JSON.stringify(data);
  const bytes = payloadStr.length;
  buffer.push({ eventType, data, bytes });

  // 仅对 text_delta 做字节预算控制
  if (eventType === "text_delta") {
    let textBytes = 0;
    for (const e of buffer) if (e.eventType === "text_delta") textBytes += e.bytes;
    // 超预算时从头删除 text_delta（保留结构事件）
    while (textBytes > TEXT_BYTE_BUDGET) {
      const idx = buffer.findIndex((e) => e.eventType === "text_delta");
      if (idx === -1) break;
      textBytes -= buffer[idx].bytes;
      buffer.splice(idx, 1);
    }
  }
  // 结构事件硬上限（防御性，正常不会触发）
  const structCount = buffer.filter((e) => e.eventType !== "text_delta").length;
  if (structCount > 200) {
    const firstStructIdx = buffer.findIndex((e) => e.eventType !== "text_delta");
    if (firstStructIdx !== -1) buffer.splice(firstStructIdx, 1);
  }

  // 推送给已连接的客户端
  const set = sseConnections.get(sessionId);
  if (!set) return;
  const payload = `event: ${eventType}\ndata: ${payloadStr}\n\n`;
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

/** 查询某会话是否有探索/聊天正在运行（供 account-handler status 端点用） */
export function isExplorationRunning(sessionId: string): boolean {
  return runningExplorations.has(sessionId);
}

// ─── SSE 事件缓冲 — 新连接建立时重放未消费的事件 ───
// 缓冲所有事件类型（含 text_delta），以便断线重连后完整恢复流式输出。
// text_delta 量大，按累计字节上限控制：超过 TEXT_BYTE_BUDGET 时丢弃最早的 text_delta。

interface BufferEntry {
  eventType: string;
  data: unknown;
  bytes: number;   // 该条目的近似字节开销
}

const stepBuffers = new Map<string, BufferEntry[]>();
const TEXT_BYTE_BUDGET = 65536; // 单 session 的 text_delta 字节上限（64KB ≈ 2 万汉字）

// ─── 追问用的 State 暂存 ───

// 追问时需要从文件恢复 ExplorationState，存在内存中避免频繁读文件
const stateCache = new Map<string, ExplorationState>();

// ─── 辅助函数 ───

/** 从 Cookie 头中提取指定名称的值 */
function parseCookie(cookieHeader: string, name: string): string | undefined {
  for (const part of cookieHeader.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx === -1) continue;
    const k = part.slice(0, eqIdx).trim();
    const v = part.slice(eqIdx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}

/** 从请求中提取 admin token（优先级：Cookie > X-Admin-Token header） */
function extractAdminToken(req: IncomingMessage): string | undefined {
  // 1. httpOnly Cookie（浏览器自动携带，XSS 无法读取）
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const fromCookie = parseCookie(cookieHeader, "fin-trace-admin-token");
    if (fromCookie) return fromCookie;
  }
  // 2. X-Admin-Token header（兼容 API 客户端直接调用）
  const fromHeader = req.headers["x-admin-token"];
  if (typeof fromHeader === "string" && fromHeader.length > 0) return fromHeader;
  return undefined;
}

/** 设置认证 Cookie（httpOnly + SameSite=Strict，生产环境加 Secure） */
function setAuthCookie(res: ServerResponse, token: string): void {
  const isSecure = process.env.NODE_ENV === "production";
  const parts = [
    `fin-trace-admin-token=${encodeURIComponent(token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
  ];
  if (isSecure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** 清除认证 Cookie */
function clearAuthCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", "fin-trace-admin-token=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
}

// ─── JSON 解析辅助 ───

export async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

// ─── CORS ───

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
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

  // ─── 公共命名空间（无需 admin token）───
  // 访客通过分享链接访问，仅暴露 demo 查看与限次聊天
  if (url.startsWith("/api/public/")) {
    await handlePublic(req, res);
    return true;
  }

  // ─── 认证端点（无需 admin token）───
  if (url.startsWith("/api/auth/")) {
    await handleAuth(req, res);
    return true;
  }

  // ─── 账号体系（用户注册/登录/会话，独立于 admin 鉴权）───
  if (url.startsWith("/api/account/")) {
    await handleAccount(req, res);
    return true;
  }

  // ─── admin 门禁：配置了 admin_token 后，管理端需认证 ───
  // 影响 /api/sessions*、/api/settings*、/api/share-tokens*
  // 认证来源优先级：httpOnly Cookie > X-Admin-Token header
  const adminToken = readSettings().web?.admin_token;
  if (adminToken) {
    const provided = extractAdminToken(req);
    if (provided !== adminToken) {
      sendJSON(res, 401, { error: "Unauthorized: invalid or missing admin token" });
      return true;
    }
  }

  // ─── /api/share-tokens — 分享令牌管理（admin）───
  if (url.startsWith("/api/share-tokens")) {
    await handleShareTokens(req, res);
    return true;
  }

  // ─── /api/admin/users — 用户管理（admin）───
  if (url.startsWith("/api/admin/users")) {
    await handleAdminUsers(req, res);
    return true;
  }

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
        const allSessions = await listSessions();
        // 排除所有分享链接的访客会话，避免污染管理端列表
        const tokenSessionIds = new Set(listTokens().flatMap((t) => t.session_ids));
        const sessions = allSessions.filter((s) => !tokenSessionIds.has(s.id));
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
        // 删除前先取消正在运行的任务
        const entry = runningExplorations.get(match.sessionId);
        if (entry) {
          entry.abortController.abort();
          runningExplorations.delete(match.sessionId!);
        }
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

    // /api/sessions/:id/status — 查询是否正在处理
    if (match.action === "status" && req.method === "GET") {
      const isRunning = runningExplorations.has(match.sessionId);
      sendJSON(res, 200, { running: isRunning });
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
    log.error({ err }, "API 请求处理失败");
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
    { goal, seed_entities, session_id: sessionId, max_depth: depth, time_range: typeof time_range === "string" ? time_range : undefined },
    onStep,
  )
    .then(async ({ output, state }) => {
      const serialized = serializeState(state);
      await completeExploration(sessionId, exploration.id, output, serialized);
      broadcastSSE(sessionId, "complete", { exploration_id: exploration.id, output });
    })
    .catch(async (err) => {
      log.error({ err, sessionId }, "探索失败");
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
      log.error({ err, sessionId }, "追问时恢复 state 失败");
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
      log.error({ err, sessionId }, "追问失败");
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

// ─── 认证端点 ───

async function handleAuth(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // GET /api/auth/status — 返回认证状态（无需鉴权）
  if (path === "/api/auth/status" && req.method === "GET") {
    const configuredToken = readSettings().web?.admin_token;
    if (!configuredToken) {
      // 未配置 admin_token：本地开发模式，始终放行
      sendJSON(res, 200, { required: false, authenticated: true });
      return;
    }
    const provided = extractAdminToken(req);
    sendJSON(res, 200, {
      required: true,
      authenticated: provided === configuredToken,
    });
    return;
  }

  // POST /api/auth/login — 验证令牌并设置 Cookie
  if (path === "/api/auth/login" && req.method === "POST") {
    const configuredToken = readSettings().web?.admin_token;
    if (!configuredToken) {
      sendJSON(res, 200, { ok: true, required: false });
      return;
    }
    const body = await readBody(req);
    const { token } = JSON.parse(body || "{}");
    if (!token || typeof token !== "string" || token.trim() !== configuredToken) {
      sendJSON(res, 401, { error: "令牌无效" });
      return;
    }
    setAuthCookie(res, configuredToken);
    sendJSON(res, 200, { ok: true });
    return;
  }

  // POST /api/auth/logout — 清除 Cookie
  if (path === "/api/auth/logout" && req.method === "POST") {
    clearAuthCookie(res);
    sendJSON(res, 200, { ok: true });
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
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
  const config = readConfig();
  const settings = readSettings();
  const llmApiKey = settings.llm?.api_key;
  const mcpApiKey = settings.mcp?.api_key ?? config.mcp.servers.knowledge_graph.api_key;
  sendJSON(res, 200, {
    llm: {
      provider: config.llm.provider,
      base_url: config.llm.base_url,
      model: config.llm.model,
      max_tokens: config.llm.max_tokens,
      api_key_configured: !!llmApiKey && llmApiKey.length > 0,
    },
    mcp: {
      knowledge_graph_url: config.mcp.servers.knowledge_graph.url,
      transport: config.mcp.servers.knowledge_graph.transport ?? "streamable-http",
      api_key_configured: !!mcpApiKey && mcpApiKey.length > 0,
    },
    a2a: {
      inbound_token_configured:
        !!(config.a2a?.inbound_token) && config.a2a.inbound_token.length > 0,
    },
    web: {
      demo_session_id: settings.web?.demo_session_id ?? null,
      admin_token_configured:
        !!(settings.web?.admin_token) && settings.web.admin_token.length > 0,
    },
  });
}

async function handlePutSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  const { llm, mcp, web } = JSON.parse(body || "{}");

  const current = readSettings();

  // LLM 凭据 — 仅 api_key 可通过前端设置（provider/base_url/model 在 config.json）
  if (llm && typeof llm === "object") {
    const merged: SettingsStore["llm"] = { ...current.llm };
    if (typeof llm.api_key === "string" && llm.api_key.trim().length > 0) {
      merged.api_key = llm.api_key.trim();
    }
    current.llm = merged;
  }

  // MCP 凭据 — 仅 api_key（url/transport 在 config.json）
  if (mcp && typeof mcp === "object") {
    const merged: SettingsStore["mcp"] = { ...current.mcp };
    if (typeof mcp.api_key === "string" && mcp.api_key.trim().length > 0) {
      merged.api_key = mcp.api_key.trim();
    }
    current.mcp = merged;
  }

  // Web 管理端配置
  if (web && typeof web === "object") {
    const merged: SettingsStore["web"] = { ...current.web };
    if (typeof web.admin_token === "string" && web.admin_token.trim().length > 0) {
      merged.admin_token = web.admin_token.trim();
    }
    // demo_session_id 允许设为 null（清除）或字符串
    if (web.demo_session_id === null) {
      merged.demo_session_id = undefined;
    } else if (typeof web.demo_session_id === "string" && web.demo_session_id.trim().length > 0) {
      merged.demo_session_id = web.demo_session_id.trim();
    }
    // 账号体系配置
    if (Array.isArray(web.invite_codes)) {
      merged.invite_codes = web.invite_codes.filter((c: unknown): c is string => typeof c === "string" && c.length > 0);
    }
    if (typeof web.user_signup_quota === "number") {
      merged.user_signup_quota = Math.max(0, Math.floor(web.user_signup_quota));
    }
    if (typeof web.user_registration_enabled === "boolean") {
      merged.user_registration_enabled = web.user_registration_enabled;
    }
    current.web = merged;
  }

  writeSettings(current);
  clearConfigCache();
  sendJSON(res, 200, { ok: true });
}

/**
 * 解析 MCP initialize 响应 — 同时支持 SSE 和 JSON 两种格式
 *
 * Streamable HTTP 服务端可能返回:
 *   - Content-Type: application/json → 标准 JSON-RPC 响应
 *   - Content-Type: text/event-stream → SSE 流（含 event: message + data: {...}）
 */
async function parseMCPInitResponse(response: Response): Promise<Record<string, unknown>> {
  const ct = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (ct.includes("text/event-stream")) {
    // SSE 格式: "event: message\ndata: {\"jsonrpc\":...}"
    // 从 data: 行提取 JSON 对象（handle balanced braces for nested objects）
    const dataIdx = body.indexOf("data: ");
    if (dataIdx === -1) {
      throw new Error(`无法解析 SSE 响应: ${body.slice(0, 200)}`);
    }
    const jsonStart = body.indexOf("{", dataIdx);
    if (jsonStart === -1) {
      throw new Error(`无法解析 SSE 响应: ${body.slice(0, 200)}`);
    }
    // balanced brace matching
    let depth = 0;
    let jsonEnd = -1;
    for (let i = jsonStart; i < body.length; i++) {
      if (body[i] === "{") depth++;
      else if (body[i] === "}") { depth--; if (depth === 0) { jsonEnd = i; break; } }
    }
    if (jsonEnd === -1) {
      throw new Error(`无法解析 SSE 响应: ${body.slice(0, 200)}`);
    }
    return JSON.parse(body.slice(jsonStart, jsonEnd + 1));
  }

  return JSON.parse(body);
}

/** 测试 KG MCP 服务连通性 — 支持 SSE 和 Streamable HTTP 两种协议 */
async function handleValidate(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  const config = readConfig();
  const kgUrl = config.mcp.servers.knowledge_graph.url;
  const transport = config.mcp.servers.knowledge_graph.transport ?? "streamable-http";
  const apiKey = config.mcp.servers.knowledge_graph.api_key;

  if (!kgUrl) {
    sendJSON(res, 400, { error: "knowledge_graph URL 未在 config.json 中配置" });
    return;
  }

  const initPayload = {
    jsonrpc: "2.0",
    id: "validate",
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fin-trace", version: "1.0.0" } },
  };

  const authHeaders: Record<string, string> = apiKey
    ? { Authorization: `Bearer ${apiKey}` }
    : {};

  try {
    if (transport === "sse") {
      // SSE 协议: GET SSE endpoint → 解析 endpoint 事件 → POST initialize 到 message endpoint
      const sseResponse = await fetch(kgUrl, {
        headers: { Accept: "text/event-stream", ...authHeaders },
        signal: AbortSignal.timeout(5000),
      });

      if (!sseResponse.ok) {
        sendJSON(res, 200, { ok: false, error: `SSE 连接失败 HTTP ${sseResponse.status}` });
        return;
      }

      const ct = sseResponse.headers.get("content-type") ?? "";
      if (!ct.includes("text/event-stream")) {
        sendJSON(res, 200, { ok: false, error: `非 SSE 响应: Content-Type 为 ${ct}` });
        return;
      }

      // 读取第一个 SSE 事件获取 message endpoint
      const reader = sseResponse.body!.getReader();
      const { value } = await reader.read();
      reader.cancel();
      const text = new TextDecoder().decode(value);

      // 解析: "event: endpoint\ndata: <url>"
      const endpointMatch = text.match(/event:\s*endpoint\s*\n?data:\s*(\S+)/);
      if (!endpointMatch?.[1]) {
        sendJSON(res, 200, { ok: false, error: "未收到 SSE endpoint 事件" });
        return;
      }

      const messageUrl = endpointMatch[1].trim();

      const initResponse = await fetch(messageUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...authHeaders },
        body: JSON.stringify(initPayload),
        signal: AbortSignal.timeout(5000),
      });

      if (!initResponse.ok) {
        sendJSON(res, 200, { ok: false, error: `Initialize 请求失败 HTTP ${initResponse.status}` });
        return;
      }

      const data = await parseMCPInitResponse(initResponse);
      if (data.error) {
        sendJSON(res, 200, { ok: false, error: String((data.error as Record<string, string>).message ?? JSON.stringify(data.error)) });
        return;
      }

      sendJSON(res, 200, { ok: true, server: data.result });
    } else {
      // Streamable HTTP: 直接 POST initialize
      const response = await fetch(kgUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...authHeaders },
        body: JSON.stringify(initPayload),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        sendJSON(res, 200, { ok: false, error: `HTTP ${response.status}` });
        return;
      }

      const data = await parseMCPInitResponse(response);
      if (data.error) {
        sendJSON(res, 200, { ok: false, error: String((data.error as Record<string, string>).message ?? JSON.stringify(data.error)) });
        return;
      }

      sendJSON(res, 200, { ok: true, server: data.result });
    }
  } catch (err) {
    sendJSON(res, 200, { ok: false, error: String((err as Error).message) });
  }
}

// ─── 聊天 ───

export async function handleChat(
  sessionId: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 防并发：同一 session 不能同时聊天和探索
  if (runningExplorations.has(sessionId)) {
    sendJSON(res, 409, { error: "Exploration already running" });
    return;
  }

  // 支持预读取 body（handlePublicChat 已读取，注入到 _preReadBody）
  const rawBody: string = (req as unknown as Record<string, unknown>)._preReadBody as string ?? await readBody(req);
  const { message, mode } = JSON.parse(rawBody || "{}");

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

  // 首次聊天时自动更新会话标题（匹配默认标题模式）
  // 兼容：管理端"新会话"、访客"访客-xxx"、用户"会话"
  const isDefaultTitle = session.title === "新会话" || session.title === "会话" || /^访客-/.test(session.title);

  runningExplorations.set(sessionId, {
    explorationId: `chat_${Date.now()}`,
    abortController: new AbortController(),
  });

  // 新 turn 开始时清空旧缓冲
  stepBuffers.delete(sessionId);

  // 202 Accepted — 异步处理
  res.writeHead(202, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "accepted" }));

  // 立即持久化用户消息 + 可选的标题更新（必须在同一次文件写入中完成，避免竞态覆盖）
  const userMsg: ChatMessage = {
    role: "user",
    content: message.trim(),
    created_at: new Date().toISOString(),
  };

  // 原子地：追加用户消息 + 可能更新标题
  if (isDefaultTitle) {
    const newTitle = message.trim().slice(0, 40);
    updateSessionTitleAndAppend(chatSessionId, newTitle, [userMsg]).catch((err) => {
      log.warn({ err, sessionId }, "持久化用户消息+标题失败");
    });
  } else {
    appendChatMessages(chatSessionId, [userMsg]).catch((err) => {
      log.warn({ err, sessionId }, "持久化用户消息失败");
    });
  }

  handleUserMessage(history, message.trim(), (eventType: string, data: unknown) =>
    broadcastSSE(chatSessionId, eventType, data),
  chatMode,
    runningExplorations.get(sessionId)?.abortController.signal,
  )
    .then(async (newMessages) => {
      // userMsg 已持久化，这里只追加 assistant 回复
      await appendChatMessages(chatSessionId, newMessages);
    })
    .catch(async (err) => {
      log.error({ err, sessionId }, "聊天处理失败");
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

// ─── 公共命名空间 ───
// 访客通过分享链接访问：查看 demo（只读不计次）+ 限次聊天 + 多会话管理

async function handlePublic(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // GET /api/public/demo — 展示会话（只读）
  if (path === "/api/public/demo" && req.method === "GET") {
    const demoId = readSettings().web?.demo_session_id;
    if (!demoId) {
      sendJSON(res, 404, { error: "未配置展示会话" });
      return;
    }
    const session = await getSession(demoId);
    if (!session) {
      sendJSON(res, 404, { error: "展示会话不存在" });
      return;
    }
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(session));
    return;
  }

  // GET /api/public/token/:token — 令牌信息（只读不计次）
  const tokenInfoMatch = path.match(/^\/api\/public\/token\/([^/]+)$/);
  if (tokenInfoMatch && req.method === "GET") {
    const t = getToken(tokenInfoMatch[1]);
    if (!t || t.disabled) {
      sendJSON(res, 404, { error: "链接无效或已禁用" });
      return;
    }
    sendJSON(res, 200, {
      label: t.label,
      remaining: Math.max(0, t.usage_limit - t.usage_count),
      limit: t.usage_limit,
      used: t.usage_count,
    });
    return;
  }

  // POST /api/public/token/:token/chat — 访客发消息（计次，需 session_id）
  const chatMatch = path.match(/^\/api\/public\/token\/([^/]+)\/chat$/);
  if (chatMatch && req.method === "POST") {
    await handlePublicChat(chatMatch[1], req, res);
    return;
  }

  // GET /api/public/token/:token/stream — 访客 SSE（需 session query param）
  const streamMatch = path.match(/^\/api\/public\/token\/([^/]+)\/stream$/);
  if (streamMatch && req.method === "GET") {
    const t = getToken(streamMatch[1]);
    if (!t || t.disabled) {
      sendJSON(res, 404, { error: "链接无效或已禁用" });
      return;
    }
    // 从 query string 中提取 session id
    const query = url.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    const sessionId = params.get("session");
    if (!sessionId) {
      sendJSON(res, 400, { error: "缺少 session 参数" });
      return;
    }
    // 验证 session 属于该 token
    const owner = await getTokenSession(t.token, sessionId);
    if (!owner) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    handleSSE(sessionId, req, res);
    return;
  }

  // ─── 访客多会话管理 ───

  // GET /api/public/token/:token/sessions — 列出所有会话
  const sessionsListMatch = path.match(/^\/api\/public\/token\/([^/]+)\/sessions$/);
  if (sessionsListMatch && req.method === "GET") {
    const t = getToken(sessionsListMatch[1]);
    if (!t || t.disabled) {
      sendJSON(res, 404, { error: "链接无效或已禁用" });
      return;
    }
    const sessions = await listTokenSessions(t.token);
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(sessions));
    return;
  }

  // POST /api/public/token/:token/sessions — 创建新会话
  if (sessionsListMatch && req.method === "POST") {
    const t = getToken(sessionsListMatch[1]);
    if (!t || t.disabled) {
      sendJSON(res, 404, { error: "链接无效或已禁用" });
      return;
    }
    const body = await readBody(req);
    const { title } = JSON.parse(body || "{}");
    const session = await createTokenSession(t.token, typeof title === "string" ? title : undefined);
    if (!session) {
      sendJSON(res, 500, { error: "创建会话失败" });
      return;
    }
    res.writeHead(201, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: session.id, title: session.title, created_at: session.created_at }));
    return;
  }

  // GET /api/public/token/:token/sessions/:sessionId/status — 查询会话是否仍在处理
  // 轻量端点（不读 session 内容），供前端断线重连时判断后端真实状态
  const sessionStatusMatch = path.match(/^\/api\/public\/token\/([^/]+)\/sessions\/([^/]+)\/status$/);
  if (sessionStatusMatch && req.method === "GET") {
    const t = getToken(sessionStatusMatch[1]);
    if (!t || t.disabled) {
      sendJSON(res, 404, { error: "链接无效或已禁用" });
      return;
    }
    // 校验会话归属
    const owned = await getTokenSession(t.token, sessionStatusMatch[2]);
    if (!owned) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    sendJSON(res, 200, { running: runningExplorations.has(sessionStatusMatch[2]) });
    return;
  }

  // GET /api/public/token/:token/sessions/:sessionId — 获取会话消息
  const sessionDetailMatch = path.match(/^\/api\/public\/token\/([^/]+)\/sessions\/([^/]+)$/);
  if (sessionDetailMatch && req.method === "GET") {
    const t = getToken(sessionDetailMatch[1]);
    if (!t || t.disabled) {
      sendJSON(res, 404, { error: "链接无效或已禁用" });
      return;
    }
    const session = await getTokenSession(t.token, sessionDetailMatch[2]);
    if (!session) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    sendJSON(res, 200, {
      messages: session.messages ?? [],
      processing: runningExplorations.has(sessionDetailMatch[2]),
    });
    return;
  }

  // DELETE /api/public/token/:token/sessions/:sessionId — 删除会话
  if (sessionDetailMatch && req.method === "DELETE") {
    const t = getToken(sessionDetailMatch[1]);
    if (!t || t.disabled) {
      sendJSON(res, 404, { error: "链接无效或已禁用" });
      return;
    }
    const ok = await deleteTokenSession(t.token, sessionDetailMatch[2]);
    if (!ok) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    sendJSON(res, 200, { ok: true });
    return;
  }

  sendJSON(res, 404, { error: "Not found" });
}

/** 访客聊天：先校验令牌 + 剩余次数 + session_id + 并发，再复用 handleChat。
 *  计次在确认可派发后执行，避免并发拒绝（409）浪费配额。 */
async function handlePublicChat(
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const t = getToken(token);
  if (!t || t.disabled) {
    sendJSON(res, 404, { error: "链接无效或已禁用" });
    return;
  }
  if (t.usage_count >= t.usage_limit) {
    sendJSON(res, 403, { error: "使用次数已用完", remaining: 0, limit: t.usage_limit });
    return;
  }

  const body = await readBody(req);
  const { message, session_id } = JSON.parse(body || "{}");

  // 解析或创建 session
  let sessionId: string;
  if (typeof session_id === "string" && session_id.length > 0) {
    // 验证 session 归属
    if (!t.session_ids.includes(session_id)) {
      sendJSON(res, 404, { error: "会话不存在" });
      return;
    }
    sessionId = session_id;
  } else {
    // 未指定则自动创建新会话
    const created = await createTokenSession(t.token);
    if (!created) {
      sendJSON(res, 500, { error: "无法创建会话" });
      return;
    }
    sessionId = created.id;
  }

  // 并发检查：访客会话正在处理时拒绝（不计次）。
  if (runningExplorations.has(sessionId)) {
    sendJSON(res, 409, { error: "上一条消息还在处理中，请稍候", remaining: t.usage_limit - t.usage_count });
    return;
  }

  // 确认可派发 → 计次（+1）
  incrementUsage(t.token);

  // 将预读取的 body 注入 req，避免 handleChat 重复读取已消费的流
  (req as unknown as Record<string, unknown>)._preReadBody = body;

  // 复用现有 handleChat（内部已处理并发防护、SSE 广播）
  await handleChat(sessionId, req, res);
}

// ─── 分享令牌管理（admin）───

async function handleShareTokens(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // GET /api/share-tokens — 列表
  if (path === "/api/share-tokens" && req.method === "GET") {
    const tokens = listTokens();
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(tokens));
    return;
  }

  // POST /api/share-tokens — 创建
  if (path === "/api/share-tokens" && req.method === "POST") {
    const body = await readBody(req);
    const { label, usage_limit } = JSON.parse(body || "{}");
    const created = createToken({
      label: typeof label === "string" ? label : "未命名",
      usage_limit: typeof usage_limit === "number" ? usage_limit : 5,
    });
    res.writeHead(201, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(created));
    return;
  }

  // /api/share-tokens/:token/sessions — 查看/清除访客会话（admin）
  const sessionsMatch = path.match(/^\/api\/share-tokens\/([^/]+)\/sessions$/);
  if (sessionsMatch) {
    const t = sessionsMatch[1];
    if (!getToken(t)) {
      sendJSON(res, 404, { error: "令牌不存在" });
      return;
    }
    if (req.method === "GET") {
      const sessions = await getAllTokenSessions(t);
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify(sessions));
      return;
    }
    if (req.method === "DELETE") {
      const result = await clearTokenSessions(t);
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: result.cleared, count: result.count }));
      return;
    }
    sendJSON(res, 405, { error: "Method not allowed" });
    return;
  }

  // /api/share-tokens/:token — 禁用/启用/删除
  const tokenMatch = path.match(/^\/api\/share-tokens\/([^/]+)$/);
  if (tokenMatch) {
    const t = tokenMatch[1];
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const { disabled } = JSON.parse(body || "{}");
      const updated = disableToken(t, !!disabled);
      if (!updated) {
        sendJSON(res, 404, { error: "令牌不存在" });
        return;
      }
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify(updated));
      return;
    }
    if (req.method === "DELETE") {
      const result = await deleteToken(t);
      if (!result.deleted) {
        sendJSON(res, 404, { error: "令牌不存在" });
        return;
      }
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({ deleted: true, sessions_cleaned: result.sessions_cleaned }));
      return;
    }
  }

  sendJSON(res, 404, { error: "Not found" });
}

// ─── 用户管理（admin）───

async function handleAdminUsers(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = req.url ?? "/";
  const path = url.split("?")[0];

  // GET /api/admin/users — 用户列表（含活跃度/会话数统计，无对话内容）
  if (path === "/api/admin/users" && req.method === "GET") {
    const users = listUsers().map((u) => ({
      id: u.id,
      email: u.email,
      display_name: u.display_name,
      usage_limit: u.usage_limit,
      usage_count: u.usage_count,
      session_count: u.session_ids.length,
      disabled: u.disabled,
      created_at: u.created_at,
      last_active_at: u.last_active_at,
    }));
    res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
    res.end(JSON.stringify(users));
    return;
  }

  // /api/admin/users/:id — 禁用/启用/调额度/删除
  const userMatch = path.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (userMatch) {
    const userId = userMatch[1];
    if (req.method === "PATCH") {
      const body = await readBody(req);
      const { disabled, usage_limit, new_password } = JSON.parse(body || "{}");
      let updated = null;
      if (typeof disabled === "boolean") {
        updated = disableUser(userId, disabled);
      }
      if (typeof usage_limit === "number") {
        updated = setUserQuota(userId, usage_limit);
      }
      if (typeof new_password === "string" && new_password.length >= 8) {
        const passwordHash = await hashPassword(new_password);
        updated = setUserPassword(userId, passwordHash);
      }
      if (!updated) {
        sendJSON(res, 404, { error: "用户不存在" });
        return;
      }
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: updated.id,
        email: updated.email,
        display_name: updated.display_name,
        usage_limit: updated.usage_limit,
        usage_count: updated.usage_count,
        disabled: updated.disabled,
        created_at: updated.created_at,
      }));
      return;
    }
    if (req.method === "DELETE") {
      const result = await deleteUser(userId);
      if (!result.deleted) {
        sendJSON(res, 404, { error: "用户不存在" });
        return;
      }
      sendJSON(res, 200, { deleted: true, sessions_cleaned: result.sessions_cleaned });
      return;
    }
  }

  sendJSON(res, 404, { error: "Not found" });
}

// ─── SSE 端点 ───

export function handleSSE(
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
      log.warn({ err, sessionId }, "appendStep 写入失败");
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
