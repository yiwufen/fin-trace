// dsh (DeepSeek Harness) 插件 — 将 fin-trace 的金融知识图谱多跳推理循环嵌入 dsh 宿主
//
// 形态: cordis 函数插件（named exports: name / inject / Config / apply，无 default export）
// 工具: fintrace_explore_start / fintrace_explore_status / fintrace_explore_cancel（异步任务三件套，
//       镜像 src/mcp-server.ts 的 graph_explore_* 模式，但 cancel 真接线 AbortSignal）
// 依赖注入: 经 ExplorationDeps 注入 LLM/KG MCP 客户端与模型配置，
//          完全不读宿主 cwd 的 config.json / data/settings.json
// 对应设计: design-docs/agent-loop.md「依赖注入（deps，嵌入式宿主）」

import { randomUUID } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

import {
  runExploration,
  type ExplorationDeps,
} from "../../../src/agent/loop.js";
import {
  serializeState,
  type ExplorationInput,
  type ExplorationOutput,
  type SerializedState,
  type StepEvent,
} from "../../../src/agent/state.js";
import { createLlmClient } from "../../../src/llm/client.js";
import { KgMcpClient } from "../../../src/agent/mcp-client.js";
import type { LlmConfig } from "../../../src/agent/config.js";

export const name = "dsh-fin-trace";
export const inject = ["tools"];

// ─── 常量 ───

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const RECENT_STEPS_CAP = 20;
const RECENT_STEPS_RETURN = 5;

// ─── Config（Schemastery；apply 内另有防御性默认值，宿主不解析 schema 也能跑）───

export const Config = Schema.object({
  llm: Schema.object({
    provider: Schema.union(["openai", "anthropic"]).default("openai"),
    base_url: Schema.string().default("https://api.deepseek.com"),
    model: Schema.string().default("deepseek-v4-pro"),
    max_tokens: Schema.number().default(128000),
    api_key: Schema.string().role("secret").default(""),
  }),
  kg: Schema.object({
    url: Schema.string().default("https://kg.yiyiyiwufeng.cn/mcp"),
    transport: Schema.string().default("streamable-http"),
    api_key: Schema.string().role("secret").default(""),
  }),
  maxConcurrentTasks: Schema.number().default(2),
  taskTtlMinutes: Schema.number().default(60),
  runningTimeoutMinutes: Schema.number().default(30),
});

/** apply 实际使用的规范化配置（所有字段有默认值） */
interface PluginConfig {
  llm: { provider: "openai" | "anthropic"; base_url: string; model: string; max_tokens: number; api_key: string };
  kg: { url: string; transport: string; api_key: string };
  maxConcurrentTasks: number;
  taskTtlMinutes: number;
  runningTimeoutMinutes: number;
}

function normalizeConfig(raw: Record<string, any> | undefined): PluginConfig {
  const llm = raw?.llm ?? {};
  const kg = raw?.kg ?? {};
  const num = (v: unknown, d: number) => (typeof v === "number" && v > 0 ? v : d);
  return {
    llm: {
      provider: llm.provider === "anthropic" ? "anthropic" : "openai",
      base_url: typeof llm.base_url === "string" && llm.base_url ? llm.base_url : "https://api.deepseek.com",
      model: typeof llm.model === "string" && llm.model ? llm.model : "deepseek-v4-pro",
      max_tokens: num(llm.max_tokens, 128000),
      api_key: typeof llm.api_key === "string" ? llm.api_key : "",
    },
    kg: {
      url: typeof kg.url === "string" && kg.url ? kg.url : "https://kg.yiyiyiwufeng.cn/mcp",
      transport: kg.transport === "sse" ? "sse" : "streamable-http",
      api_key: typeof kg.api_key === "string" ? kg.api_key : "",
    },
    maxConcurrentTasks: num(raw?.maxConcurrentTasks, 2),
    taskTtlMinutes: num(raw?.taskTtlMinutes, 60),
    runningTimeoutMinutes: num(raw?.runningTimeoutMinutes, 30),
  };
}

// ─── apiKey 解析（不走 src/agent/config.ts 的 getApiKey，避免其读宿主 cwd 文件）───

function resolveApiKey(llm: PluginConfig["llm"]): string {
  if (llm.api_key) return llm.api_key;
  const envKey =
    llm.provider === "anthropic"
      ? process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN
      : process.env.OPENAI_API_KEY ?? process.env.DEEPSEEK_API_KEY;
  if (envKey) return envKey;
  // 本地代理场景：base_url 非官方端点时允许不设 key
  if (llm.base_url && !llm.base_url.includes("anthropic.com") && !llm.base_url.includes("api.openai.com")) {
    return "unused";
  }
  throw new Error(
    "[dsh-fin-trace] 缺少 LLM api_key：请在插件配置设置 llm.api_key，或设置环境变量 OPENAI_API_KEY / DEEPSEEK_API_KEY",
  );
}

