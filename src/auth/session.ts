// 用户会话 token 管理
//
// 用户登录后下发独立的会话 token（cookie 名 fin-trace-user），
// 区别于管理员的 fin-trace-admin-token。
//
// 存储: data/user-sessions.json（落盘）。
// 内存 Map 作为读缓存，写操作同步落盘 → 重启后登录态保留。
// 写入采用 write-tmp + rename 原子操作，避免写一半导致文件损坏。

import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { createLogger } from "../logger.js";

const log = createLogger("session");

const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

interface SessionEntry {
  userId: string;
  expires: number;
}

interface StoreShape {
  // sessionToken → { userId, expires }
  sessions: Record<string, SessionEntry>;
}

const DATA_DIR = resolve(process.cwd(), "data");
const STORE_PATH = resolve(DATA_DIR, "user-sessions.json");
const STORE_TMP_PATH = `${STORE_PATH}.tmp`;

// 内存缓存（读路径走这里，保持同步语义且零 IO）
const sessions = new Map<string, SessionEntry>();

// ─── 读写（同步，仿 user-store.ts 模式） ───

function readStore(): StoreShape {
  try {
    if (existsSync(STORE_PATH)) {
      const raw = readFileSync(STORE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as StoreShape;
      if (!parsed.sessions || typeof parsed.sessions !== "object") return { sessions: {} };
      return parsed;
    }
  } catch (err) {
    // 文件损坏：当空表启动，不崩溃
    log.warn({ err }, "user-sessions.json 损坏，已重置为空");
  }
  return { sessions: {} };
}

/** 原子写：先写 .tmp 再 rename，避免半写损坏 */
function writeStore(store: StoreShape): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(STORE_TMP_PATH, JSON.stringify(store, null, 2), "utf-8");
  renameSync(STORE_TMP_PATH, STORE_PATH);
}

/** 把内存 Map 序列化为 StoreShape 并落盘 */
function persist(): void {
  const store: StoreShape = { sessions: Object.fromEntries(sessions) };
  writeStore(store);
}

/** 启动时初始化（index.ts 调用）：文件不存在则创建空文件，存在则加载进内存 */
export function migrateUserSessions(): void {
  if (!existsSync(STORE_PATH)) {
    writeStore({ sessions: {} });
    log.info("user-sessions.json 已初始化");
    return;
  }
  // 文件已存在：加载进内存缓存（顺便清理已过期 token）
  const store = readStore();
  const now = Date.now();
  let expired = 0;
  for (const [token, entry] of Object.entries(store.sessions)) {
    if (entry.expires < now) {
      expired++;
      continue;
    }
    sessions.set(token, entry);
  }
  log.info({ loaded: sessions.size, expired }, "用户会话已加载");
}

// ─── 后台定期清理（保持原有行为）───
// 内存清理每 10 分钟跑一次；落盘只在 create/revoke 时发生，
// 过期 token 即便没被及时从磁盘移除，校验时也会被拒。

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [token, entry] of sessions) {
    if (entry.expires < now) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) persist();
}, 10 * 60 * 1000).unref?.();

// ─── 对外 API（签名不变，调用方零改动）───

/** 创建新会话 token 并关联 userId */
export function createSessionToken(userId: string): string {
  const token = randomBytes(24).toString("base64url");
  const entry: SessionEntry = { userId, expires: Date.now() + TOKEN_TTL_MS };
  sessions.set(token, entry);
  persist();
  return token;
}

/** 校验 token，返回 userId；过期或不存在返回 null */
export function getUserIdFromToken(token: string): string | null {
  const entry = sessions.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    sessions.delete(token);
    persist();
    return null;
  }
  return entry.userId;
}

/** 撤销单个 token（登出） */
export function revokeSessionToken(token: string): void {
  if (sessions.delete(token)) persist();
}

/** 撤销某用户的所有 token（禁用用户、改密码时用） */
export function revokeAllUserSessions(userId: string): void {
  let changed = false;
  for (const [token, entry] of sessions) {
    if (entry.userId === userId) {
      sessions.delete(token);
      changed = true;
    }
  }
  if (changed) persist();
}

/** Cookie 名 */
export const USER_COOKIE_NAME = "fin-trace-user";
