// 用户账号存储 — JSON 文件存储，仿 share-store.ts 模式
//
// 文件结构: data/users.json
//   { users: User[] }
//
// 与 share-store 的关系:
//   - share-store 的 token 模式保留不动（访客入口 /s/:token）
//   - user-store 是独立的账号体系（注册用户入口 /app）
//   - 两套体系各自维护自己的 session_ids，互不干扰
//   - session 文件通过 owner_id 字段标记归属（user-store 创建时写入）

import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  createSession, getSession, deleteSession, appendChatMessages,
} from "./session-store.js";
import type { Session } from "./session-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("user-store");

export interface User {
  id: string;
  email: string;             // 唯一，存储时小写化
  password_hash: string;     // scrypt 哈希，格式 "saltHex:hashHex"
  display_name: string;      // 展示名，默认取 email @ 前缀
  usage_limit: number;       // 注册赠送的额度
  usage_count: number;       // 已用次数（跨会话累计）
  session_ids: string[];     // 该用户的会话列表
  created_at: string;
  last_active_at: string | null;
  disabled: boolean;         // admin 可禁用
}

interface StoreShape {
  users: User[];
}

const DATA_DIR = resolve(process.cwd(), "data");
const STORE_PATH = resolve(DATA_DIR, "users.json");

// ─── 读写（兼容初始化）───

function readStore(): StoreShape {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as StoreShape;
      if (!Array.isArray(parsed.users)) return { users: [] };
      return parsed;
    }
  } catch {
    // 文件损坏
  }
  return { users: [] };
}

function writeStore(store: StoreShape): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(STORE_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/** 启动时初始化（index.ts 调用） */
export function migrateUsers(): void {
  if (!existsSync(STORE_PATH)) {
    writeStore({ users: [] });
    log.info("users.json 已初始化");
  }
}

// ─── 查询 ───

export function listUsers(): User[] {
  return readStore().users.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
}

export function getUser(id: string): User | null {
  return readStore().users.find((u) => u.id === id) ?? null;
}

export function findUserByEmail(email: string): User | null {
  const normalized = email.trim().toLowerCase();
  return readStore().users.find((u) => u.email === normalized) ?? null;
}

// ─── 创建 ───

export interface CreateUserInput {
  email: string;
  password_hash: string;
  display_name?: string;
  usage_limit: number;
}

export function createUser(input: CreateUserInput): User {
  const store = readStore();
  const email = input.email.trim().toLowerCase();
  const now = new Date().toISOString();

  const user: User = {
    id: randomUUID(),
    email,
    password_hash: input.password_hash,
    display_name: input.display_name?.trim() || email.split("@")[0] || "用户",
    usage_limit: Math.max(0, Math.floor(input.usage_limit)),
    usage_count: 0,
    session_ids: [],
    created_at: now,
    last_active_at: null,
    disabled: false,
  };
  store.users.push(user);
  writeStore(store);
  log.info({ userId: user.id, email }, "新用户注册");
  return user;
}

// ─── 更新 ───

export function disableUser(id: string, disabled: boolean): User | null {
  const store = readStore();
  const u = store.users.find((x) => x.id === id);
  if (!u) return null;
  u.disabled = disabled;
  writeStore(store);
  return u;
}

/** 调整用户额度（admin） */
export function setUserQuota(id: string, newLimit: number): User | null {
  const store = readStore();
  const u = store.users.find((x) => x.id === id);
  if (!u) return null;
  u.usage_limit = Math.max(0, Math.floor(newLimit));
  writeStore(store);
  return u;
}

/** 原子地 +1 使用次数并返回更新后的 user */
export function incrementUserUsage(id: string): User | null {
  const store = readStore();
  const u = store.users.find((x) => x.id === id);
  if (!u) return null;
  u.usage_count += 1;
  u.last_active_at = new Date().toISOString();
  writeStore(store);
  return u;
}

export function touchUser(id: string): void {
  const store = readStore();
  const u = store.users.find((x) => x.id === id);
  if (!u) return;
  u.last_active_at = new Date().toISOString();
  writeStore(store);
}

// ─── 用户会话管理 ───

/**
 * 为用户创建新会话。
 * session 文件写入 owner_id 标记归属。
 */
export async function createUserSession(userId: string, title?: string): Promise<Session | null> {
  const store = readStore();
  const u = store.users.find((x) => x.id === userId);
  if (!u) return null;

  const session = await createSession(title ?? `会话`, u.id);
  u.session_ids.push(session.id);
  writeStore(store);
  log.info({ userId, sessionId: session.id }, "用户创建新会话");
  return session;
}

/**
 * 获取用户的所有会话摘要（不含 messages 全文）
 */
export async function listUserSessions(userId: string): Promise<{ id: string; title: string; created_at: string; updated_at: string; message_count: number }[]> {
  const u = getUser(userId);
  if (!u) return [];

  const result: { id: string; title: string; created_at: string; updated_at: string; message_count: number }[] = [];
  for (const sid of u.session_ids) {
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
 * 获取用户指定会话（校验归属）
 */
export async function getUserSession(userId: string, sessionId: string): Promise<Session | null> {
  const u = getUser(userId);
  if (!u || !u.session_ids.includes(sessionId)) return null;
  return getSession(sessionId);
}

/**
 * 删除用户指定会话。
 * 用户至少保留 1 个会话（首个不可删，与 ShareView 行为一致）。
 */
export async function deleteUserSession(userId: string, sessionId: string): Promise<boolean> {
  const store = readStore();
  const u = store.users.find((x) => x.id === userId);
  if (!u) return false;
  const idx = u.session_ids.indexOf(sessionId);
  if (idx === -1) return false;
  // 首个会话（默认会话）不可删除
  if (idx === 0) return false;

  try {
    await deleteSession(sessionId);
  } catch (err) {
    log.warn({ err, userId, sessionId }, "删除会话文件失败");
  }
  u.session_ids.splice(idx, 1);
  writeStore(store);
  return true;
}

/**
 * 用户级联清理：删除用户及其所有会话（admin 操作）
 */
export async function deleteUser(userId: string): Promise<{ deleted: boolean; sessions_cleaned: number }> {
  const store = readStore();
  const idx = store.users.findIndex((u) => u.id === userId);
  if (idx === -1) return { deleted: false, sessions_cleaned: 0 };

  const u = store.users[idx];
  let cleaned = 0;
  for (const sid of u.session_ids) {
    try {
      const ok = await deleteSession(sid);
      if (ok) cleaned++;
    } catch (err) {
      log.warn({ err, sessionId: sid }, "级联删除会话失败");
    }
  }
  store.users.splice(idx, 1);
  writeStore(store);
  log.info({ userId, cleaned }, "用户已删除，级联清理会话");
  return { deleted: true, sessions_cleaned: cleaned };
}

export { appendChatMessages };
