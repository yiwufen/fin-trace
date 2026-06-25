// MCP Server — 将 graph_explore 能力暴露为 MCP 工具，供其他 Agent 调用
//
// 使用 Streamable HTTP 传输，与现有 A2A / HTTP API 共享同一 HTTP Server (port 3001)。
// MCP 端点: /mcp (GET=SSE, POST=JSON-RPC, DELETE=关闭会话)
//
// 设计原则:
//   Agent Loop 耗时 3-20 分钟，绝不能阻塞 MCP tool call。
//   拆为 start + poll (+ cancel) 三个秒级工具：start 异步启动任务立刻返回 task_id，
//   status 按需轮询结果。Agent Loop 在后台异步运行。
//
// 工具:
//   graph_explore_start  — 启动探索，立即返回 task_id（<1s）
//   graph_explore_status — 查询任务状态和结果（<1s）
//   graph_explore_cancel — 取消运行中的任务（<1s）

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { runExploration } from "./agent/loop.js";
import type { ExplorationInput, ExplorationOutput, StepEvent } from "./agent/state.js";
import { createLogger } from "./logger.js";

const log = createLogger("mcp-server");

let transport: StreamableHTTPServerTransport | null = null;
let mcpServer: McpServer | null = null;

// ═══════════════════════════════════════════════════════════════
// MCP Task Store — 管理异步探索任务
// ═══════════════════════════════════════════════════════════════

type McpTaskStatus = "running" | "completed" | "failed" | "canceled";

interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  createdAt: string;
  input: ExplorationInput;
  abortController: AbortController;
  progress?: {
    step: number;
    decision?: string;
    total_findings: number;
    total_entities: number;
    total_events: number;
    budget_used: number;
  };
  result?: ExplorationOutput;
  error?: string;
}

const taskStore = new Map<string, McpTask>();

// 最大并发数
const MAX_CONCURRENT_TASKS = 3;
// running 任务最大存活时间：30 分钟（超时自动标记为 failed）
const RUNNING_TASK_TIMEOUT_MS = 30 * 60 * 1000;

function countRunning(): number {
  let n = 0;
  for (const t of taskStore.values()) {
    if (t.status === "running") n++;
  }
  return n;
}

function createTask(input: ExplorationInput): McpTask {
  const task: McpTask = {
    taskId: randomUUID(),
    status: "running",
    createdAt: new Date().toISOString(),
    input,
    abortController: new AbortController(),
  };
  taskStore.set(task.taskId, task);
  return task;
}

function updateProgress(taskId: string, progress: McpTask["progress"]): void {
  const task = taskStore.get(taskId);
  if (!task || task.status !== "running") return;
  task.progress = progress;
}

function completeTask(taskId: string, result: ExplorationOutput): void {
  const task = taskStore.get(taskId);
  if (!task) return;
  // 已取消的任务不覆盖状态
  if (task.status === "canceled") return;
  task.status = "completed";
  task.result = result;
}

function failTask(taskId: string, error: string): void {
  const task = taskStore.get(taskId);
  if (!task) return;
  // 已取消的任务不覆盖状态
  if (task.status === "canceled") return;
  task.status = "failed";
  task.error = error;
}

function cancelTask(taskId: string): boolean {
  const task = taskStore.get(taskId);
  if (!task) return false;
  if (task.status !== "running") return false;
  task.status = "canceled";
  task.abortController.abort();
  return true;
}

