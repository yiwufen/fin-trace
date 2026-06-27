// Agent Loop — Think-Act-Observe 主循环 — v3: 五意图重构
//
// 核心变化:
// - 删除 event_buffer 温层，改为 raw_event_archive（仅 FINALIZE 注入）
// - 删除分段压缩（HistoryStep / compressHistory）
// - Finding 路由到 entity_flags / cluster_flags / key_insights 三层
// - Frontier 准入控制（去优先级排序，cap 10，检查 visited + entity_flags）
// - 上下文 > 85% → 压缩 exploration_log → 还超 → 触发 FINALIZE

import { randomUUID } from "node:crypto";
import type {
  ExplorationInput,
  ExplorationOutput,
  ExplorationState,
  EntitySummary,
  Finding,
  FrontierEntity,
  LogEntry,
  ToolResult,
  RawEvent,
  EntityFlag,
  ClusterFlag,
  StepEvent,
  EventDataType,
  TemporalContext,
} from "./state.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  assembleContext,
  formatToolResultsForLLM,
  estimateTokens,
  getBudgetStatus,
  compressExplorationLog,
} from "./context.js";
import { processNewFindings, type RawFinding } from "./findings.js";
import { KgMcpClient } from "./mcp-client.js";
import {
  type ToolInput,
  mapToMcpCall,
  isMcpTool,
} from "./tools.js";
import type { McpToolName } from "./state.js";
import {
  fixLLMOutput,
  validateToolCalls,
  validateDecision,
  extractStopSignal,
  detectDecisionLoop,
  applyLoopBreak,
  generateReliabilityNote,
  determineCompletionReason,
  type ToolCallCandidate,
} from "./error-handler.js";
import { validateThreads } from "./threads.js";
import { readConfig, getApiKey } from "./config.js";
import { createLlmClient } from "../llm/client.js";
import type { MessageParam } from "../llm/types.js";
import { categorize } from "../tool-categories.js";
import { createLogger } from "../logger.js";

const log = createLogger("agent-loop");

// ─── 常量 ───

const MAX_EXPLORING_STEPS = 20;
const MAX_FINALIZE_STEPS = 2;
const MAX_FRONTIER_SIZE = 10;

// ─── 每工具 token 估算 ───

const TOOL_TOKEN_ESTIMATE: Record<string, number> = {
  lookup: 3000,
  trace: 2000,
  timeline: 2500,
  expand: 2000,
  scan: 1000,
};

// ─── 时间上下文计算 ───

const SHANGHAI_HOLIDAYS_2026 = new Set([
  "2026-01-01", "2026-01-02", // 元旦
  "2026-01-28", "2026-01-29", "2026-01-30", "2026-01-31", "2026-02-01", "2026-02-02", "2026-02-03", // 春节
  "2026-04-06", // 清明
  "2026-05-01", "2026-05-04", "2026-05-05", // 劳动节
  "2026-06-01", // 儿童节（休市？）— 保守起见不加入，实际不休
  "2026-06-19", // 端午
  "2026-09-25", // 中秋
  "2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", // 国庆
]);

function computeTemporalContext(): TemporalContext {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";

  const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
  const timeStr = `${get("hour")}:${get("minute")}`;
  const weekday = get("weekday"); // "周三"
  const current_time = `${dateStr} ${timeStr} CST`;

  const dayOfWeek = now.getDay(); // 0=Sun, 6=Sat (in local timezone)
  const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
  const isHoliday = SHANGHAI_HOLIDAYS_2026.has(dateStr);
  const is_trading_day = !isWeekend && !isHoliday;

  let market_session: TemporalContext["market_session"] = "holiday";
  if (is_trading_day) {
    const hour = parseInt(get("hour"), 10);
    const minute = parseInt(get("minute"), 10);
    const minutesSinceMidnight = hour * 60 + minute;
    if (minutesSinceMidnight < 9 * 60 + 15) {
      market_session = "pre_market";
    } else if (minutesSinceMidnight < 11 * 60 + 30) {
      market_session = "open";
    } else if (minutesSinceMidnight < 13 * 60) {
      market_session = "closed"; // 午休
    } else if (minutesSinceMidnight < 15 * 60) {
      market_session = "open";
    } else {
      market_session = "closed";
    }
  }

  return { current_time, is_trading_day, market_session, weekday };
}

// ─── 状态初始化 ───

export function initState(input: ExplorationInput): ExplorationState {
  const total = input.max_tokens ?? 128_000;
  return {
    visited: new Map(),
    frontier: input.seed_entities.map((e) => ({
      name: e,
      source: "seed",
      source_reason: "起始实体",
    })),
    paths: new Map(),
    entity_flags: [],
    cluster_flags: [],
    key_insights: [],
    raw_event_archive: [],
    exploration_log: [],
    budget: {
      total,
      exploring_limit: Math.floor(total * 0.78),
      finalize_reserved: Math.floor(total * 0.16),
      headroom: total - Math.floor(total * 0.78) - Math.floor(total * 0.16),
      used_tokens: 0,
    },
    step_count: 0,
    depth: 0,
    phase: "EXPLORING",
    mcp_degraded: false,
    force_sufficient: false,
    last_n_decisions: [],
    last_n_finding_counts: [],
    known_clusters: new Set(),
    nameIndex: new Map(),
    last_tool_results_raw: [],
    tool_call_failures: 0,
    token_warnings: 0,
    temporal_context: computeTemporalContext(),
  };
}

// ─── 并行预检 ───

function checkParallelBudget(
  calls: ToolCallCandidate[],
  state: ExplorationState,
): { reject: boolean; keepHighestPriority?: ToolCallCandidate } {
  const estimatedTokens = calls.reduce(
    (sum, call) => sum + (TOOL_TOKEN_ESTIMATE[call.tool] ?? 3000),
    0,
  );

  const remaining = state.budget.exploring_limit - state.budget.used_tokens;

  if (estimatedTokens > remaining * 0.3 && calls.length > 1) {
    return {
      reject: true,
      keepHighestPriority: pickMostImportantCall(calls),
    };
  }

  if (calls.length === 1 && estimatedTokens > remaining * 0.5) {
    state.force_sufficient = true;
    return { reject: true };
  }

  return { reject: false };
}

