// 上下文组装 — v3: 拆为 EXPLORING / FINALIZE 两条路径，删除分段压缩
//
// 核心变化:
// - 删除 HistoryStep / RawStep / CondensedStep 分段压缩体系
// - EXPLORING: visited + frontier+reason + entity_flags + key_insights + budget
// - FINALIZE: key_insights(全量) + raw_event_archive(全量) + exploration_log + entity_flags + cluster_flags
// - 工具返回压缩仅用于当前轮注入，不跨轮保留

import type {
  ExplorationState,
  ExplorationBudget,
  EntitySummary,
  RawEvent,
  Finding,
  ToolResult,
  EntityFlag,
  ClusterFlag,
} from "./state.js";

// ─── Token 估算 ───

export function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.6);
}

// ─── 预算状态 ───

export interface BudgetStatus {
  total: number;
  used: number;
  exploringRemaining: number;
  exploringRatio: number;
  isTight: boolean;
  isSevere: boolean;
}

export function getBudgetStatus(state: ExplorationState): BudgetStatus {
  const used = state.budget.used_tokens;
  const exploringLimit = state.budget.exploring_limit;
  const ratio = used / exploringLimit;
  return {
    total: state.budget.total,
    used,
    exploringRemaining: exploringLimit - used,
    exploringRatio: ratio,
    isTight: ratio >= 0.8,
    isSevere: ratio >= 0.9,
  };
}

// ─── 工具返回压缩（当前轮注入 LLM）───

export function formatToolResultsForLLM(results: ToolResult[], state: ExplorationState): string {
  const exploredRatio = state.budget.used_tokens / state.budget.exploring_limit;
  const parts: string[] = [];

  for (const result of results) {
    if (result.tool_name === "expand" && result.success) {
      parts.push(formatExpandResult(result, state));
    } else if (exploredRatio < 0.5) {
      parts.push(formatToolResult(result, 5, state));
    } else if (exploredRatio < 0.7) {
      parts.push(formatToolResult(result, 3, state));
    } else {
      parts.push(formatToolResult(result, 0, state));
    }
  }

  const text = parts.join("\n");
  const estimated = estimateTokens(text);
  if (estimated > 4000) {
    return text.slice(0, Math.floor(4000 / 0.6)) + "\n[内容过长已截断]";
  }
  return text;
}