// 定期清理：completed/failed/canceled 超过 1 小时删除，running 超过 30 分钟标记为 failed
setInterval(() => {
  const now = Date.now();
  for (const [id, task] of taskStore) {
    const age = now - new Date(task.createdAt).getTime();

    if (
      (task.status === "completed" || task.status === "failed" || task.status === "canceled") &&
      age > 60 * 60 * 1000
    ) {
      taskStore.delete(id);
      continue;
    }

    // running 超时自动失败
    if (task.status === "running" && age > RUNNING_TASK_TIMEOUT_MS) {
      task.abortController.abort();
      task.status = "failed";
      task.error = `任务超时（超过 ${RUNNING_TASK_TIMEOUT_MS / 60000} 分钟未完成）`;
      log.warn({ taskId: id }, "MCP 任务超时，自动标记为 failed");
    }
  }
}, 5 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════
// Zod Schemas
// ═══════════════════════════════════════════════════════════════

const StartInputSchema = z.object({
  goal: z.string().describe(
    "探索目标，描述你想了解什么。例如：'分析宁德时代和比亚迪之间的供应链竞争关系'",
  ),
  seed_entities: z.array(z.string()).describe(
    "起始实体中文名列表，如 ['宁德时代', '比亚迪']",
  ),
  max_depth: z.number().int().min(1).max(5).default(3).describe(
    "最大探索深度，默认 3。depth=1 只查起始实体，depth=2 扩展到关联实体",
  ),
  time_range: z.string().optional().describe(
    "时间范围过滤，格式 'YYYY-MM-DD:YYYY-MM-DD'，如 '2024-01-01:2025-12-31'",
  ),
});

const TaskIdSchema = z.object({
  task_id: z.string().describe(
    "graph_explore_start 返回的任务 ID",
  ),
});

// ═══════════════════════════════════════════════════════════════
// 创建 MCP Server
// ═══════════════════════════════════════════════════════════════

export function getMcpServer(): McpServer {
  if (mcpServer) return mcpServer;

  mcpServer = new McpServer({
    name: "fin-trace",
    version: "1.0.0",
  });

  // ─── 工具 1: graph_explore_start ───

  mcpServer.registerTool(
    "graph_explore_start",
    {
      description:
        "启动金融知识图谱多跳关系推理任务。给定探索目标和起始实体，启动异步探索，" +
        "立即返回 task_id。预计耗时：depth=1 约 3-5 分钟，depth=2 约 5-12 分钟，depth=3 约 10-20 分钟。" +
        "调用后使用 graph_explore_status 按需轮询结果，不再需要时调用 graph_explore_cancel 取消。",
      inputSchema: StartInputSchema,
      annotations: {
        title: "启动知识图谱探索",
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      // 并发限制
      if (countRunning() >= MAX_CONCURRENT_TASKS) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `已达到最大并发任务数 (${MAX_CONCURRENT_TASKS})，请等待已有任务完成或取消后再试`,
              }),
            },
          ],
          isError: true,
        };
      }

      const input: ExplorationInput = {
        goal: args.goal,
        seed_entities: args.seed_entities,
        max_depth: args.max_depth,
        time_range: args.time_range,
      };

      const task = createTask(input);

      log.info(
        { taskId: task.taskId, goal: args.goal.slice(0, 80), seeds: args.seed_entities },
        "MCP 探索任务已创建",
      );

      // 异步执行探索，不阻塞 tool call 返回
      runExploration(input, (event: StepEvent) => {
        if (event.type === "step_complete") {
          updateProgress(task.taskId, {
            step: event.step,
            decision: event.decision,
            total_findings: event.total_findings ?? 0,
            total_entities: event.total_entities ?? 0,
            total_events: event.total_events ?? 0,
            budget_used: event.budget_used ?? 0,
          });
        }
      })
        .then(({ output }) => {
          completeTask(task.taskId, output);
          if (taskStore.get(task.taskId)?.status === "completed") {
            log.info(
              { taskId: task.taskId, findings: output.findings.length, threads: output.event_threads.length },
              "MCP 探索任务完成",
            );
          } else {
            log.info({ taskId: task.taskId }, "MCP 探索任务已完成但已被取消，结果丢弃");
          }
        })
        .catch((err) => {
          const msg = String((err as Error)?.message ?? err);
          failTask(task.taskId, msg);
          if (taskStore.get(task.taskId)?.status === "failed") {
            log.error({ taskId: task.taskId, err }, "MCP 探索任务失败");
          }
        });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              task_id: task.taskId,
              status: "running",
              created_at: task.createdAt,
            }),
          },
        ],
      };
    },
  );

  // ─── 工具 2: graph_explore_status ───

  mcpServer.registerTool(
    "graph_explore_status",
    {
      description:
        "查询 graph_explore_start 启动的探索任务状态。返回 status（running/completed/failed/canceled）、" +
        "进度信息（当前 step、已发现 findings 数、已探索实体数）和完成后的结构化结果。",
      inputSchema: TaskIdSchema,
      annotations: {
        title: "查询探索任务状态",
        readOnlyHint: true,
      },
    },
    async (args) => {
      const task = taskStore.get(args.task_id);

      if (!task) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Task not found: ${args.task_id}`,
                hint: "任务可能已过期（完成/失败/取消超过 1 小时自动清理，运行超过 30 分钟自动失败）或 task_id 有误",
              }),
            },
          ],
          isError: true,
        };
      }

      const response: Record<string, unknown> = {
        task_id: task.taskId,
        status: task.status,
        created_at: task.createdAt,
      };

      if (task.progress) {
        response.progress = task.progress;
      }

      if (task.status === "completed" && task.result) {
        response.result = {
          findings: task.result.findings,
          event_threads: task.result.event_threads,
          exploration_meta: task.result.exploration_meta,
        };
      }

      if (task.status === "failed" && task.error) {
        response.error = task.error;
      }

      if (task.status === "canceled") {
        response.message = "任务已被取消";
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(response, null, 2),
          },
        ],
      };
    },
  );

  // ─── 工具 3: graph_explore_cancel ───

  mcpServer.registerTool(
    "graph_explore_cancel",
    {
      description:
        "取消 graph_explore_start 启动的运行中任务。取消后任务结果不会被保存，" +
        "graph_explore_status 将返回 status=canceled。只能取消 running 状态的任务。",
      inputSchema: TaskIdSchema,
      annotations: {
        title: "取消探索任务",
        readOnlyHint: false,
        destructiveHint: true,
      },
    },
    async (args) => {
      const task = taskStore.get(args.task_id);

      if (!task) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Task not found: ${args.task_id}`,
                hint: "任务可能已过期（完成/失败/取消超过 1 小时自动清理）或 task_id 有误",
              }),
            },
          ],
          isError: true,
        };
      }

      if (task.status !== "running") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `无法取消状态为 "${task.status}" 的任务，只能取消 running 状态的任务`,
                task_id: task.taskId,
                status: task.status,
              }),
            },
          ],
          isError: true,
        };
      }

      const canceled = cancelTask(args.task_id);
      if (!canceled) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: "取消失败，任务状态已变更",
                task_id: task.taskId,
              }),
            },
          ],
          isError: true,
        };
      }

      log.info({ taskId: task.taskId }, "MCP 探索任务已取消");

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              task_id: task.taskId,
              status: "canceled",
              message: "任务已取消",
            }),
          },
        ],
      };
    },
  );

  log.info("MCP Server 已创建，注册工具: graph_explore_start, graph_explore_status, graph_explore_cancel");
  return mcpServer;
}

// ═══════════════════════════════════════════════════════════════
// Transport / Init / HTTP 处理
// ═══════════════════════════════════════════════════════════════

export function getMcpTransport(): StreamableHTTPServerTransport {
  if (!transport) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });
  }
  return transport;
}

let initialized = false;

export async function initMcpServer(): Promise<void> {
  if (initialized) return;

  const server = getMcpServer();
  const t = getMcpTransport();

  await server.connect(t);
  initialized = true;
  log.info("MCP Server 已连接到 Transport");
}

export async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = req.url ?? "/";
  if (url !== "/mcp" && !url.startsWith("/mcp?")) return false;

  const t = getMcpTransport();

  let parsedBody: unknown;
  if (req.method === "POST") {
    parsedBody = await parseRequestBody(req);
  }

  await t.handleRequest(req, res, parsedBody);
  return true;
}

function parseRequestBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const bodyReq = req as unknown as Record<string, unknown>;
    if (bodyReq.body) {
      resolve(bodyReq.body);
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw.trim()) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on("error", reject);
  });
}

export async function closeMcpServer(): Promise<void> {
  if (transport) {
    await transport.close();
    transport = null;
  }
  mcpServer = null;
  initialized = false;
}
