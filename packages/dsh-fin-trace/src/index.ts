// dsh (DeepSeek Harness) 插件 — 将 fin-trace 的金融知识图谱多跳推理循环嵌入 dsh 宿主
//
// 形态: cordis 函数插件（named exports: name / inject / Config / apply，无 default export）
// 工具: fintrace_explore_start / fintrace_explore_status / fintrace_explore_cancel（异步任务三件套，
//       镜像 src/mcp-server.ts 的 graph_explore_* 模式，但 cancel 真接线 AbortSignal）
// 后台任务: 每次探索同时注册为 ctx.jobs job（kind=fintrace）— 宿主 UI（会话头部徽标/弹层）
//       与完成通知（注入/唤醒 agent）零成本获得；job 的 done/output 均从 taskStore 投影
// UI 卡片: 三工具经 presentCall/presentResult/presentationMeta 声明渲染意图，
//       presentResult 只读 result.meta（纯函数，live 与会话回放共用）
// 依赖注入: 经 ExplorationDeps 注入 LLM/KG MCP 客户端与模型配置，
//          完全不读宿主 cwd 的 config.json / data/settings.json
// 对应设计: design-docs/agent-loop.md「依赖注入（deps，嵌入式宿主）」

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import Schema from "schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { GenericResultView, JsonValue, ToolResult } from "@deepseek-ai/dsh-tools";
import type { JobOutcome } from "@deepseek-ai/dsh-jobs";

declare module "@deepseek-ai/dsh-jobs" {
  interface JobKindMap {
    fintrace: "fintrace";
  }
}

// webServer 为 web profile 才有的可选服务（dsh-host-webserver 未发布类型，按用到的方法本地最小声明）
interface WebServerRoute {
  kind: "exact" | "prefix";
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    webServer?: { register(route: WebServerRoute): () => void };
  }
}

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

// name 必须等于包名（loader 以 patch 行的 name 作为 import 说明符解析模块）
export const name = "@lihangcz/dsh-fin-trace";
// jobs: 宿主后台任务注册表（dsh-base 全 profile 装载）；producer 见 fintrace_explore_start
export const inject = ["tools", "jobs"];

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
  budget_limit: number;
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
  // settlement: 循环收敛信号（绝不 reject，错误吞进 task.status/error）— job done 的数据源
  settlement?: Promise<void>;
  // 宿主后台任务 id（ctx.jobs 注册产物；注册失败时缺省，行为退化同旧版）
  jobId?: string;
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

// ─── Job 产出投影（ctx.jobs 的终态映射；done 不得 reject，异常兜底为 failed）───

/** job_output 的最终输出：与 fintrace_explore_status 响应中的 result 同构（完整 JSON，受 outputLimitBytes 截断） */
function jobOutputJson(result: ExplorationOutput): string {
  return JSON.stringify(result);
}

function jobOutcomeOf(task: FintraceTask): JobOutcome {
  if (task.status === "failed") {
    return { status: "failed", detail: task.error ?? "unknown error" };
  }
  if (task.status === "canceled") {
    // 优雅取消已产出部分 findings；output 携带它们供 job_output 一次性读取
    return {
      status: "killed",
      detail: "已取消；已产出的 findings 保留，可用 fintrace_explore_status 读取",
      ...(task.result ? { output: jobOutputJson(task.result) } : {}),
    };
  }
  const stats = task.result?.exploration_meta?.stats;
  return {
    status: "completed",
    detail: `${stats?.findings_count ?? task.result?.findings.length ?? 0} findings · ${stats?.entities_visited ?? 0} 实体 · ${stats?.tokens_used ?? 0} tokens`,
    ...(task.result ? { output: jobOutputJson(task.result) } : {}),
  };
}

// ─── Web 轮询端点（/fintrace/task）：客户端实时面板的数据源 ───
// 经 ctx.inject(['webServer']) 可选注入，仅 web profile 注册；headless 无此服务自动跳过。
// 与 /plugins 静态下发同级（webServer 无 harness 鉴权概念），README 安全披露节注明。