function pickMostImportantCall(calls: ToolCallCandidate[]): ToolCallCandidate {
  const priority: Record<string, number> = {
    expand: 4,
    trace: 3,
    lookup: 2,
    timeline: 2,
    scan: 1,
  };
  return calls.sort((a, b) => (priority[b.tool] ?? 0) - (priority[a.tool] ?? 0))[0];
}

// ─── 工具调用执行（并行/串行分组）───

async function executeToolCalls(
  calls: ToolCallCandidate[],
  mcpClient: KgMcpClient,
  state: ExplorationState,
): Promise<ToolResult[]> {
  // 分类：并行（只读）vs 串行（写操作）
  const parallelCalls: ToolCallCandidate[] = [];
  const serialCalls: ToolCallCandidate[] = [];

  for (const call of calls) {
    if (!isMcpTool(call.tool)) continue;
    (categorize(call.tool) === "parallel" ? parallelCalls : serialCalls).push(call);
  }

  // 辅助：执行单个工具调用
  async function executeOne(call: ToolCallCandidate): Promise<ToolResult> {
    log.info({ tool: call.tool, args: JSON.stringify(call.args).slice(0, 100) }, "执行工具调用");
    return mcpClient.callTool(
      call.tool as McpToolName,
      call.args as unknown as ToolInput,
    );
  }

  // Phase A: 并行执行只读工具
  const parallelSettled =
    parallelCalls.length > 0
      ? await Promise.allSettled(parallelCalls.map((c) => executeOne(c)))
      : [];

  // Phase B: 串行执行写操作工具
  const serialSettled: PromiseSettledResult<ToolResult>[] = [];
  for (const call of serialCalls) {
    try {
      serialSettled.push({ status: "fulfilled", value: await executeOne(call) });
    } catch (err) {
      serialSettled.push({ status: "rejected", reason: err });
    }
  }

  // 按原始顺序合并结果
  const results: ToolResult[] = [];
  let pi = 0;
  let si = 0;

  for (const call of calls) {
    if (!isMcpTool(call.tool)) continue;

    const isParallel = categorize(call.tool) === "parallel";
    const settled = isParallel ? parallelSettled[pi++] : serialSettled[si++];

    if (settled.status === "fulfilled") {
      results.push(settled.value);
    } else {
      const err = settled.reason;
      results.push({
        tool_name: call.tool,
        args: call.args as unknown as Record<string, unknown>,
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
        total_count: 0,
      });
    }
  }

  return results;
}

// ─── 原始事件归档 ───

function archiveRawEvents(result: ToolResult, state: ExplorationState): void {
  if (result.error || !result.data) return;

  const data = result.data as Record<string, unknown>;
  const units = data.knowledge_units;
  if (!Array.isArray(units)) return;

  const existingIds = new Set(state.raw_event_archive.map((e) => e.ku_id));

  for (const unit of units) {
    const u = unit as Record<string, unknown>;
    const kuId = typeof u.ku_id === "string" ? u.ku_id : undefined;
    if (!kuId || existingIds.has(kuId)) continue;

    const entitiesArr = Array.isArray(u.entities) ? u.entities : [];
    const entity = primaryEntityFromKu(entitiesArr);
    const eventType =
      (typeof u.unit_type === "string" && u.unit_type) ||
      (typeof u.event_type === "string" && u.event_type) ||
      "";
    const timestamp = timestampFromKuTime(u.time);
    const description =
      (typeof u.summary === "string" && u.summary) ||
      (typeof u.description === "string" && u.description) ||
      "";

    state.raw_event_archive.push({
      ku_id: kuId,
      entity,
      event_type: eventType,
      timestamp,
      description,
      cluster_id: typeof u.cluster_id === "string" ? u.cluster_id : undefined,
      source_step: state.step_count,
      event_data_type: "unknown",
    });
    existingIds.add(kuId);

    // 更新 visited 中的 EntitySummary 事件统计
    if (entity) {
      const resolvedName = resolveName(entity, state);
      const summary = state.visited.get(resolvedName);
      if (summary) {
        summary.related_events_count++;
        if (eventType && !summary.event_types.includes(eventType)) {
          summary.event_types.push(eventType);
        }
      }
    }
  }
}

// ─── LLM 批量数据分类 ───

const CLASSIFY_PROMPT = `你是数据分类器。判断以下金融知识图谱数据单元各属于哪种类型。

类型定义：
- structural_fact: 已发生的不可逆事件（制裁公告、并购、财报发布、政策变化、诉讼、供应链中断、高管变更等）
- streaming_snapshot: 瞬时观测值（盘中行情、实时报价、当前涨跌幅、日内价格变动等）
- aggregate_metric: 定期披露的聚合数字（收盘价、营收、净利润、PE、市值、ROE等财报指标）

注意：
- 同一个 KU 可能包含多种信息（如"盘中跌幅触发临停"），选择其核心性质。如果一句话的主体是行情变化但附带触发了事件，判为 streaming_snapshot。
- 不确定时选 unknown。

输入是 JSON 数组。返回同结构的 JSON 数组，每个元素添加 event_data_type 字段。
只返回 JSON，不要其他文字。

输入：
{input}

返回：`;

interface ClassifyInputItem {
  ku_id: string;
  event_type: string;
  description: string;
}

async function classifyBatchEvents(state: ExplorationState): Promise<void> {
  const unclassified = state.raw_event_archive.filter(
    (e) => e.event_data_type === "unknown",
  );

  if (unclassified.length === 0) return;

  const input: ClassifyInputItem[] = unclassified.map((e) => ({
    ku_id: e.ku_id,
    event_type: e.event_type,
    description: e.description.slice(0, 200),
  }));

  log.info({ count: input.length }, "开始批量分类事件");

  try {
    const llm = createLlmClient();
    const response = await llm.messages.create({
      model: readConfig().llm.model,
      max_tokens: 500,
      system: CLASSIFY_PROMPT,
      messages: [{ role: "user", content: JSON.stringify(input) }],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = textBlock && textBlock.type === "text" ? textBlock.text : "";

    const usedTokens = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
    state.budget.used_tokens += usedTokens;
    log.info({ input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens }, "事件分类完成");

    const parsed = parseClassifyResponse(text, unclassified);
    let updated = 0;
    for (const item of parsed) {
      const event = state.raw_event_archive.find((e) => e.ku_id === item.ku_id);
      if (event && isValidEventDataType(item.event_data_type)) {
        event.event_data_type = item.event_data_type;
        updated++;
      }
    }
    log.info({ updated, total: unclassified.length }, "事件分类结果");
  } catch (err) {
    log.warn({ err }, "事件分类失败，保持 unknown");
  }
}

function parseClassifyResponse(
  text: string,
  _unclassified: RawEvent[],
): Array<{ ku_id: string; event_data_type: string }> {
  const cleaned = text.trim();
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!arrayMatch) return [];

  try {
    const parsed = JSON.parse(arrayMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: unknown): item is { ku_id: string; event_data_type: string } =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).ku_id === "string" &&
        typeof (item as Record<string, unknown>).event_data_type === "string",
    );
  } catch {
    return [];
  }
}