// ─── 任务存储 ───

type TaskStatus = "running" | "completed" | "failed" | "canceled";

interface TaskProgress {
  step: number;
  decision?: string;
  total_findings: number;
  total_entities: number;
  total_events: number;
  budget_used: number;
}

interface CompactStep {
  type: string;
  step: number;
  phase: string;
  decision?: string;
  detail?: string;
  total_findings?: number;
  total_entities?: number;
  total_events?: number;
  budget_used?: number;
  error?: string;
}

interface FintraceTask {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  abortController: AbortController;
  progress?: TaskProgress;
  recentSteps: CompactStep[];
  result?: ExplorationOutput;
  // 为将来 followup 续探留门（对应 src/api.ts 的 deserializeState 恢复路径）
  serializedState?: SerializedState;
  error?: string;
}

function compactStep(e: StepEvent): CompactStep {
  const step: CompactStep = { type: e.type, step: e.step, phase: e.phase };
  if (e.decision !== undefined) step.decision = e.decision;
  if (e.detail !== undefined) step.detail = e.detail;
  if (e.error !== undefined) step.error = e.error;
  if (e.total_findings !== undefined) step.total_findings = e.total_findings;
  if (e.total_entities !== undefined) step.total_entities = e.total_entities;
  if (e.total_events !== undefined) step.total_events = e.total_events;
  if (e.budget_used !== undefined) step.budget_used = e.budget_used;
  return step;
}

function sweepTasks(store: Map<string, FintraceTask>, config: PluginConfig): void {
  const now = Date.now();
  for (const [id, task] of store) {
    const age = now - Date.parse(task.createdAt);
    if (task.status === "running" && age > config.runningTimeoutMinutes * 60_000) {
      task.abortController.abort();
      task.status = "failed";
      task.error = `任务超时（超过 ${config.runningTimeoutMinutes} 分钟未完成）`;
    } else if (task.status !== "running" && age > config.taskTtlMinutes * 60_000) {
      store.delete(id);
    }
  }
}

// ─── 插件入口 ───