/** 终态摘要（与 status 卡片投影同构，供面板定格渲染） */
function resultSummary(r: ExplorationOutput) {
  const s = r.exploration_meta?.stats;
  return {
    counts: {
      findings: s?.findings_count ?? r.findings.length,
      entities: s?.entities_visited ?? 0,
      events: s?.events_buffered ?? 0,
      threads: r.event_threads?.length ?? 0,
      tokens: s?.tokens_used ?? 0,
    },
    completion_reason: r.exploration_meta?.completion_reason,
    reliability_note: r.exploration_meta?.reliability_note,
    top_findings: (r.findings ?? [])
      .slice(0, 5)
      .map((f) => ({ category: f.category, statement: f.statement, confidence: f.confidence })),
    threads: (r.event_threads ?? []).slice(0, 5).map((t) => ({ title: t.title, confidence: t.confidence })),
  };
}

function taskSnapshot(task: FintraceTask) {
  return {
    task_id: task.taskId,
    status: task.status,
    created_at: task.createdAt,
    elapsed_ms: Date.now() - Date.parse(task.createdAt),
    ...(task.progress ? { progress: task.progress } : {}),
    recent_steps: task.recentSteps.slice(-10),
    ...(task.result ? { summary: resultSummary(task.result) } : {}),
    ...(task.error ? { error: task.error } : {}),
  };
}

function handleTaskPoll(req: IncomingMessage, res: ServerResponse, store: Map<string, FintraceTask>): void {
  const send = (code: number, body: unknown) => {
    res.statusCode = code;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method !== "GET") return send(405, { error: "method not allowed" });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/fintrace/task") return send(404, { error: "not found" });
    const id = url.searchParams.get("id");
    let task: FintraceTask | undefined;
    if (id) {
      task = store.get(id);
    } else if (url.searchParams.get("latest") === "1") {
      const ordered = [...store.values()].sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );
      task = ordered.find((t) => t.status === "running") ?? ordered[0];
    }
    if (!task) return send(404, { error: id ? `未知 task_id: ${id}（可能已被 TTL 清理）` : "当前无任务" });
    send(200, taskSnapshot(task));
  } catch (err) {
    send(500, { error: String((err as Error)?.message ?? err) });
  }
}

// ─── 工具卡片呈现（纯函数区：只依赖 args / result.meta，不触碰 taskStore 等运行时闭包，live 与会话回放共用）───

const textBlocks = (text: string) => [{ type: "text" as const, text }];

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** status 调用的回放投影：从 canonical value 压出 presentResult 所需的最小集合 */
interface StatusCardMeta {
  status?: string;
  progress?: { step: number; decision?: string; findings: number; entities: number; events: number };
  counts?: { findings: number; entities: number; threads: number; tokens: number };
  completion_reason?: string;
  recent_steps?: { step: number; type: string; decision?: string; detail?: string }[];
  top_findings?: { category: string; statement: string; confidence: string }[];
  error?: string;
}

function statusPresentation(value: unknown): JsonValue {
  const v = value as {
    status?: string;
    progress?: TaskProgress;
    recent_steps?: CompactStep[];
    result?: ExplorationOutput;
    error?: string;
  };
  const meta: StatusCardMeta = { status: v.status };
  if (v.progress) {
    meta.progress = {
      step: v.progress.step,
      decision: v.progress.decision,
      findings: v.progress.total_findings,
      entities: v.progress.total_entities,
      events: v.progress.total_events,
    };
  }
  const res = v.result;
  if (res) {
    const s = res.exploration_meta?.stats;
    meta.counts = {
      findings: s?.findings_count ?? res.findings.length,
      entities: s?.entities_visited ?? 0,
      threads: res.event_threads?.length ?? 0,
      tokens: s?.tokens_used ?? 0,
    };
    meta.completion_reason = res.exploration_meta?.completion_reason;
    meta.top_findings = (res.findings ?? [])
      .slice(0, 5)
      .map((f) => ({ category: f.category, statement: f.statement, confidence: f.confidence }));
  }
  if (Array.isArray(v.recent_steps)) {
    meta.recent_steps = v.recent_steps
      .slice(-5)
      .map((st) => ({ step: st.step, type: st.type, decision: st.decision, detail: st.detail }));
  }
  if (v.error) meta.error = v.error;
  // JSON round-trip 保证 lossless JSON（JsonValue 契约）
  return JSON.parse(JSON.stringify(meta));
}