function isValidEventDataType(value: string): value is EventDataType {
  return ["structural_fact", "streaming_snapshot", "aggregate_metric", "unknown"].includes(value);
}

// ─── KU 字段提取工具函数 ───

function primaryEntityFromKu(entitiesArr: unknown[]): string {
  if (!Array.isArray(entitiesArr) || entitiesArr.length === 0) return "";
  for (const e of entitiesArr) {
    const name = mentionFromKuEntity(e);
    if (name) return name;
  }
  return "";
}

function timestampFromKuTime(time: unknown): string {
  if (typeof time !== "object" || time === null) return "";
  const obj = time as Record<string, unknown>;
  if (typeof obj.event_time === "string" && obj.event_time) return obj.event_time;
  if (typeof obj.published_at === "string" && obj.published_at) return obj.published_at;
  return "";
}

function mentionFromKuEntity(e: unknown): string | null {
  if (typeof e !== "object" || e === null) return null;
  const obj = e as Record<string, unknown>;
  if (typeof obj.mention === "string" && obj.mention.trim()) return obj.mention.trim();
  if (typeof obj.canonical_name === "string" && obj.canonical_name.trim()) return obj.canonical_name.trim();
  return null;
}

function extractEntityId(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const obj = e as Record<string, unknown>;
  if (typeof obj.entity_id === "string" && obj.entity_id.trim()) return obj.entity_id.trim();
  return undefined;
}

function resolveName(name: string, state: ExplorationState): string {
  return state.nameIndex.get(name) ?? name;
}

function registerNameAliases(
  canonicalName: string,
  aliases: string[] | undefined,
  entityId: string | undefined,
  state: ExplorationState,
): void {
  if (canonicalName) {
    const existing = state.nameIndex.get(canonicalName);
    if (!existing || existing === canonicalName) {
      state.nameIndex.set(canonicalName, canonicalName);
    }
  }
  if (aliases) {
    for (const alias of aliases) {
      if (alias && alias !== canonicalName) {
        const existing = state.nameIndex.get(alias);
        if (!existing) {
          state.nameIndex.set(alias, canonicalName);
        }
      }
    }
  }
  if (entityId && canonicalName) {
    state.nameIndex.set(entityId, canonicalName);
  }
}

// ─── Cluster ID 提取 ───

function extractClusterIds(result: ToolResult, known: Set<string>): void {
  const data = result.data as Record<string, unknown> | null;
  if (!data) return;

  let added = 0;

  const eventClusters = data.event_clusters;
  if (Array.isArray(eventClusters)) {
    for (const c of eventClusters) {
      const id = (c as Record<string, unknown>).cluster_id;
      if (typeof id === "string") { known.add(id); added++; }
    }
  }

  const graphData = data.graph_data as Record<string, unknown> | undefined;
  const graphClusters = graphData?.clusters_overview;
  if (Array.isArray(graphClusters)) {
    for (const c of graphClusters) {
      const id = (c as Record<string, unknown>).cluster_id;
      if (typeof id === "string") { known.add(id); added++; }
    }
  }

  log.debug({ added, tool_name: result.tool_name, known: known.size }, "cluster ID 提取");
}

// ─── 实体元信息提取 ───

function extractEntityMeta(
  entityName: string,
  data: Record<string, unknown>,
): { type: EntitySummary["type"]; entity_id?: string; aliases?: string[] } {
  const entities = data.entities;
  const fallback = { type: "unknown" as EntitySummary["type"] };

  if (Array.isArray(entities)) {
    const match = entities.find(
      (e: unknown) => {
        const o = e as Record<string, unknown>;
        return o.canonical_name === entityName || o.name === entityName;
      },
    );
    if (match) {
      const m = match as Record<string, unknown>;
      const rawType = m.entity_type as string;
      let type: EntitySummary["type"] = "unknown";
      if (rawType === "Company" || rawType === "company") type = "company";
      else if (rawType === "Person" || rawType === "person") type = "person";
      else if (rawType === "Organization" || rawType === "organization") type = "organization";
      else if (rawType === "Product" || rawType === "product") type = "product";

      const entity_id = typeof m.entity_id === "string" ? m.entity_id : undefined;
      const aliases = Array.isArray(m.aliases) ? m.aliases.filter((a): a is string => typeof a === "string") : undefined;

      return { type, entity_id, aliases };
    }
  }
  return fallback;
}

// ─── 实体提取与 Frontier 管理 ───

interface ExtractedEntity {
  name: string;
  entity_id?: string;
  aliases?: string[];
  type?: string;
}

// 实体类型白名单：不在白名单内的类型不进入 frontier（准入控制）
const ALLOWED_TYPES = new Set(["company", "person", "organization", "product"]);

// 可疑类型：如果实体被映射为这些类型，标记为 entity_flag
const SUSPICIOUS_TYPES = new Set([
  "football team", "sports team", "athlete", "sports league",
  "movie", "song", "album", "video game", "tv show",
  "city", "country", "continent",  // 地理实体通常不是金融实体
]);

