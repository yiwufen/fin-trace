// 分享令牌持久化 — JSON 文件存储
//
// 为外部用户提供带使用次数限制的访问链接。
// 每个 token 可绑定多个独立的会话，与管理端会话隔离。
// 配额跨会话共享。
//
// 文件结构: data/share-tokens.json
//   { tokens: ShareToken[] }
//
// 兼容迁移: v1 的 hr_session_id (string|null) 自动迁移为 session_ids (string[])

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createSession, getSession, deleteSession, appendChatMessages, updateSession } from "./session-store.js";
import type { Session } from "./session-store.js";
import type { ChatMessage } from "./chat/types.js";
import { readSettings } from "./settings-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("share-store");

export interface ShareToken {
  /** url-safe 随机令牌（路径中使用） */
  token: string;
  /** 人类可读标签，如 "张三" */
  label: string;
  /** 最大可发送消息数 */
  usage_limit: number;
  /** 已发送消息数（跨会话累计） */
  usage_count: number;
  /** 绑定的访客会话 id 列表（v2: 多会话） */
  session_ids: string[];
  created_at: string;
  last_used_at: string | null;
  /** 管理员手动禁用 */
  disabled: boolean;
}

interface StoreShape {
  tokens: ShareToken[];
}

const DATA_DIR = resolve(process.cwd(), "data");
const STORE_PATH = resolve(DATA_DIR, "share-tokens.json");

// ─── 读写（兼容 v1 迁移）───

function readStore(): StoreShape {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as StoreShape & { tokens: (ShareToken & { hr_session_id?: string | null })[] };
      if (!Array.isArray(parsed.tokens)) return { tokens: [] };

      // v1 → v2 迁移: hr_session_id (string|null) → session_ids (string[])
      let migrated = false;
      for (const t of parsed.tokens) {
        if (!Array.isArray(t.session_ids)) {
          // 旧格式
          const oldId = (t as ShareToken & { hr_session_id?: string | null }).hr_session_id;
          t.session_ids = oldId ? [oldId] : [];
          delete (t as unknown as Record<string, unknown>).hr_session_id;
          migrated = true;
        }
      }
      if (migrated) {
        writeFileSync(STORE_PATH, JSON.stringify(parsed, null, 2), "utf-8");
        log.info("将 share-tokens.json 从 v1 (hr_session_id) 迁移到 v2 (session_ids)");
      }

      return parsed as StoreShape;
    }
  } catch {
    // 文件损坏
  }
  return { tokens: [] };
}

function writeStore(store: StoreShape): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

function generateToken(): string {
  return randomBytes(18).toString("base64url");
}

// ─── Token CRUD ───

