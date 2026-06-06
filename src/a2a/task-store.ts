// In-memory Task Store — maps taskId → Task
//
// Tasks are ephemeral: server restart loses running tasks.
// v1 acceptable; persistence can be added later (same pattern as session-store.ts).

import type { Task, TaskStatus, GraphExploreParams } from "./types.js";
import type { ExplorationOutput } from "../agent/state.js";

const store = new Map<string, Task>();

export function createTask(
  taskId: string,
  params: GraphExploreParams,
  abortController: AbortController,
): Task {
  const task: Task = {
    taskId,
    status: "submitted",
    createdAt: new Date().toISOString(),
    params,
    abortController,
  };
  store.set(taskId, task);
  return task;
}

export function getTask(taskId: string): Task | undefined {
  return store.get(taskId);
}

export function updateTaskStatus(
  taskId: string,
  status: TaskStatus,
  statusMessageParts?: Task["statusMessage"],
): void {
  const task = store.get(taskId);
  if (!task) return;
  task.status = status;
  if (statusMessageParts) {
    task.statusMessage = statusMessageParts;
  }
}

export function setTaskOutput(taskId: string, output: ExplorationOutput): void {
  const task = store.get(taskId);
  if (!task) return;
  task.output = output;
  task.artifacts = [
    {
      artifactId: `${taskId}-output`,
      parts: [
        {
          type: "data",
          data: output as unknown as Record<string, unknown>,
        },
      ],
    },
  ];
}

export function setTaskError(taskId: string, error: string): void {
  const task = store.get(taskId);
  if (!task) return;
  task.error = error;
}

export function deleteTask(taskId: string): void {
  store.delete(taskId);
}

// Clean up completed/failed/canceled tasks older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, task] of store) {
    if (
      (task.status === "completed" || task.status === "failed" || task.status === "canceled") &&
      new Date(task.createdAt).getTime() < cutoff
    ) {
      store.delete(id);
    }
  }
}, 10 * 60 * 1000); // every 10 minutes