/** status 卡片：按回放投影渲染进行中/完成/失败/取消四态 */
function statusResultView(result: ToolResult): GenericResultView | undefined {
  if (result.isError) return { card: "generic", title: "探索进度查询失败" };
  const m = result.meta as StatusCardMeta | undefined;
  if (!m) return undefined; // 旧会话无投影：落通用兜底卡
  const lines: string[] = [];
  if (m.status === "running") {
    const p = m.progress;
    if (p?.decision) lines.push(`最新决策：${p.decision}`);
    const steps = m.recent_steps ?? [];
    if (steps.length) {
      lines.push("最近步骤：");
      for (const st of steps) lines.push(`  [step ${st.step}] ${st.decision ?? st.detail ?? st.type}`);
    }
    return {
      card: "generic",
      title: p ? `探索进行中 · step ${p.step} · ${p.entities} 实体 · ${p.findings} findings` : "探索进行中",
      ...(lines.length ? { content: textBlocks(lines.join("\n")) } : {}),
    };
  }
  if (m.status === "completed") {
    const c = m.counts;
    const findings = m.top_findings ?? [];
    if (findings.length) {
      lines.push("主要发现：");
      for (const f of findings) lines.push(`  [${f.category}/${f.confidence}] ${truncate(f.statement, 80)}`);
    }
    if (m.completion_reason) lines.push(`完成原因：${m.completion_reason}`);
    return {
      card: "generic",
      title: c ? `探索完成 · ${c.findings} findings · ${c.threads} threads · ${c.tokens} tokens` : "探索完成",
      ...(lines.length ? { content: textBlocks(lines.join("\n")) } : {}),
    };
  }
  if (m.status === "failed") {
    return { card: "generic", title: "探索失败", content: textBlocks(m.error ?? "") };
  }
  if (m.status === "canceled") {
    return {
      card: "generic",
      title: "任务已取消",
      content: textBlocks("若取消前循环已优雅收尾，result 中含已产出的 findings"),
    };
  }
  return { card: "generic", title: `任务状态：${m.status ?? "unknown"}` };
}

