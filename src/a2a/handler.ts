// A2A JSON-RPC handler — tasks/send, tasks/get, tasks/cancel, tasks/sendSubscribe
//
// Each method maps to the Agent Loop:
//   tasks/send        → spawn runExploration async, return taskId immediately
//   tasks/get         → look up task in store, return status + artifacts
//   tasks/cancel      → abort the running exploration
//   tasks/sendSubscribe → tasks/send + open SSE stream

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { runExploration } from "../agent/loop.js";
import type { ExplorationInput } from "../agent/state.js";
import type { StepEvent } from "../agent/state.js";
import type {
  JsonRpcRequest,
  JsonRpcResponse,
  TasksSendParams,
  TasksGetParams,
  TasksCancelParams,
  GraphExploreParams,
  TaskStatusMessage,
} from "./types.js";
import {
  createTask,
  getTask,
  updateTaskStatus,
  setTaskOutput,
  setTaskError,
} from "./task-store.js";
import {
  addConnection,
  removeConnection,
  broadcastTaskProgress,
  broadcastTaskCompleted,
  broadcastTaskFailed,
  closeAllConnections,
} from "./sse.js";

// ─── JSON-RPC helpers ───

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendError(
  res: ServerResponse,
  id: string | number,
  code: number,
  message: string,
): void {
  const response: JsonRpcResponse = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  sendJson(res, 200, response);
}

// ─── Parameter extraction from A2A Message ───

function extractParams(params: TasksSendParams): GraphExploreParams | { error: string } {
  const message = params.message;
  if (!message?.parts || message.parts.length === 0) {
    return { error: "message.parts is required" };
  }

  // Try DataPart first (structured JSON)
  for (const part of message.parts) {
    if (part.type === "data" && part.data) {
      const d = part.data;
      if (typeof d.goal === "string" && Array.isArray(d.seed_entities)) {
        return {
          goal: d.goal,
          seed_entities: d.seed_entities as string[],
          max_depth: typeof d.max_depth === "number" ? d.max_depth : 3,
          time_range: typeof d.time_range === "string" ? d.time_range : undefined,
        };
      }
    }
  }

  // Fallback: parse from TextPart using the prompt template format
  const textParts = message.parts.filter((p) => p.type === "text");
  if (textParts.length > 0) {
    const text = textParts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
    return parsePromptText(text);
  }

  return { error: "Could not extract goal and seed_entities from message parts" };
}

function parsePromptText(text: string): GraphExploreParams | { error: string } {
  const goalMatch = text.match(/探索目标[：:]\s*(.+)/);
  const seedsMatch = text.match(/起始实体[：:]\s*(.+)/);
  const depthMatch = text.match(/最大深度[：:]\s*(\d+)/);

  if (!goalMatch || !seedsMatch) {
    return { error: "Text message must contain 探索目标 and 起始实体 lines" };
  }

  return {
    goal: goalMatch[1].trim(),
    seed_entities: seedsMatch[1].split(/[,，]\s*/).map((s) => s.trim()).filter(Boolean),
    max_depth: depthMatch ? parseInt(depthMatch[1], 10) : 3,
  };
}

function buildStatusMessage(text: string): TaskStatusMessage {
  return { parts: [{ type: "text", text }] };
}

// ─── Handler implementations ───

async function handleTasksSend(
  id: string | number,
  params: TasksSendParams,
): Promise<JsonRpcResponse> {
  const extracted = extractParams(params);
  if ("error" in extracted) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: extracted.error },
    };
  }

  const taskId = randomUUID();
  const abortController = new AbortController();

  const task = createTask(taskId, extracted, abortController);
  updateTaskStatus(taskId, "submitted", buildStatusMessage("任务已提交，正在启动探索..."));

  const explorationInput: ExplorationInput = {
    goal: extracted.goal,
    seed_entities: extracted.seed_entities,
    max_depth: extracted.max_depth,
    time_range: extracted.time_range,
  };

  // Async execution — don't block the response
  runExploration(explorationInput, (event: StepEvent) => {
    // Map each StepEvent to A2A progress
    if (event.type === "step_complete" || event.type === "finalize") {
      const current = getTask(taskId);
      if (current && current.status !== "working") {
        updateTaskStatus(taskId, "working", buildStatusMessage(
          `Step ${event.step}: ${event.decision ?? "exploring"}`,
        ));
      }
      broadcastTaskProgress(taskId, event);
    }
  })
    .then(({ output }) => {
      setTaskOutput(taskId, output);
      updateTaskStatus(
        taskId,
        "completed",
        buildStatusMessage(
          `探索完成: ${output.findings.length} 条发现, ${output.event_threads.length} 条事件脉络`,
        ),
      );
      broadcastTaskCompleted(
        taskId,
        `探索完成: ${output.findings.length} 条发现, ${output.event_threads.length} 条事件脉络`,
      );
    })
    .catch((err) => {
      const msg = `探索失败: ${String(err?.message ?? err)}`;
      setTaskError(taskId, msg);
      updateTaskStatus(taskId, "failed", buildStatusMessage(msg));
      broadcastTaskFailed(taskId, msg);
    })
    .finally(() => {
      // Keep SSE open briefly so clients can receive the final event
      setTimeout(() => closeAllConnections(taskId), 3000);
    });

  return {
    jsonrpc: "2.0",
    id,
    result: {
      taskId,
      status: "submitted",
      createdAt: task.createdAt,
    },
  };
}

