// 会话持久化 — JSON 文件存储 — 对应 design-docs/frontend-design.md 第四节
//
// 文件结构: data/sessions/<uuid>.json
// 每个文件包含 Session 完整数据（含 ExplorationState 序列化）

import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Finding, EventThread, StepEvent, SerializedState } from "./agent/state.js";
import type { ExplorationOutput } from "./agent/state.js";
import type { ChatMessage } from "./chat/types.js";

// ─── 数据结构 ───

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  explorations: Exploration[];
  messages: ChatMessage[];
}

export interface Exploration {
  id: string;
  goal: string;
  seed_entities: string[];
  max_depth: number;
  status: "running" | "completed" | "error" | "cancelled";
  output: ExplorationOutput | null;
  steps: StepSnapshot[];
  started_at: string;
  completed_at: string | null;
  serialized_state: SerializedState | null;
}

// 步骤快照 — 从 StepEvent 提取前端需要的子集
export interface StepSnapshot {
  step: number;
  phase: "EXPLORING" | "FINALIZE";
  decision?: string;
  tools_used?: string[];
  new_entities?: string[];
  new_findings_count?: number;
  total_findings?: number;
  total_entities?: number;
  total_events?: number;
}

// ─── 文件路径 ───

const DATA_DIR = join(process.cwd(), "data", "sessions");

function sessionPath(id: string): string {
  return join(DATA_DIR, `${id}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
}

// ─── CRUD ───

export async function createSession(title?: string): Promise<Session> {
  await ensureDir();
  const session: Session = {
    id: randomUUID(),
    title: title ?? "新会话",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    explorations: [],
    messages: [],
  };
  await writeFile(sessionPath(session.id), JSON.stringify(session, null, 2), "utf-8");
  return session;
}

export async function getSession(id: string): Promise<Session | null> {
  try {
    const raw = await readFile(sessionPath(id), "utf-8");
    const session = JSON.parse(raw) as Session;
    if (!session.messages) session.messages = [];
    return session;
  } catch {
    return null;
  }
}

interface SessionSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  explorations: Exploration[];
}

export async function listSessions(): Promise<SessionSummary[]> {
  await ensureDir();
  const files = await readdir(DATA_DIR);
  const sessions: SessionSummary[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(DATA_DIR, file), "utf-8");
      const s = JSON.parse(raw) as Session;
      sessions.push({
        id: s.id,
        title: s.title,
        created_at: s.created_at,
        updated_at: s.updated_at,
        explorations: s.explorations,
      });
    } catch {
      // 跳过损坏文件
    }
  }

  return sessions.sort(
    (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
  );
}

export async function updateSession(
  id: string,
  patch: Partial<Pick<Session, "title">>,
): Promise<Session | null> {
  const session = await getSession(id);
  if (!session) return null;

  if (patch.title !== undefined) session.title = patch.title;
  session.updated_at = new Date().toISOString();

  await writeFile(sessionPath(id), JSON.stringify(session, null, 2), "utf-8");
  return session;
}

export async function deleteSession(id: string): Promise<boolean> {
  try {
    await unlink(sessionPath(id));
    return true;
  } catch {
    return false;
  }
}

// ─── 对话消息操作 ───

export async function appendChatMessages(
  sessionId: string,
  newMessages: ChatMessage[],
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  session.messages.push(...newMessages);
  session.updated_at = new Date().toISOString();
  await writeFile(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf-8");
}

/**
 * 原子操作：同时更新标题和追加消息，避免竞态覆盖。
 * 用于自动命名场景——标题更新和用户消息持久化必须在同一次读写中完成。
 */
export async function updateSessionTitleAndAppend(
  sessionId: string,
  newTitle: string,
  newMessages: ChatMessage[],
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  session.title = newTitle;
  session.messages.push(...newMessages);
  session.updated_at = new Date().toISOString();
  await writeFile(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf-8");
}

// ─── 探索记录操作 ───

export function createExploration(
  goal: string,
  seedEntities: string[],
  maxDepth: number,
): Exploration {
  return {
    id: randomUUID(),
    goal,
    seed_entities: seedEntities,
    max_depth: maxDepth,
    status: "running",
    output: null,
    steps: [],
    started_at: new Date().toISOString(),
    completed_at: null,
    serialized_state: null,
  };
}

export async function appendStep(
  sessionId: string,
  explorationId: string,
  event: StepEvent,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  const exploration = session.explorations.find((e) => e.id === explorationId);
  if (!exploration) return;

  exploration.steps.push({
    step: event.step,
    phase: event.phase,
    decision: event.decision,
    tools_used: event.tools_used,
    new_entities: event.new_entities,
    new_findings_count: event.new_findings_count,
    total_findings: event.total_findings,
    total_entities: event.total_entities,
    total_events: event.total_events,
  });

  session.updated_at = new Date().toISOString();
  await writeFile(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf-8");
}

export async function completeExploration(
  sessionId: string,
  explorationId: string,
  output: ExplorationOutput,
  serializedState?: SerializedState,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  const exploration = session.explorations.find((e) => e.id === explorationId);
  if (!exploration) return;

  exploration.status = "completed";
  exploration.output = output;
  exploration.completed_at = new Date().toISOString();
  if (serializedState) exploration.serialized_state = serializedState;

  // 自动更新会话标题（首次探索时）
  if (session.explorations.indexOf(exploration) === 0 && session.title === "新会话") {
    session.title = exploration.goal.slice(0, 40);
  }

  session.updated_at = new Date().toISOString();
  await writeFile(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf-8");
}

export async function failExploration(
  sessionId: string,
  explorationId: string,
  error: string,
): Promise<void> {
  const session = await getSession(sessionId);
  if (!session) return;

  const exploration = session.explorations.find((e) => e.id === explorationId);
  if (!exploration) return;

  exploration.status = "error";
  exploration.completed_at = new Date().toISOString();
  if (!exploration.output) {
    exploration.output = {
      findings: [],
      event_threads: [],
      exploration_meta: {
        completion_reason: "frontier_empty",
        stats: {
          steps: exploration.steps.length,
          entities_visited: 0,
          findings_count: 0,
          events_buffered: 0,
          tokens_used: 0,
        },
        exploration_log: [],
        reliability_note: `探索失败: ${error}`,
      },
    };
  }

  session.updated_at = new Date().toISOString();
  await writeFile(sessionPath(sessionId), JSON.stringify(session, null, 2), "utf-8");
}
