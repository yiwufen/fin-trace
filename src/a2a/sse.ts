// A2A SSE streaming — maps internal StepEvent to A2A TaskStatusUpdateEvent
//
// Reuses the existing broadcastSSE pattern from api.ts, but emits
// A2A-compliant SSE events for tasks/sendSubscribe.

import type { ServerResponse } from "node:http";
import type { StepEvent } from "../agent/state.js";
import type { Task, TaskStatusMessage } from "./types.js";

// ─── SSE connection registry ───

const connections = new Map<string, Set<ServerResponse>>();

export function addConnection(taskId: string, res: ServerResponse): void {
  let set = connections.get(taskId);
  if (!set) {
    set = new Set();
    connections.set(taskId, set);
  }
  set.add(res);
}

export function removeConnection(taskId: string, res: ServerResponse): void {
  const set = connections.get(taskId);
  if (set) {
    set.delete(res);
    if (set.size === 0) connections.delete(taskId);
  }
}

// ─── A2A SSE event format ───

function emitA2AEvent(
  res: ServerResponse,
  taskId: string,
  status: string,
  parts: TaskStatusMessage["parts"],
  metadata?: Record<string, unknown>,
): void {
  const event = {
    taskId,
    status,
    message: { parts },
    ...(metadata ? { metadata } : {}),
  };
  res.write(`event: task\ndata: ${JSON.stringify(event)}\n\n`);
}

// ─── Broadcast to all SSE connections for a task ───

export function broadcastTaskProgress(
  taskId: string,
  event: StepEvent,
): void {
  const set = connections.get(taskId);
  if (!set || set.size === 0) return;

  const text =
    event.type === "step_complete"
      ? `Step ${event.step}: ${event.decision ?? "exploring"} → ${(event.tools_used ?? []).join(", ")} (+${event.new_entities?.length ?? 0} entities, ${event.total_events} events)`
      : event.type === "finalize"
        ? "FINALIZE: 正在整理发现和构建事件脉络..."
        : event.type === "error"
          ? `Error: ${event.error}`
          : `Step ${event.step}`;

  const parts = [{ type: "text" as const, text }];
  const metadata: Record<string, unknown> = {
    step: event.step,
    phase: event.phase,
  };

  if (event.type === "step_complete") {
    metadata.total_entities = event.total_entities;
    metadata.total_events = event.total_events;
    metadata.budget_used = event.budget_used;
    metadata.total_findings = event.total_findings;
  }

  for (const res of set) {
    try {
      emitA2AEvent(res, taskId, "working", parts, metadata);
    } catch {
      set.delete(res);
    }
  }
}

export function broadcastTaskCompleted(
  taskId: string,
  summary: string,
): void {
  const set = connections.get(taskId);
  if (!set) return;
  for (const res of set) {
    try {
      emitA2AEvent(res, taskId, "completed", [{ type: "text", text: summary }]);
    } catch {
      set.delete(res);
    }
  }
}

export function broadcastTaskFailed(taskId: string, error: string): void {
  const set = connections.get(taskId);
  if (!set) return;
  for (const res of set) {
    try {
      emitA2AEvent(res, taskId, "failed", [{ type: "text", text: error }]);
    } catch {
      set.delete(res);
    }
  }
}

export function closeAllConnections(taskId: string): void {
  const set = connections.get(taskId);
  if (!set) return;
  for (const res of set) {
    try {
      res.end();
    } catch {
      // ignore
    }
  }
  connections.delete(taskId);
}