async function handleTasksSendSubscribe(
  id: string | number,
  params: TasksSendParams,
  res: ServerResponse,
): Promise<void> {
  // First, create the task (same as tasks/send)
  const extracted = extractParams(params);
  if ("error" in extracted) {
    sendError(res, id, -32602, extracted.error);
    return;
  }

  const taskId = randomUUID();
  const abortController = new AbortController();

  createTask(taskId, extracted, abortController);
  updateTaskStatus(taskId, "submitted", buildStatusMessage("任务已提交"));

  // Open SSE stream
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  // Send initial connected event with taskId
  res.write(
    `event: task\ndata: ${JSON.stringify({ taskId, status: "submitted" })}\n\n`,
  );

  addConnection(taskId, res);

  // Heartbeat
  const heartbeat = setInterval(() => {
    try {
      res.write(": heartbeat\n\n");
    } catch {
      clearInterval(heartbeat);
      removeConnection(taskId, res);
    }
  }, 15000);

  res.on("close", () => {
    clearInterval(heartbeat);
    removeConnection(taskId, res);
  });

  // Run exploration
  const explorationInput: ExplorationInput = {
    goal: extracted.goal,
    seed_entities: extracted.seed_entities,
    max_depth: extracted.max_depth,
    time_range: extracted.time_range,
  };

  try {
    const { output } = await runExploration(explorationInput, (event: StepEvent) => {
      if (event.type === "step_complete" || event.type === "finalize") {
        const current = getTask(taskId);
        if (current && current.status !== "working") {
          updateTaskStatus(taskId, "working", buildStatusMessage(
            `Step ${event.step}: ${event.decision ?? "exploring"}`,
          ));
        }
        broadcastTaskProgress(taskId, event);
      }
    });

    setTaskOutput(taskId, output);
    const summary = `探索完成: ${output.findings.length} 条发现, ${output.event_threads.length} 条事件脉络`;
    updateTaskStatus(taskId, "completed", buildStatusMessage(summary));
    broadcastTaskCompleted(taskId, summary);
  } catch (err) {
    const msg = `探索失败: ${String((err as Error)?.message ?? err)}`;
    setTaskError(taskId, msg);
    updateTaskStatus(taskId, "failed", buildStatusMessage(msg));
    broadcastTaskFailed(taskId, msg);
  } finally {
    clearInterval(heartbeat);
    removeConnection(taskId, res);
    // Brief delay so SSE client can receive final event
    await new Promise((r) => setTimeout(r, 1000));
    try { res.end(); } catch { /* already closed */ }
  }
}

function handleTasksGet(
  id: string | number,
  params: TasksGetParams,
): JsonRpcResponse {
  const task = getTask(params.taskId);
  if (!task) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: `Task not found: ${params.taskId}` },
    };
  }

  const result: Record<string, unknown> = {
    taskId: task.taskId,
    status: task.status,
    createdAt: task.createdAt,
  };

  if (task.statusMessage) {
    result.statusMessage = task.statusMessage;
  }
  if (task.artifacts) {
    result.artifacts = task.artifacts;
  }
  if (task.error) {
    result.error = task.error;
  }

  return { jsonrpc: "2.0", id, result };
}

function handleTasksCancel(
  id: string | number,
  params: TasksCancelParams,
): JsonRpcResponse {
  const task = getTask(params.taskId);
  if (!task) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: `Task not found: ${params.taskId}` },
    };
  }

  if (task.status !== "working" && task.status !== "submitted") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32001, message: `Task cannot be canceled (status: ${task.status})` },
    };
  }

  task.abortController.abort();
  updateTaskStatus(params.taskId, "canceled", {
    parts: [{ type: "text", text: "任务已取消" }],
  });
  closeAllConnections(params.taskId);

  return {
    jsonrpc: "2.0",
    id,
    result: { taskId: params.taskId, status: "canceled" },
  };
}

// ─── Router ───

export async function handleA2ARequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "/";
  if (url !== "/a2a" && url !== "/a2a/") return false;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return true;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed, use POST" });
    return true;
  }

  let body: string;
  try {
    body = await parseBody(req);
  } catch {
    sendJson(res, 400, { error: "Failed to read request body" });
    return true;
  }

  let request: JsonRpcRequest;
  try {
    request = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "Invalid JSON" });
    return true;
  }

  if (request.jsonrpc !== "2.0") {
    sendError(res, request.id ?? 0, -32600, "Invalid Request: jsonrpc must be 2.0");
    return true;
  }

  try {
    switch (request.method) {
      case "tasks/send": {
        const response = await handleTasksSend(request.id, request.params as unknown as TasksSendParams);
        sendJson(res, 200, response);
        return true;
      }
      case "tasks/sendSubscribe": {
        await handleTasksSendSubscribe(request.id, request.params as unknown as TasksSendParams, res);
        return true;
      }
      case "tasks/get": {
        const response = handleTasksGet(request.id, request.params as unknown as TasksGetParams);
        sendJson(res, 200, response);
        return true;
      }
      case "tasks/cancel": {
        const response = handleTasksCancel(request.id, request.params as unknown as TasksCancelParams);
        sendJson(res, 200, response);
        return true;
      }
      default:
        sendError(res, request.id, -32601, `Method not found: ${request.method}`);
        return true;
    }
  } catch (err) {
    sendError(
      res,
      request.id,
      -32603,
      `Internal error: ${String((err as Error)?.message ?? err)}`,
    );
    return true;
  }
}