export function listTokens(): ShareToken[] {
  return readStore().tokens.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export function getToken(token: string): ShareToken | null {
  return readStore().tokens.find((t) => t.token === token) ?? null;
}

export interface CreateTokenInput {
  label: string;
  usage_limit: number;
}

export function createToken(input: CreateTokenInput): ShareToken {
  const store = readStore();
  const now = new Date().toISOString();
  const newToken: ShareToken = {
    token: generateToken(),
    label: input.label.trim() || "未命名",
    usage_limit: Math.max(1, Math.floor(input.usage_limit)),
    usage_count: 0,
    session_ids: [],
    created_at: now,
    last_used_at: null,
    disabled: false,
  };
  store.tokens.push(newToken);
  writeStore(store);
  return newToken;
}

export function disableToken(token: string, disabled: boolean): ShareToken | null {
  const store = readStore();
  const t = store.tokens.find((x) => x.token === token);
  if (!t) return null;
  t.disabled = disabled;
  writeStore(store);
  return t;
}

export async function deleteToken(token: string): Promise<{ deleted: boolean; sessions_cleaned: number }> {
  const store = readStore();
  const idx = store.tokens.findIndex((t) => t.token === token);
  if (idx === -1) return { deleted: false, sessions_cleaned: 0 };

  const t = store.tokens[idx];
  let sessionsCleaned = 0;

  // 级联删除全部关联的会话文件（删链接 = 删用户数据）
  for (const sid of t.session_ids) {
    try {
      const ok = await deleteSession(sid);
      if (ok) sessionsCleaned++;
    } catch (err) {
      log.warn({ err, token: t.token, sessionId: sid }, "级联删除会话失败");
    }
  }
  if (sessionsCleaned > 0) {
    log.info({ token: t.token, count: sessionsCleaned }, "令牌删除时级联清理会话");
  }

  store.tokens.splice(idx, 1);
  writeStore(store);
  return { deleted: true, sessions_cleaned: sessionsCleaned };
}

/**
 * 原子地 +1 使用次数并返回更新后的 token。
 */
export function incrementUsage(token: string): ShareToken | null {
  const store = readStore();
  const t = store.tokens.find((x) => x.token === token);
  if (!t) return null;
  t.usage_count += 1;
  t.last_used_at = new Date().toISOString();
  writeStore(store);
  return t;
}

// ─── 令牌会话管理 ───

/**
 * 为令牌创建新的会话。
 * 如果是该令牌的第一个会话且 admin 配置了展示案例，自动复制案例消息。
 */
export async function createTokenSession(token: string, title?: string): Promise<Session | null> {
  const store = readStore();
  const t = store.tokens.find((x) => x.token === token);
  if (!t) return null;

  const isFirst = t.session_ids.length === 0;
  const session = await createSession(title ?? `访客-${t.label}`);
  t.session_ids.push(session.id);

  // 首个会话：复制 admin 配置的展示案例消息 + 沿用案例标题
  if (isFirst) {
    const demoId = readSettings().web?.demo_session_id;
    if (demoId) {
      try {
        const demoSession = await getSession(demoId);
        if (demoSession && (demoSession.messages ?? []).length > 0) {
          // 深拷贝消息
          const copied: ChatMessage[] = demoSession.messages!.map((m) => ({
            role: m.role,
            content: typeof m.content === "string" ? m.content : m.content,
            created_at: m.created_at,
          }));
          await appendChatMessages(session.id, copied);
          session.messages = copied;
          // 沿用展示案例的会话名（而非 "访客-未命名"）
          if (!title && demoSession.title) {
            session.title = demoSession.title;
            await updateSession(session.id, { title: demoSession.title });
          }
          log.info({ token: t.token, sessionId: session.id, msgCount: copied.length, title: session.title }, "首会话已复制展示案例");
        }
      } catch (err) {
        log.warn({ err, token: t.token, demoId }, "复制展示案例消息失败");
      }
    }
  }

  writeStore(store);
  log.info({ token: t.token, sessionId: session.id }, "为分享令牌创建新会话");
  return session;
}

/**
 * 获取令牌下所有会话摘要。
 */
export async function listTokenSessions(token: string): Promise<{ id: string; title: string; created_at: string; updated_at: string; message_count: number }[]> {
  const t = getToken(token);
  if (!t) return [];

  const result: { id: string; title: string; created_at: string; updated_at: string; message_count: number }[] = [];
  for (const sid of t.session_ids) {
    const s = await getSession(sid);
    if (s) {
      result.push({
        id: s.id,
        title: s.title,
        created_at: s.created_at,
        updated_at: s.updated_at,
        message_count: (s.messages ?? []).length,
      });
    }
  }
  return result.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

/**
 * 获取令牌下的指定会话（验证归属）。
 */
export async function getTokenSession(token: string, sessionId: string): Promise<Session | null> {
  const t = getToken(token);
  if (!t || !t.session_ids.includes(sessionId)) return null;
  return getSession(sessionId);
}

/**
 * 删除令牌下的指定会话。
 * 第一个会话（index 0）不可删除。
 */
export async function deleteTokenSession(token: string, sessionId: string): Promise<boolean> {
  const store = readStore();
  const t = store.tokens.find((x) => x.token === token);
  if (!t) return false;

  const idx = t.session_ids.indexOf(sessionId);
  if (idx === -1) return false;
  // 第一个会话（默认会话）不可删除
  if (idx === 0) return false;

  try {
    await deleteSession(sessionId);
  } catch (err) {
    log.warn({ err, token, sessionId }, "删除会话文件失败");
  }

  t.session_ids.splice(idx, 1);
  writeStore(store);
  log.info({ token, sessionId }, "删除令牌会话");
  return true;
}

/**
 * 获取令牌关联的全部会话数据（供 admin 查看）。
 */
export async function getAllTokenSessions(token: string): Promise<Session[]> {
  const t = getToken(token);
  if (!t) return [];
  const sessions: Session[] = [];
  for (const sid of t.session_ids) {
    const s = await getSession(sid);
    if (s) sessions.push(s);
  }
  return sessions;
}

/**
 * 清除令牌关联的全部会话数据，重置使用计数。
 */
export async function clearTokenSessions(token: string): Promise<{ cleared: boolean; count: number }> {
  const store = readStore();
  const t = store.tokens.find((x) => x.token === token);
  if (!t) return { cleared: false, count: 0 };

  let count = 0;
  for (const sid of t.session_ids) {
    try {
      await deleteSession(sid);
      count++;
    } catch (err) {
      log.warn({ err, token: t.token, sessionId: sid }, "清除会话文件失败");
    }
  }

  t.session_ids = [];
  t.usage_count = 0;
  t.last_used_at = null;
  writeStore(store);
  log.info({ token, count }, "清除全部令牌会话");
  return { cleared: true, count };
}