function formatToolResult(result: ToolResult, topK: number, state: ExplorationState): string {
  if (result.error) {
    return `Step ${result.tool_name}: 错误 — ${result.error}\n`;
  }
  if (!result.success || !result.data) {
    return `Step ${result.tool_name}: 无数据返回\n`;
  }

  const data = result.data as Record<string, unknown>;
  const lines: string[] = [];

  const units = data.knowledge_units;
  const clusters = data.event_clusters;
  const entityCount = Array.isArray(data.entities) ? data.entities.length : 0;
  const kuCount = Array.isArray(units) ? units.length : 0;
  const clusterCount = Array.isArray(clusters) ? clusters.length : 0;

  lines.push(`结果摘要 (${result.tool_name}):`);
  lines.push(`  ${kuCount} 条知识单元, ${entityCount} 个实体, ${clusterCount} 个聚类`);

  if (topK > 0 && Array.isArray(units)) {
    const top = units.slice(0, topK) as Array<Record<string, unknown>>;
    for (let i = 0; i < top.length; i++) {
      const u = top[i];
      const kuId = typeof u.ku_id === "string" ? u.ku_id : "?";
      const summary = typeof u.summary === "string" ? u.summary : "";
      const time = u.time as Record<string, unknown> | undefined;
      const ts = time && typeof time.event_time === "string" ? time.event_time : "";
      lines.push(`  事件 ${i + 1}: ${kuId} ${ts} ${summary.slice(0, 80)}`);
    }
    if (units.length > topK) {
      lines.push(`  ...还有 ${units.length - topK} 条`);
    }
  }

  // 注入 cluster 级别的 flags
  if (Array.isArray(clusters)) {
    for (const c of clusters) {
      const obj = c as Record<string, unknown>;
      const cid = typeof obj.cluster_id === "string" ? obj.cluster_id : "";
      if (cid) {
        const flags = state.cluster_flags.filter((f) => f.cluster_id === cid);
        for (const flag of flags) {
          lines.push(`  ⚠️ 数据标记 [${cid}]: ${flag.description}`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}

function formatExpandResult(result: ToolResult, state: ExplorationState): string {
  if (result.error || !result.data) {
    return formatToolResult(result, 0, state);
  }

  const data = result.data as Record<string, unknown>;
  const lines: string[] = [];
  lines.push("展开聚类详情:");

  const units = data.knowledge_units;
  if (Array.isArray(units)) {
    for (const u of units) {
      const obj = u as Record<string, unknown>;
      const kuId = typeof obj.ku_id === "string" ? obj.ku_id : "?";
      const summary = typeof obj.summary === "string" ? obj.summary : "";
      const entities = Array.isArray(obj.entities) ? obj.entities : [];
      const mentions = entities
        .map((e: unknown) => {
          const o = e as Record<string, unknown>;
          return typeof o.mention === "string" ? o.mention : "";
        })
        .filter(Boolean)
        .join(", ");
      lines.push(`  - [${kuId}] ${mentions}: ${summary.slice(0, 100)}`);
    }
  }

  return lines.join("\n") + "\n";
}

// ═══════════════════════════════════════════════════════════════
// EXPLORING State View
// ═══════════════════════════════════════════════════════════════

function groupByType(entities: EntitySummary[]): Map<string, EntitySummary[]> {
  const groups = new Map<string, EntitySummary[]>();
  for (const summary of entities) {
    const list = groups.get(summary.type) ?? [];
    list.push(summary);
    groups.set(summary.type, list);
  }
  return groups;
}

function formatEntityTypeGroup(type: string, entities: EntitySummary[]): string {
  const typeLabels: Record<string, string> = {
    company: "公司",
    person: "人物",
    organization: "组织",
    product: "产品",
    unknown: "未知",
  };
  const label = typeLabels[type] ?? type;
  const items = entities
    .slice(0, 10)
    .map((e) => {
      const tags: string[] = [];
      if (e.related_events_count > 0) {
        const topTypes = e.event_types.slice(0, 2);
        tags.push(...topTypes.map((t) => `${t}×${e.related_events_count}`));
      }
      return tags.length > 0 ? `${e.name} (${tags.join(", ")})` : e.name;
    })
    .join(", ");
  const overflow = entities.length > 10 ? `, ...共 ${entities.length} 个` : "";
  return `├─ ${label} (${entities.length}): ${items}${overflow}`;
}

function formatEntityFlags(flags: EntityFlag[]): string {
  if (flags.length === 0) return "";
  const lines: string[] = [];
  lines.push("");
  lines.push("─── ⚠️ 实体警告 ───");
  for (const flag of flags) {
    lines.push(`  ⚠️ ${flag.entity_name}: ${flag.description}`);
  }
  return lines.join("\n") + "\n";
}

function formatFrontierBrief(state: ExplorationState): string {
  if (state.frontier.length === 0) {
    return "  (空)";
  }

  // 按 mention_count 分 tier 展示（仅展示，不做排序）
  const highFreq = state.frontier.filter((f) => (f.mention_count ?? 0) >= 3);
  const midFreq = state.frontier.filter((f) => {
    const c = f.mention_count ?? 0;
    return c >= 2 && c < 3;
  });
  const lowFreq = state.frontier.filter((f) => {
    const c = f.mention_count ?? 0;
    return c < 2;
  });

  const lines: string[] = [];

  if (highFreq.length > 0) {
    const items = highFreq
      .slice(0, 8)
      .map((f) => {
        const reason = f.source_reason ? ` (${f.source_reason.slice(0, 30)})` : "";
        return `${f.name}${reason}`;
      })
      .join(", ");
    lines.push(`├─ 高频出现 (≥3次, ${highFreq.length}): ${items}`);
  }
  if (midFreq.length > 0) {
    const items = midFreq
      .slice(0, 5)
      .map((f) => `${f.name}(${f.mention_count}次)`)
      .join(", ");
    lines.push(`├─ 中频出现 (2次, ${midFreq.length}): ${items}`);
  }
  if (lowFreq.length > 0) {
    const items = lowFreq
      .slice(0, 5)
      .map((f) => f.name)
      .join(", ");
    const overflow = lowFreq.length > 5 ? `, ...共 ${lowFreq.length} 个` : "";
    lines.push(`└─ 低频出现 (1次, ${lowFreq.length}): ${items}${overflow}`);
  }

  return lines.join("\n");
}

function formatInsightsBrief(insights: Finding[]): string {
  if (insights.length === 0) return "  (无)";
  return insights
    .slice(0, 10)
    .map((f, i) => `  ${i + 1}. [${f.category}] ${f.statement} (${f.confidence})`)
    .join("\n") +
    (insights.length > 10 ? `\n  ...共 ${insights.length} 条` : "");
}

export function buildExploringStateView(state: ExplorationState): string {
  const budget = getBudgetStatus(state);
  const lines: string[] = [
    `─── Step ${state.step_count} 探索状态 ───`,
    ``,
  ];

  // ─── 已探索实体 ───
  const visitedArr = [...state.visited.values()];
  const withEvents = visitedArr.filter((e) => e.related_events_count > 0);
  const noEvents = visitedArr.filter((e) => e.related_events_count === 0);

  const uniqueVisitedEntityIds = new Set(
    visitedArr.filter((e) => e.entity_id).map((e) => e.entity_id!)
  );

  lines.push(`已探索 ${visitedArr.length} entities (独立 entity_id: ${uniqueVisitedEntityIds.size})`);

  if (withEvents.length > 0) {
    const typeGroups = groupByType(withEvents);
    for (const [type, entities] of typeGroups) {
      lines.push(formatEntityTypeGroup(type, entities));
    }
  } else {
    lines.push("  (尚无含事件的实体)");
  }

  if (noEvents.length > 0) {
    const noEventNames = noEvents.slice(0, 5).map((e) => e.name).join(", ");
    const overflow = noEvents.length > 5 ? `, ...共 ${noEvents.length} 个` : "";
    lines.push(`无事件 (${noEvents.length}): ${noEventNames}${overflow} (已调用工具，未查到事件)`);
  }

  lines.push("");

  // ─── Frontier（提醒清单，带 reason）───
  lines.push(`frontier (待探索, ${state.frontier.length}):`);
  lines.push(formatFrontierBrief(state));

  lines.push("");

  // ─── Key Insights ───
  lines.push(`key_insights (${state.key_insights.length}):`);
  lines.push(formatInsightsBrief(state.key_insights));

  lines.push("");

  // ─── 预算 ───
  lines.push(`预算: 已用 ${state.budget.used_tokens.toLocaleString()}/${state.budget.total.toLocaleString()} | EXPLORING 剩余: ${budget.exploringRemaining.toLocaleString()}`);
  lines.push(`步数: ${state.step_count} | 策略: ${state.force_strategy ?? state.last_n_decisions[state.last_n_decisions.length - 1] ?? "expand"}`);

  if (state.mcp_degraded) {
    lines.push(`⚠ MCP 服务降级中`);
  }
  if (state.injectHint) {
    lines.push(state.injectHint);
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// FINALIZE State View
// ═══════════════════════════════════════════════════════════════

function formatFinalizeFindings(findings: Finding[]): string {
  if (findings.length === 0) return "  (无)";
  return findings
    .map((f, i) =>
      `  ${i + 1}. [${f.category}] ${f.statement} (${f.confidence})\n` +
      `     evidence: ${f.evidence.join(", ")}`,
    )
    .join("\n");
}

function formatRawEventArchive(events: RawEvent[]): string {
  if (events.length === 0) return "  (空)";

  const grouped = new Map<string, RawEvent[]>();
  for (const ev of events) {
    const list = grouped.get(ev.entity) ?? [];
    list.push(ev);
    grouped.set(ev.entity, list);
  }

  const typeLabel: Record<string, string> = {
    structural_fact: "事实",
    aggregate_metric: "指标",
    streaming_snapshot: "快照",
    unknown: "未知",
  };

  const lines: string[] = [];
  for (const [entity, evts] of grouped) {
    lines.push(`  ${entity}:`);
    for (const ev of evts) {
      const tag = typeLabel[ev.event_data_type] ?? "?";
      lines.push(`    - [${ev.ku_id}] [${tag}] ${ev.timestamp}: ${ev.event_type} — ${ev.description.slice(0, 100)}`);
    }
  }
  lines.push(`  (共 ${events.length} 个事件)`);
  return lines.join("\n");
}

function formatExplorationLog(log: ExplorationState["exploration_log"]): string {
  if (log.length === 0) return "  (无)";

  return log
    .map((entry) => {
      const extra = entry.strategy_switch
        ? ` [策略切换: ${entry.strategy_switch.from}→${entry.strategy_switch.to}]`
        : "";
      return `  Step ${entry.step}: decision=${entry.decision}, tools=${entry.tool_calls_count}, findings=${entry.new_findings_count}${extra}`;
    })
    .join("\n");
}

function formatClusterFlagsForFinalize(flags: ClusterFlag[]): string {
  if (flags.length === 0) return "";
  const lines: string[] = ["", "─── 数据质量标记 ───"];
  for (const flag of flags) {
    lines.push(`  [${flag.cluster_id}] ${flag.flag_type}: ${flag.description}`);
  }
  return lines.join("\n") + "\n";
}

export function buildFinalizeStateView(state: ExplorationState): string {
  const lines: string[] = [
    `─── FINALIZE 阶段 ───`,
    ``,
    `以下是你探索阶段积累的全部数据。不再调用工具，集中输出。`,
    ``,
    `【key_insights — 全部】`,
    formatFinalizeFindings(state.key_insights),
    ``,
    `【raw_event_archive — 全部原始事件，按实体分组】`,
    formatRawEventArchive(state.raw_event_archive),
    ``,
    `【exploration_log】`,
    formatExplorationLog(state.exploration_log),
  ];

  // entity_flags & cluster_flags
  const entityFlagsText = formatEntityFlags(state.entity_flags);
  if (entityFlagsText) {
    lines.push(entityFlagsText);
  }

  const clusterFlagsText = formatClusterFlagsForFinalize(state.cluster_flags);
  if (clusterFlagsText) {
    lines.push(clusterFlagsText);
  }

  return lines.join("\n");
}

// ═══════════════════════════════════════════════════════════════
// 上下文组装入口
// ═══════════════════════════════════════════════════════════════

export interface AssembledContext {
  systemPrompt: string;
  stateView: string;
  goalMessage: string;
  totalEstimatedTokens: number;
}

export function assembleContext(
  state: ExplorationState,
  systemPrompt: string,
  goal: string,
  seedEntities: string[],
  timeRange?: string,
): AssembledContext {
  const stateView =
    state.phase === "EXPLORING"
      ? buildExploringStateView(state)
      : buildFinalizeStateView(state);

  const timeRangeLine = timeRange ? `\n时间范围: ${timeRange}` : "";

  const goalMessage =
    state.phase === "EXPLORING"
      ? `探索目标: ${goal}${timeRangeLine}\n\n起始实体: ${seedEntities.join(", ")}`
      : `探索目标: ${goal}${timeRangeLine}`;

  const totalText = [systemPrompt, stateView, goalMessage].join("\n");
  const totalEstimatedTokens = estimateTokens(totalText);

  return {
    systemPrompt,
    stateView,
    goalMessage,
    totalEstimatedTokens,
  };
}

// ═══════════════════════════════════════════════════════════════
// 兜底压缩：上下文 > 85% → 合并 exploration_log 相似轮次
// 还超 → 由 loop.ts 触发 FINALIZE
// ═══════════════════════════════════════════════════════════════

export function compressExplorationLog(log: ExplorationState["exploration_log"]): ExplorationState["exploration_log"] {
  if (log.length <= 3) return log;

  const compressed: ExplorationState["exploration_log"] = [];
  let i = 0;
  while (i < log.length) {
    const current = log[i];
    // 合并连续相同 decision 的步骤
    let j = i + 1;
    while (
      j < log.length &&
      log[j].decision === current.decision &&
      log[j].phase === current.phase
    ) {
      j++;
    }
    if (j - i > 1) {
      compressed.push({
        ...current,
        tool_calls_count: log.slice(i, j).reduce((s, e) => s + e.tool_calls_count, 0),
        new_findings_count: log.slice(i, j).reduce((s, e) => s + e.new_findings_count, 0),
      });
    } else {
      compressed.push(current);
    }
    i = j;
  }
  return compressed;
}