function extractAndAddEntities(results: ToolResult[], state: ExplorationState): string[] {
  const extracted = new Map<string, ExtractedEntity>();

  for (const result of results) {
    if (result.error || !result.data) continue;
    const data = result.data as Record<string, unknown>;

    // 1. 顶层 entities[]
    if (Array.isArray(data.entities)) {
      for (const e of data.entities) {
        const obj = e as Record<string, unknown>;
        const name = (typeof obj.canonical_name === "string" && obj.canonical_name) ||
                     (typeof obj.name === "string" && obj.name);
        if (!name) continue;

        const entity_id = typeof obj.entity_id === "string" ? obj.entity_id : undefined;
        const aliases = Array.isArray(obj.aliases)
          ? (obj.aliases as Array<string | null>).filter((a): a is string => typeof a === "string")
          : undefined;
        const etype = typeof obj.entity_type === "string" ? obj.entity_type : undefined;

        registerNameAliases(name, aliases, entity_id, state);

        // 代码层检测：可疑类型映射 → entity_flag
        if (etype && SUSPICIOUS_TYPES.has(etype.toLowerCase())) {
          const alreadyFlagged = state.entity_flags.some(
            (f) => f.entity_name === name && f.flag_type === "unreliable_mapping"
          );
          if (!alreadyFlagged) {
            state.entity_flags.push({
              entity_name: name,
              flag_type: "unreliable_mapping",
              description: `实体 "${name}" 被映射为 "${etype}"，可能为消歧错误`,
              source_step: state.step_count,
            });
          }
          // 可疑实体不加入 frontier
          continue;
        }

        const resolved = resolveName(name, state);
        if (state.visited.has(resolved)) continue;

        const key = entity_id ?? name;
        const existing = extracted.get(key);
        if (existing) {
          if (aliases && existing.aliases) {
            existing.aliases = [...new Set([...existing.aliases, ...aliases])];
          }
        } else {
          extracted.set(key, { name, entity_id, aliases, type: etype });
        }
      }
    }

    // 2. knowledge_units[].entities[]
    if (Array.isArray(data.knowledge_units)) {
      for (const u of data.knowledge_units) {
        const obj = u as Record<string, unknown>;
        if (!Array.isArray(obj.entities)) continue;
        for (const e of obj.entities) {
          const name = mentionFromKuEntity(e);
          if (!name) continue;
          const entity_id = extractEntityId(e);

          if (entity_id && name) {
            const canonical = state.nameIndex.get(entity_id);
            if (canonical && canonical !== name) {
              state.nameIndex.set(name, canonical);
            }
          }

          const resolved = resolveName(name, state);
          if (state.visited.has(resolved)) continue;

          const key = entity_id ?? name;
          if (!extracted.has(key)) {
            extracted.set(key, { name, entity_id });
          }
        }
      }
    }

    // 3. graph_data.nodes[]
    const graphData = data.graph_data as Record<string, unknown> | undefined;
    const nodes = graphData?.nodes;
    if (Array.isArray(nodes)) {
      for (const node of nodes) {
        const n = node as Record<string, unknown>;
        const name = (typeof n.canonical_name === "string" && n.canonical_name) ||
                     (typeof n.name === "string" && n.name);
        if (!name) continue;
        const entity_id = typeof n.entity_id === "string" ? n.entity_id : undefined;

        if (entity_id && name) registerNameAliases(name, undefined, entity_id, state);

        const resolved = resolveName(name, state);
        if (state.visited.has(resolved)) continue;

        const key = entity_id ?? name;
        if (!extracted.has(key)) {
          extracted.set(key, { name, entity_id });
        }
      }
    }
  }

  // 构造 FrontierEntity 列表
  const frontierEntities: FrontierEntity[] = [...extracted.values()].map((ex) => ({
    entity_id: ex.entity_id,
    name: ex.name,
    source: "tool_result",
    source_reason: "工具返回中发现",
    type: mapEntityType(ex.type),
  }));

  addToFrontier(frontierEntities, state);
  return frontierEntities.map((f) => f.name);
}

function mapEntityType(rawType: string | undefined): FrontierEntity["type"] {
  if (!rawType) return undefined;
  const t = rawType.toLowerCase();
  if (t === "company") return "company";
  if (t === "person") return "person";
  if (t === "organization") return "organization";
  if (t === "product") return "product";
  return undefined;
}

// ─── Frontier 准入控制 ───

function addToFrontier(entities: FrontierEntity[], state: ExplorationState): void {
  for (const entity of entities) {
    // 准入检查 1: 已探索
    const resolvedName = resolveName(entity.name, state);
    if (state.visited.has(resolvedName)) continue;

    // 准入检查 2: entity_flags 中标记为 unreliable_mapping
    const flagged = state.entity_flags.find(
      (f) => f.entity_name === entity.name && f.flag_type === "unreliable_mapping"
    );
    if (flagged) continue;

    // 准入检查 3: 类型不在白名单
    if (entity.type && !ALLOWED_TYPES.has(entity.type)) continue;

    // entity_id 去重
    if (entity.entity_id) {
      const existingById = state.frontier.find((e) => e.entity_id === entity.entity_id);
      if (existingById) {
        existingById.mention_count = (existingById.mention_count ?? 0) + 1;
        continue;
      }
    }

    // 名字去重
    const existingByName = state.frontier.find((e) => e.name === entity.name);
    if (existingByName) {
      existingByName.mention_count = (existingByName.mention_count ?? 0) + 1;
      if (entity.entity_id && !existingByName.entity_id) {
        existingByName.entity_id = entity.entity_id;
      }
      continue;
    }

    entity.mention_count = 1;
    state.frontier.push(entity);
  }

  // Cap at MAX_FRONTIER_SIZE: 保留 mention_count 最高的
  if (state.frontier.length > MAX_FRONTIER_SIZE) {
    state.frontier.sort((a, b) => (b.mention_count ?? 0) - (a.mention_count ?? 0));
    state.frontier = state.frontier.slice(0, MAX_FRONTIER_SIZE);
  }
}

// ─── Visited 标记 ───

function markVisited(
  entities: string[],
  state: ExplorationState,
  metaMap?: Map<string, { entity_id?: string; aliases?: string[]; type?: EntitySummary["type"] }>,
): void {
  for (const name of entities) {
    const resolved = resolveName(name, state);

    if (!state.visited.has(resolved)) {
      const meta = metaMap?.get(name);
      state.visited.set(resolved, {
        entity_id: meta?.entity_id,
        name: resolved,
        aliases: meta?.aliases ?? [],
        type: meta?.type ?? "unknown",
        related_events_count: 0,
        event_types: [],
        clusters_count: 0,
        discovered_at_step: state.step_count,
      });
    }
  }
}

// ─── Finding 路由：LLM new_findings → entity_flags / cluster_flags / key_insights ───

// ─── Phase 切换 ───

const MIN_FINDINGS = 1;
const MIN_RECENT_PRODUCTIVITY_STEPS = 3;
const MIN_ENTITY_COVERAGE_RATIO = 0.3;