/** start 完成卡：按 depth 给预计耗时提示 */
const depthHint = (depth: number | undefined): string => {
  if (depth === 1) return "预计 3-5 分钟";
  if (depth === 2) return "预计 5-12 分钟";
  if (depth === 3) return "预计 10-20 分钟";
  return "可能需要较长时间";
};

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

  // web profile 的实时面板数据源（可选注入；headless 无 webServer 时本回调不激活）
  // 前缀路由不带尾斜杠（匹配规则 pathname.startsWith(prefix + "/")）
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.webServer!.register({
      kind: "prefix",
      path: "/fintrace",
      handler: (req, res) => handleTaskPoll(req, res, taskStore),
    });
  });

  ctx.tools.register(
    defineTool({
      name: "fintrace_explore_start",
      description:
        "启动金融知识图谱多跳关系推理任务。给定探索目标和起始实体，启动异步探索，立即返回 task_id。" +
        "预计耗时：depth=1 约 3-5 分钟，depth=2 约 5-12 分钟，depth=3 约 10-20 分钟。" +
        "重要：任务在后台运行，完成时会自动收到通知并唤醒你继续（宿主后台 job 机制）。" +
        "提交后不要轮询等待——没有其他工作就告知用户任务已启动并结束回合；" +
        "收到完成通知后用 fintrace_explore_status(task_id) 或宿主 job_output 一次性读取结果。" +
        "仅在用户明确要求查看中途进度时才调用 fintrace_explore_status，不再需要任务时调用 fintrace_explore_cancel 取消。",
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
            job_id: { type: "string" },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          {
            type: "text",
            text:
              `探索任务已提交：task_id=${value.task_id}` +
              (value.job_id ? `（后台 job：${value.job_id}）` : "") +
              "\n任务在后台运行（数分钟到二十分钟），完成时会自动通知你——请勿轮询 fintrace_explore_status 等待完成；" +
              "没有其他工作就直接向用户汇报已启动并结束回合。",
          },
        ],
        presentationMeta: (_args, value) => ({ task_id: value.task_id, job_id: value.job_id ?? null }),
      },
      presentCall: (args) => ({
        card: "generic",
        title: `提交探索：${truncate(args.goal, 40)}`,
        kind: "execute",
        rawInput: {
          seed_entities: args.seed_entities,
          max_depth: args.max_depth ?? 3,
          ...(args.time_range ? { time_range: args.time_range } : {}),
        },
      }),
      presentResult: (args, result) => {
        if (result.isError) return { card: "generic", title: "探索任务提交失败" };
        const m = result.meta as { task_id?: string; job_id?: string | null } | undefined;
        const lines = [
          `task_id: ${m?.task_id ?? "—"}`,
          ...(m?.job_id ? [`后台 job: ${m.job_id}（完成时自动通知）`] : []),
          `${depthHint(args.max_depth ?? 3)}，期间可继续其他工作`,
        ];
        return { card: "generic", title: "探索任务已提交（后台运行中）", content: textBlocks(lines.join("\n")) };
      },
      isConcurrencySafe: () => true,
      timeoutMs: 30_000,
      async execute(args, exec) {
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

        // settlement：循环收敛信号，绝不 reject（错误吞进 task.status/error）。
        // signal.aborted 检查统一两个取消通道（本插件 cancel 工具与宿主 job_kill）的终态语义。
        const settlement = runExploration(
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
                budget_limit: event.budget_limit ?? 0,
              };
            }
            task.recentSteps.push(compactStep(event));
            if (task.recentSteps.length > RECENT_STEPS_CAP) task.recentSteps.shift();
          },
          undefined,
          task.abortController.signal,
          deps,
        ).then(
          ({ output, state }) => {
            task.result = output;
            task.serializedState = serializeState(state);
            if (task.status === "running") {
              task.status = task.abortController.signal.aborted ? "canceled" : "completed";
            }
          },
          (err: unknown) => {
            if (task.status === "running") {
              task.status = "failed";
              task.error = String((err as Error)?.message ?? err);
            }
          },
        );
        task.settlement = settlement;

        // 注册为宿主后台 job：会话头部徽标/弹层 + 完成通知 + job_output/job_kill 通道。
        // 注册失败（如宿主未挂 controller）时降级为纯 taskStore 模式，行为同旧版。
        try {
          task.jobId = ctx.jobs.start({
            kind: "fintrace",
            label: truncate(args.goal, 60),
            ...(exec.agent ? { owner: exec.agent } : {}),
            outputLimitBytes: 64 * 1024,
            run() {
              return {
                cancel: () => task.abortController.abort(),
                done: settlement
                  .then(() => jobOutcomeOf(task))
                  .catch((err: unknown): JobOutcome => ({
                    status: "failed",
                    detail: `job outcome 投影异常：${String((err as Error)?.message ?? err)}`,
                  })),
              };
            },
          });
        } catch {
          // ctx.jobs 不可用：任务照常运行，仅无 job UI/通知
        }

        return {
          task_id: task.taskId,
          status: "running",
          created_at: task.createdAt,
          ...(task.jobId ? { job_id: task.jobId } : {}),
        };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "fintrace_explore_status",
      description:
        "单次查询 fintrace_explore_start 启动的探索任务状态。返回 status（running/completed/failed/canceled）、" +
        "进度信息（当前 step、决策、已发现 findings 数、已探索实体数）、最近步骤，" +
        "以及完成后的结构化结果（findings / event_threads / exploration_meta，含 tokens_used）。" +
        "重要：本工具是按需的单次查询（用户要看中途进度、或完成通知后取结果时调用一次），" +
        "不要用它循环轮询等待任务完成——任务完成会自动通知你，轮询只会浪费回合。",
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
        presentationMeta: (_args, value) => statusPresentation(value),
      },
      presentCall: (args) => ({
        card: "generic",
        title: "查询探索进度",
        kind: "read",
        rawInput: { task_id: args.task_id },
      }),
      presentResult: (_args, result) => statusResultView(result),
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
        if (task.status === "running") {
          resp.message =
            "任务仍在后台运行，完成时会自动通知你；请勿继续轮询本工具——可先做其他工作，没有就结束回合。";
        }
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
        render: (_args, value) => [{ type: "text" as const, text: value.message ?? `任务状态：${value.status}` }],
        presentationMeta: (_args, value) => ({ status: value.status, message: value.message ?? null }),
      },
      presentCall: (args) => ({
        card: "generic",
        title: "取消探索任务",
        kind: "delete",
        rawInput: { task_id: args.task_id },
      }),
      presentResult: (_args, result) => {
        if (result.isError) return { card: "generic", title: "取消请求失败" };
        const m = result.meta as { status?: string; message?: string | null } | undefined;
        if (m?.status === "canceled") {
          return {
            card: "generic",
            title: "已发送取消信号",
            content: textBlocks("探索循环将优雅收尾（保留已产出的 findings），结果仍可用 fintrace_explore_status 读取"),
          };
        }
        return { card: "generic", title: `任务状态：${m?.status ?? "—"}`, ...(m?.message ? { content: textBlocks(String(m.message)) } : {}) };
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