export function apply(ctx: Context, rawConfig?: Record<string, any>) {
  const config = normalizeConfig(rawConfig);
  const taskStore = new Map<string, FintraceTask>();

  const sweeper = setInterval(() => sweepTasks(taskStore, config), SWEEP_INTERVAL_MS);
  sweeper.unref?.();

  // HMR / 卸载清理：中止运行中任务 + 清空 store（interval 一并清理）
  ctx.effect(() => () => {
    clearInterval(sweeper);
    for (const task of taskStore.values()) {
      if (task.status === "running") task.abortController.abort();
    }
    taskStore.clear();
  });

  const jsonText = (value: unknown) => [{ type: "text" as const, text: JSON.stringify(value, null, 2) }];

  ctx.tools.register(
    defineTool({
      name: "fintrace_explore_start",
      description:
        "启动金融知识图谱多跳关系推理任务。给定探索目标和起始实体，启动异步探索，立即返回 task_id。" +
        "预计耗时：depth=1 约 3-5 分钟，depth=2 约 5-12 分钟，depth=3 约 10-20 分钟。" +
        "调用后使用 fintrace_explore_status 按需轮询结果，不再需要时调用 fintrace_explore_cancel 取消。",
      parameters: {
        goal: {
          type: "string",
          required: true,
          description: "探索目标，描述你想了解什么。例如：'分析宁德时代和比亚迪之间的供应链竞争关系'",
        },
        seed_entities: {
          type: "array",
          items: { type: "string" },
          required: true,
          description: "起始实体中文名列表，如 ['宁德时代', '比亚迪']",
        },
        max_depth: {
          type: "integer",
          enum: [1, 2, 3, 4, 5],
          default: 3,
          description: "最大探索深度，默认 3。depth=1 只查起始实体，depth=2 扩展到关联实体",
        },
        time_range: {
          type: "string",
          description: "时间范围过滤，格式 'YYYY-MM-DD:YYYY-MM-DD'，如 '2024-01-01:2025-12-31'",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            task_id: { type: "string", required: true },
            status: { type: "string", required: true },
            created_at: { type: "string", required: true },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: "text", text: `探索任务已提交：task_id=${value.task_id}` }],
      },
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args) {
        const running = [...taskStore.values()].filter((t) => t.status === "running").length;
        if (running >= config.maxConcurrentTasks) {
          throw new Error(
            `并发任务已达上限（${config.maxConcurrentTasks}）：请先用 fintrace_explore_status 轮询已有任务完成，` +
              "或用 fintrace_explore_cancel 取消后再提交",
          );
        }

        const apiKey = resolveApiKey(config.llm);
        const llmConfig: LlmConfig = {
          provider: config.llm.provider,
          base_url: config.llm.base_url,
          model: config.llm.model,
          max_tokens: config.llm.max_tokens,
          api_key: apiKey === "unused" ? undefined : apiKey,
        };

        // default 仅为 schema 注解（非强制），执行侧兜底
        const input: ExplorationInput = {
          goal: args.goal,
          seed_entities: args.seed_entities,
          max_depth: args.max_depth ?? 3,
          time_range: args.time_range,
        };

        const task: FintraceTask = {
          taskId: randomUUID(),
          status: "running",
          createdAt: new Date().toISOString(),
          abortController: new AbortController(),
          recentSteps: [],
        };
        taskStore.set(task.taskId, task);

        const deps: ExplorationDeps = {
          llm: createLlmClient({ llm: llmConfig, apiKey }),
          mcpClient: new KgMcpClient({
            url: config.kg.url,
            transport: config.kg.transport,
            api_key: config.kg.api_key || undefined,
          }),
          llmConfig: { model: config.llm.model, max_tokens: config.llm.max_tokens },
        };

        runExploration(
          input,
          (event) => {
            if (event.type === "step_complete") {
              task.progress = {
                step: event.step,
                decision: event.decision,
                total_findings: event.total_findings ?? 0,
                total_entities: event.total_entities ?? 0,
                total_events: event.total_events ?? 0,
                budget_used: event.budget_used ?? 0,
              };
            }
            task.recentSteps.push(compactStep(event));
            if (task.recentSteps.length > RECENT_STEPS_CAP) task.recentSteps.shift();
          },
          undefined,
          task.abortController.signal,
          deps,
        )
          .then(({ output, state }) => {
            // 优雅取消也会产出（保留已有 findings 的）结果，照存；状态不覆盖 canceled
            task.result = output;
            task.serializedState = serializeState(state);
            if (task.status === "running") task.status = "completed";
          })
          .catch((err) => {
            if (task.status === "running") {
              task.status = "failed";
              task.error = String((err as Error)?.message ?? err);
            }
          });

        return { task_id: task.taskId, status: "running", created_at: task.createdAt };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "fintrace_explore_status",
      description:
        "查询 fintrace_explore_start 启动的探索任务状态。返回 status（running/completed/failed/canceled）、" +
        "进度信息（当前 step、决策、已发现 findings 数、已探索实体数）、最近步骤，" +
        "以及完成后的结构化结果（findings / event_threads / exploration_meta，含 tokens_used）。",
      parameters: {
        task_id: {
          type: "string",
          required: true,
          description: "fintrace_explore_start 返回的任务 ID",
        },
      },
      output: {
        schema: { type: "json" },
        render: (_args, value) => jsonText(value),
      },
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args) {
        const task = taskStore.get(args.task_id);
        if (!task) {
          throw new Error(`未知 task_id: ${args.task_id}（任务可能已被 TTL 清理）`);
        }
        const resp: {
          task_id: string;
          status: string;
          created_at: string;
          recent_steps: CompactStep[];
          progress?: TaskProgress;
          result?: ExplorationOutput;
          error?: string;
          message?: string;
        } = {
          task_id: task.taskId,
          status: task.status,
          created_at: task.createdAt,
          recent_steps: task.recentSteps.slice(-RECENT_STEPS_RETURN),
        };
        if (task.progress) resp.progress = task.progress;
        if (task.result) resp.result = task.result;
        if (task.status === "failed") resp.error = task.error;
        if (task.status === "canceled") {
          resp.message = "任务已被取消；若取消前循环已优雅收尾，result 中含已产出的 findings";
        }
        // interface 无隐式 index signature，JSON round-trip 同时保证 schema 要求的 lossless JSON
        return JSON.parse(JSON.stringify(resp));
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "fintrace_explore_cancel",
      description:
        "取消 fintrace_explore_start 启动的运行中任务。探索循环将优雅收尾（保留已产出的 findings，" +
        "completion_reason=cancelled），结果仍可通过 fintrace_explore_status 读取。只能取消 running 状态的任务。",
      parameters: {
        task_id: {
          type: "string",
          required: true,
          description: "fintrace_explore_start 返回的任务 ID",
        },
      },
      output: {
        schema: {
          type: "object",
          properties: {
            task_id: { type: "string", required: true },
            status: { type: "string", required: true },
            message: { type: "string" },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: "text", text: value.message ?? `任务状态：${value.status}` }],
      },
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args) {
        const task = taskStore.get(args.task_id);
        if (!task) {
          throw new Error(`未知 task_id: ${args.task_id}（任务可能已被 TTL 清理）`);
        }
        if (task.status !== "running") {
          return { task_id: task.taskId, status: task.status, message: `任务当前状态为 ${task.status}，无需取消` };
        }
        task.abortController.abort();
        task.status = "canceled";
        return {
          task_id: task.taskId,
          status: "canceled",
          message: "已发送取消信号，探索循环将优雅收尾（保留已产出的 findings）",
        };
      },
    }),
  );
}