function checkPhaseTransition(state: ExplorationState): "EXPLORING" | "FINALIZE" {
  // P0: EXPLORING 预算用尽
  if (state.budget.used_tokens >= state.budget.exploring_limit) return "FINALIZE";

  // P1: 步数上限
  if (state.step_count >= MAX_EXPLORING_STEPS) return "FINALIZE";

  // P2: 无路可走
  if (state.frontier.length === 0) return "FINALIZE";

  const decision = state.last_n_decisions[state.last_n_decisions.length - 1];

  // P3: LLM 提议 sufficient → 三关校验
  if (decision === "sufficient") {
    if (state.key_insights.length < MIN_FINDINGS) {
      if (state.frontier.length > 0) return "EXPLORING";
      return "FINALIZE";
    }

    if (!checkRecentProductivity(state)) return "EXPLORING";

    const coverage = calcEntityCoverage(state);
    if (coverage < MIN_ENTITY_COVERAGE_RATIO) {
      state.injectHint = buildCoverageHint(state, coverage);
      return "EXPLORING";
    }

    return "FINALIZE";
  }

  // P4: stalemate — 连续 2 轮 stalemate + 无新 finding → FINALIZE
  if (decision === "stalemate") {
    const last2 = state.last_n_decisions.slice(-2);
    const last2Counts = state.last_n_finding_counts.slice(-2);
    if (
      last2.length === 2 &&
      last2.every(d => d === "stalemate") &&
      last2Counts[0] === last2Counts[1]
    ) {
      return "FINALIZE";
    }
    return "EXPLORING";
  }

  // P5: diminishing returns
  if (detectDecisionLoop(state)) {
    applyLoopBreak(state);
    if (state.force_sufficient) return "FINALIZE";
  }

  return "EXPLORING";
}

function checkRecentProductivity(state: ExplorationState): boolean {
  const recentCounts = state.last_n_finding_counts.slice(-MIN_RECENT_PRODUCTIVITY_STEPS);
  if (recentCounts.length < MIN_RECENT_PRODUCTIVITY_STEPS) return true;
  return recentCounts.some((count, i) => {
    const prev = i === 0 ? 0 : recentCounts[i - 1];
    return count > prev;
  });
}

function calcEntityCoverage(state: ExplorationState): number {
  const visitedEntityIds = new Set<string>();
  for (const [, summary] of state.visited) {
    if (summary.entity_id) visitedEntityIds.add(summary.entity_id);
  }

  const allEntityIds = new Set(visitedEntityIds);
  for (const fe of state.frontier) {
    if (fe.entity_id) allEntityIds.add(fe.entity_id);
  }

  if (allEntityIds.size === 0) {
    const allNames = new Set([...state.visited.keys(), ...state.frontier.map((e) => e.name)]);
    if (allNames.size === 0) return 1.0;
    return state.visited.size / allNames.size;
  }

  return visitedEntityIds.size / allEntityIds.size;
}

function buildCoverageHint(state: ExplorationState, coverage: number): string {
  const unvisited = state.frontier
    .filter((e) => {
      const resolved = resolveName(e.name, state);
      return !state.visited.has(resolved);
    })
    .slice(0, 3)
    .map((e) => e.name)
    .join("、");
  return `coverage=${(coverage * 100).toFixed(0)}%, below threshold (${MIN_ENTITY_COVERAGE_RATIO * 100}%). Unvisited entities include: ${unvisited}. Expand to unvisited entities before concluding.`;
}

// ─── 日志 ───

function makeLogEntry(
  state: ExplorationState,
  decision: string,
  toolCallsCount: number,
  newFindingsCount: number,
): LogEntry {
  return {
    step: state.step_count,
    phase: state.phase,
    decision,
    tool_calls_count: toolCallsCount,
    new_findings_count: newFindingsCount,
  };
}

// ─── 输出组装 ───

function assembleOutput(state: ExplorationState): ExplorationOutput {
  const reliability = generateReliabilityNote(state);
  const findings = state.final_findings ?? state.key_insights;

  return {
    findings,
    event_threads: state.event_threads ?? [],
    exploration_meta: {
      completion_reason: determineCompletionReason(state),
      stats: {
        steps: state.step_count,
        entities_visited: state.visited.size,
        findings_count: findings.length,
        events_buffered: state.raw_event_archive.length,
        tokens_used: state.budget.used_tokens,
      },
      exploration_log: state.exploration_log,
      reliability_note: reliability,
    },
  };
}

// ─── 上下文预算检查（4 级退化：85%→压缩, 90%→警告, 95%→FINALIZE, 100%→强制）───

const CONTEXT_WARN_RATIO = 0.9;
const CONTEXT_COMPRESS_RATIO = 0.85;
const CONTEXT_FORCE_RATIO = 1.0;

