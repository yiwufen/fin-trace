// 分享令牌持久化 — JSON 文件存储
//
// 为 HR 等外部用户提供带使用次数限制的访问链接。
// 每个 token 绑定一个独立的 HR 会话（懒创建），与 demo / 管理端会话隔离。
//
// 文件结构: data/share-tokens.json
//   { tokens: ShareToken[] }

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createSession } from "./session-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("share-store");

export interface ShareToken {
  /** url-safe 随机令牌（路径中使用） */
  token: string;
  /** 人类可读标签，如 "HR-张三" */
  label: string;
  /** 最大可发送消息数 */
  usage_limit: number;
  /** 已发送消息数 */
  usage_count: number;
  /** 懒创建的 HR 聊天会话 id；首次使用时创建 */
  hr_session_id: string | null;
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

// ─── 读写 ───

function readStore(): StoreShape {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as StoreShape;
      if (!Array.isArray(parsed.tokens)) return { tokens: [] };
      return parsed;
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
  // 18 字节 → 24 字符 url-safe base64
  return randomBytes(18).toString("base64url");
}

// ─── CRUD ───

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
    hr_session_id: null,
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

export function deleteToken(token: string): boolean {
  const store = readStore();
  const idx = store.tokens.findIndex((t) => t.token === token);
  if (idx === -1) return false;
  store.tokens.splice(idx, 1);
  writeStore(store);
  return true;
}

/**
 * 原子地 +1 使用次数并返回更新后的 token。
 * 调用方需在发消息前调用，避免超额。
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

/**
 * 确保 token 有绑定的 HR 会话，没有则懒创建。
 * 返回 hr_session_id。
 */
export async function ensureHrSession(token: string): Promise<string | null> {
  const store = readStore();
  const t = store.tokens.find((x) => x.token === token);
  if (!t) return null;

  if (t.hr_session_id) return t.hr_session_id;

  // 懒创建 — 标题用 label 区分
  const session = await createSession(`HR-${t.label}`);
  t.hr_session_id = session.id;
  writeStore(store);
  log.info({ token: t.token, sessionId: session.id }, "为分享令牌懒创建 HR 会话");
  return session.id;
}