function checkContextBudget(state: ExplorationState, systemPrompt: string, goal: string, seedEntities: string[], timeRange?: string): boolean {
  const context = assembleContext(state, systemPrompt, goal, seedEntities, timeRange);
  const ratio = context.totalEstimatedTokens / state.budget.exploring_limit;

  // 100%+ 强制 FINALIZE
  if (ratio >= CONTEXT_FORCE_RATIO) {
    log.warn({ ratio: (ratio * 100).toFixed(0) }, "上下文预算用尽，强制 FINALIZE");
    return true;
  }

  // 90%+ 警告
  if (ratio >= CONTEXT_WARN_RATIO) {
    state.token_warnings++;
    log.warn({ ratio: (ratio * 100).toFixed(0), warning: state.token_warnings }, "上下文预算告警");
  }

  // 85%+ 压缩
  if (ratio >= CONTEXT_COMPRESS_RATIO) {
    state.exploration_log = compressExplorationLog(state.exploration_log);

    const afterContext = assembleContext(state, systemPrompt, goal, seedEntities, timeRange);
    const afterRatio = afterContext.totalEstimatedTokens / state.budget.exploring_limit;

    // 压缩后仍 > 95% → FINALIZE
    if (afterRatio > 0.95) {
      log.warn({ afterRatio: (afterRatio * 100).toFixed(0) }, "压缩后上下文仍然超标，触发 FINALIZE");
      return true;
    }

    log.info({ before: (ratio * 100).toFixed(0), after: (afterRatio * 100).toFixed(0) }, "exploration_log 已压缩");
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════
// 主循环
// ═══════════════════════════════════════════════════════════════

export interface ExplorationResult {
  output: ExplorationOutput;
  state: ExplorationState;
}

export async function runExploration(
  input: ExplorationInput,
  onStep?: (event: StepEvent) => void,
  initialState?: ExplorationState,
  signal?: AbortSignal,
): Promise<ExplorationResult> {
  const state = initialState ?? initState(input);
  const sl = input.session_id
    ? log.child({ sessionId: input.session_id })
    : log;
  const llm = createLlmClient();
  const mcpClient = new KgMcpClient();

  try {
    await mcpClient.connect();
  } catch (err) {
    sl.warn(
      { err: String((err as Error)?.message ?? err) },
      "MCP 连接失败，探索无法执行（mcp_unavailable）",
    );
    state.mcp_degraded = true;
    state.reliability_note = "知识图谱服务连接失败，探索未能执行";
    return { output: assembleOutput(state), state };
  }

  const messages: MessageParam[] = [];
  let consecutiveFormatErrors = 0;
  let finalizeAttempts = 0;

  try {
    while (true) {
      // 检查取消信号
      if (signal?.aborted) {
        sl.info("探索被取消");
        state.phase = "FINALIZE";
        // 快速结束：使用已有 findings，不生成 event threads
        state.final_findings = deduplicateFindings(state.key_insights);
        state.event_threads = [];
        onStep?.({
          type: "finalize",
          step: state.step_count,
          phase: "FINALIZE",
          exploration_meta: {
            completion_reason: "cancelled",
            stats: {
              steps: state.step_count,
              entities_visited: state.visited.size,
              findings_count: state.key_insights.length,
              events_buffered: state.raw_event_archive.length,
              tokens_used: state.budget.used_tokens,
            },
            exploration_log: state.exploration_log.map((e) => ({
              step: e.step,
              phase: e.phase,
              decision: e.decision,
              tool_calls_count: e.tool_calls_count,
              new_findings_count: e.new_findings_count,
            })),
            reliability_note: "用户取消探索",
          },
        });
        break;
      }

      sl.info(
        { step: state.step_count, phase: state.phase, visited: state.visited.size,
          frontier: state.frontier.length, insights: state.key_insights.length,
          archive: state.raw_event_archive.length,
          budget_used: state.budget.used_tokens, budget_limit: state.budget.exploring_limit },
        "loop iteration",
      );

      if (state.phase === "FINALIZE") {
        finalizeAttempts++;
        if (finalizeAttempts > MAX_FINALIZE_STEPS) break;
      }

      if (state.phase === "EXPLORING" && state.step_count >= MAX_EXPLORING_STEPS + MAX_FINALIZE_STEPS) {
        break;
      }

      // ─── 上下文预算检查 ───
      const systemPrompt = buildSystemPrompt(state);
      if (state.phase === "EXPLORING" && checkContextBudget(state, systemPrompt, input.goal, input.seed_entities, input.time_range)) {
        state.phase = "FINALIZE";
        continue;
      }

      // ─── 1. 组装上下文 ───
      const context = assembleContext(
        state,
        systemPrompt,
        input.goal,
        input.seed_entities,
        input.time_range,
      );

      // ─── 2. 构建消息 ───
      const llmMessages = buildLlmMessages(context, messages, state);

      // ─── 3. 调用 LLM ───
      let llmResponse: string;
      try {
        sl.info("调用 LLM");
        const response = await llm.messages.create({
          model: readConfig().llm.model,
          max_tokens: readConfig().llm.max_tokens,
          system: context.systemPrompt,
          messages: llmMessages,
        });

        const textBlock = response.content.find((b) => b.type === "text");
        llmResponse = textBlock && textBlock.type === "text" ? textBlock.text : "";

        const inputTokens = response.usage?.input_tokens ?? 0;
        const outputTokens = response.usage?.output_tokens ?? 0;
        sl.info({ input: inputTokens, output: outputTokens, text_len: llmResponse.length }, "LLM 响应");
        state.budget.used_tokens += inputTokens + outputTokens;
      } catch (err) {
        sl.error({ err, phase: state.phase }, "LLM 调用失败");
        if (state.phase === "FINALIZE") {
          state.reliability_note = "FINALIZE LLM 调用失败，使用原始 findings，无 Event Thread";
          state.final_findings = deduplicateFindings(state.key_insights);
          state.event_threads = [];
          onStep?.({
            type: "error",
            step: state.step_count,
            phase: "FINALIZE",
            error: "FINALIZE LLM 调用失败",
          });
          break;
        }
        consecutiveFormatErrors++;
        if (consecutiveFormatErrors >= 2) {
          state.phase = "FINALIZE";
          continue;
        }
        state.step_count++;
        continue;
      }

      // ─── 4. 解析 LLM 输出 ───
      const parsed = fixLLMOutput(llmResponse);

      if (!parsed) {
        consecutiveFormatErrors++;
        if (consecutiveFormatErrors >= 2) {
          if (state.phase === "EXPLORING") {
            state.phase = "FINALIZE";
            continue;
          }
          break;
        }
        state.step_count++;
        continue;
      }

      consecutiveFormatErrors = 0;

      // 记录 assistant 消息
      messages.push({ role: "assistant", content: llmResponse });

      // ─── 5. 根据 phase 处理 ───
      if (state.phase === "EXPLORING") {
        await handleExploring(parsed, state, mcpClient, messages, input, onStep);
        const newPhase = checkPhaseTransition(state);
        sl.info({ from: state.phase, to: newPhase }, "阶段切换");
        state.phase = newPhase;
      } else {
        handleFinalize(parsed, state, onStep);
        break;
      }

      state.step_count++;
    }
  } finally {
    await mcpClient.close();
  }

  return { output: assembleOutput(state), state };
}

// ─── EXPLORING 处理 ───

async function handleExploring(
  parsed: NonNullable<ReturnType<typeof fixLLMOutput>>,
  state: ExplorationState,
  mcpClient: KgMcpClient,
  messages: MessageParam[],
  input: ExplorationInput,
  onStep?: (event: StepEvent) => void,
): Promise<void> {
  // 决策解析（两层）:
  //  - strategyDecision: 纯探索策略（expand/deep_dive/verify），由 decision 字段决定
  //  - stopSignal: 终止意图（sufficient/stalemate），由独立的 stop 字段决定
  //                （extractStopSignal 兼容旧 LLM 在 decision 里残留的 sufficient/stalemate）
  // effectiveDecision 合成: force_strategy > stopSignal > strategyDecision
  // 这样 last_n_decisions 的语义不变，下游 P3/P4/detectDecisionLoop/shouldExtractFindings 全部无感。
  const strategyDecision = validateDecision(parsed.decision ?? "expand");
  const stopSignal = extractStopSignal(parsed);
  const effectiveDecision = state.force_strategy ?? stopSignal ?? strategyDecision;

  const rawCalls = parsed.tool_calls ?? [];
  const validCalls = validateToolCalls(rawCalls, state.known_clusters);

  log.info(
    { strategy: strategyDecision, stop: stopSignal, decision: effectiveDecision,
      rawCalls: rawCalls.length, validCalls: validCalls.length,
      rawTools: rawCalls.map((c: ToolCallCandidate) => c.tool).join(",") },
    "决策统计",
  );

  // 并行预检
  const parallelGuard = checkParallelBudget(validCalls, state);
  const callsToExecute = parallelGuard.reject
    ? (parallelGuard.keepHighestPriority ? [parallelGuard.keepHighestPriority] : [])
    : validCalls;

  log.info({ reject: parallelGuard.reject, callsToExecute: callsToExecute.length }, "并行预检");

  // 执行工具调用
  const results = await executeToolCalls(callsToExecute, mcpClient, state);

  // 归档原始事件 + 提取 cluster IDs
  for (const result of results) {
    if (isMcpTool(result.tool_name)) {
      extractClusterIds(result, state.known_clusters);
      archiveRawEvents(result, state);
    }
  }

  state.last_tool_results_raw = results;

  // 注入当前轮工具结果到 LLM 上下文
  const toolResultText = formatToolResultsForLLM(results, state);
  messages.push({ role: "user", content: toolResultText });

  // 更新 visited
  const targetMeta = new Map<string, { entity_id?: string; aliases?: string[]; type?: EntitySummary["type"] }>();

  for (const call of callsToExecute) {
    if (call.tool === "lookup") {
      const entities = call.args.entities;
      if (Array.isArray(entities)) {
        for (const name of entities as string[]) {
          if (typeof name === "string") {
            for (const result of results) {
              if (result.error || !result.data) continue;
              const data = result.data as Record<string, unknown>;
              const meta = extractEntityMeta(name, data);
              if (meta.entity_id || meta.type !== "unknown") {
                targetMeta.set(name, meta);
                registerNameAliases(name, meta.aliases, meta.entity_id, state);
                break;
              }
            }
          }
        }
      }
    }
    if (call.tool === "timeline") {
      const entity = call.args.entity;
      if (typeof entity === "string") {
        for (const result of results) {
          if (result.error || !result.data) continue;
          const data = result.data as Record<string, unknown>;
          const meta = extractEntityMeta(entity, data);
          if (meta.entity_id || meta.type !== "unknown") {
            targetMeta.set(entity, meta);
            registerNameAliases(entity, meta.aliases, meta.entity_id, state);
            break;
          }
        }
      }
    }
  }

  // 标记主动探索的实体
  for (const call of callsToExecute) {
    if (call.tool === "lookup") {
      const entities = call.args.entities;
      if (Array.isArray(entities)) markVisited(entities as string[], state, targetMeta);
    }
    if (call.tool === "timeline") {
      const entity = call.args.entity;
      if (typeof entity === "string") markVisited([entity], state, targetMeta);
    }
  }

  // 提取新实体
  extractAndAddEntities(results, state);
  state.frontier = state.frontier.filter((e) => !state.visited.has(resolveName(e.name, state)));

  // LLM 批量分类新归档事件的数据类型（用于置信度加权和 Thread 过滤）
  await classifyBatchEvents(state);

  // 处理 findings → 路由到三层（entity_flags / cluster_flags / key_insights）
  let newFindingsCount = 0;
  if (parsed.new_findings && Array.isArray(parsed.new_findings) && parsed.new_findings.length > 0) {
    const rawFindings = parsed.new_findings as RawFinding[];
    log.info({ count: rawFindings.length }, "处理 new_findings");
    processNewFindings(rawFindings, state);
    newFindingsCount = rawFindings.length;
  } else if (stopSignal !== null) {
    log.info({ stop: stopSignal }, "有终止信号但无 new_findings");
  }

  // 决策历史
  state.last_n_decisions.push(effectiveDecision);
  if (state.last_n_decisions.length > 5) state.last_n_decisions.shift();
  state.last_n_finding_counts.push(state.key_insights.length);
  if (state.last_n_finding_counts.length > 5) state.last_n_finding_counts.shift();

  // 重置
  state.force_strategy = undefined;
  state.injectHint = undefined;

  // 日志
  state.exploration_log.push(
    makeLogEntry(state, effectiveDecision, callsToExecute.length, newFindingsCount),
  );

  // 回调：通知前端步骤完成
  onStep?.({
    type: "step_complete",
    step: state.step_count,
    phase: "EXPLORING",
    decision: effectiveDecision,
    tools_used: callsToExecute.map((c) => c.tool as import("./state.js").McpToolName),
    new_entities: state.frontier.slice(-5).map((e) => e.name),
    new_findings_count: newFindingsCount,
    total_findings: state.key_insights.length,
    total_entities: state.visited.size,
    total_events: state.raw_event_archive.length,
    budget_used: state.budget.used_tokens,
    budget_limit: state.budget.exploring_limit,
  });
}

// ─── FINALIZE 处理 ───

function normalizeFinalizeFinding(
  raw: Record<string, unknown>,
  rawEventArchive: RawEvent[],
  stepCount: number,
): Finding | null {
  const statement = typeof raw.statement === "string" ? raw.statement.trim() : "";
  if (!statement) return null;

  const entities =
    (Array.isArray(raw.entities_involved) ? raw.entities_involved : null) ??
    (Array.isArray(raw.entities) ? raw.entities : []);
  const entities_involved = entities.filter((e): e is string => typeof e === "string");

  const relation_to_goal =
    (typeof raw.relation_to_goal === "string" && raw.relation_to_goal) ||
    (typeof raw.relevance === "string" && raw.relevance) ||
    "";

  const validCategories = ["pattern_violation", "concentration", "chain", "absence"] as const;
  type Category = (typeof validCategories)[number];
  const rawCategory = raw.category as string;
  const category: Category = (validCategories as readonly string[]).includes(rawCategory)
    ? (rawCategory as Category)
    : "chain";

  const validConfidence = ["high", "medium", "low"] as const;
  type Confidence = (typeof validConfidence)[number];
  const rawConf = raw.confidence as string;
  const confidence: Confidence = (validConfidence as readonly string[]).includes(rawConf)
    ? (rawConf as Confidence)
    : "medium";

  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const validKuIds = new Set(rawEventArchive.map((e) => e.ku_id));
  const evidence = rawEvidence.filter(
    (k): k is string => typeof k === "string" && validKuIds.has(k),
  );
  if (evidence.length === 0) return null;

  let finalEntities = entities_involved;
  if (finalEntities.length === 0) {
    const fromEvents = rawEventArchive
      .filter((e) => evidence.includes(e.ku_id))
      .map((e) => e.entity)
      .filter((e): e is string => Boolean(e));
    finalEntities = [...new Set(fromEvents)];
  }

  const finding: Finding = {
    id: `finding_${randomUUID()}`,
    category,
    statement,
    confidence,
    evidence,
    entities_involved: finalEntities,
    relation_to_goal,
    discovered_at_step: stepCount,
  };

  if (typeof raw.conflict_with === "string" && raw.conflict_with) {
    finding.conflict_with = raw.conflict_with;
  }
  return finding;
}

function deduplicateFindings(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  return findings.filter((f) => {
    if (seen.has(f.statement)) return false;
    seen.add(f.statement);
    return true;
  });
}

function handleFinalize(
  parsed: NonNullable<ReturnType<typeof fixLLMOutput>> | null,
  state: ExplorationState,
  onStep?: (event: StepEvent) => void,
): void {
  if (!parsed) {
    state.reliability_note = "FINALIZE LLM 调用失败，使用原始 findings，无 Event Thread";
    state.final_findings = deduplicateFindings(state.key_insights);
    state.event_threads = [];
    return;
  }

  const rawEventCount = state.raw_event_archive.length;

  // ─── 阶段 1: 分析原始事件 ───
  onStep?.({
    type: "analyzing_events",
    step: state.step_count,
    phase: "FINALIZE",
    events_analyzed: rawEventCount,
    detail: `正在分析 ${rawEventCount} 条原始事件`,
  });

  // ─── 阶段 2: 抽取 Findings ───
  if (Array.isArray(parsed.key_findings)) {
    const rawArr = parsed.key_findings as Record<string, unknown>[];
    const validFindings: Finding[] = [];
    const seenStatements = new Set<string>();

    for (const raw of rawArr) {
      if (!raw || typeof raw !== "object") continue;
      const normalized = normalizeFinalizeFinding(raw, state.raw_event_archive, state.step_count);
      if (!normalized) continue;
      if (seenStatements.has(normalized.statement)) continue;
      seenStatements.add(normalized.statement);
      validFindings.push(normalized);
    }

    const dropped = rawArr.length - validFindings.length;
    if (dropped > 0) {
      const note = `FINALIZE 丢弃 ${dropped} 条 finding（缺 statement/evidence 或 schema 不合规）`;
      state.reliability_note = state.reliability_note ? `${state.reliability_note}；${note}` : note;
    }

    state.final_findings = validFindings;

    onStep?.({
      type: "extracting_findings",
      step: state.step_count,
      phase: "FINALIZE",
      findings_extracted: validFindings.length,
      findings_dropped: dropped,
      detail: `已抽取 ${validFindings.length} 条发现${dropped > 0 ? `，丢弃 ${dropped} 条无效` : ""}`,
    });
  }

  // ─── 阶段 3: 构建 Event Threads ───
  if (parsed.threads && Array.isArray(parsed.threads)) {
    const rawThreads = parsed.threads as import("./state.js").EventThread[];

    for (const thread of rawThreads) {
      if (!thread.id) thread.id = `thread_${randomUUID()}`;
    }

    onStep?.({
      type: "building_threads",
      step: state.step_count,
      phase: "FINALIZE",
      threads_built: rawThreads.length,
      detail: `已构建 ${rawThreads.length} 条事件脉络`,
    });

    // ─── 阶段 4: 验证 Threads ───
    const { threads: validThreads, warnings } = validateThreads(
      rawThreads,
      state.raw_event_archive,
    );

    const threadsDropped = rawThreads.length - validThreads.length;
    if (threadsDropped > 0) {
      const existing = state.reliability_note ?? "";
      const note = `${threadsDropped} threads 被丢弃（验证失败）`;
      state.reliability_note = existing ? `${existing}；${note}` : note;
    }

    if (validThreads.length === 0 && state.raw_event_archive.length >= 3) {
      state.reliability_note = (state.reliability_note ?? "") + " All threads failed validation, using findings only";
    }

    state.event_threads = validThreads;

    onStep?.({
      type: "validating",
      step: state.step_count,
      phase: "FINALIZE",
      threads_built: validThreads.length,
      threads_dropped: threadsDropped,
      detail: `验证通过 ${validThreads.length} 条脉络${threadsDropped > 0 ? `，丢弃 ${threadsDropped} 条` : ""}`,
    });

    // 代码补全: LLM 未输出 time_span 时从 thread_events 自动计算
    for (const thread of validThreads) {
      if (!thread.time_span || !thread.time_span.earliest || !thread.time_span.latest) {
        const timestamps = thread.thread_events
          .map((e) => e.timestamp)
          .filter((t): t is string => Boolean(t))
          .sort();
        thread.time_span = {
          earliest: timestamps[0] ?? "",
          latest: timestamps[timestamps.length - 1] ?? "",
        };
      }
    }
  }

  // 回调：通知前端探索完成
  const output = assembleOutput(state);
  onStep?.({
    type: "finalize",
    step: state.step_count,
    phase: "FINALIZE",
    findings: output.findings,
    event_threads: output.event_threads,
    exploration_meta: output.exploration_meta,
    total_findings: output.findings.length,
    total_entities: state.visited.size,
    total_events: state.raw_event_archive.length,
    budget_used: state.budget.used_tokens,
    budget_limit: state.budget.total,
  });
}

// ─── 构建 LLM 消息序列 ───

function buildLlmMessages(
  context: import("./context.js").AssembledContext,
  messages: MessageParam[],
  state: ExplorationState,
): MessageParam[] {
  // 首轮：发送 goal + state view
  if (messages.length === 0) {
    return [
      { role: "user", content: context.goalMessage + "\n\n" + context.stateView },
    ];
  }

  // 后续轮：只发送 state view
  return [
    ...messages,
    { role: "user", content: context.stateView },
  ];
}
