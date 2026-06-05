// 异常处理 — v3: 适配新类型（移除 recall 工具引用）

import type { ExplorationState, ExplorationOutput } from "./state.js";
import { MCP_TOOL_NAMES } from "./tools.js";

// ─── 实体名变体（空结果重试）───

const NAME_VARIANTS: Record<string, string[]> = {
  "宁德时代": ["宁德时代新能源", "CATL"],
  "比亚迪": ["比亚迪股份", "比亚迪汽车"],
};

function tryNameVariants(entity: string, state?: ExplorationState): string[] {
  if (state) {
    const resolved = state.nameIndex.get(entity);
    if (resolved && resolved !== entity) return [resolved];
  }
  const variants = NAME_VARIANTS[entity] ?? [];
  variants.push(entity.replace(/[（(].*?[)）]/g, ""));
  variants.push(
    entity.replace(/股份|集团|有限|公司|汽车/g, ""),
  );
  return [...new Set(variants)].filter((v) => v !== entity && v.length > 0);
}

export { tryNameVariants };

// ─── LLM 输出格式修复 ───

export interface LLMOutput {
  reasoning?: string;
  decision?: string;
  tool_calls?: ToolCallCandidate[];
  new_findings?: unknown[];
  phase?: string;
  key_findings?: unknown[];
  threads?: unknown[];
  exploration_complete?: boolean;
}

export interface ToolCallCandidate {
  tool: string;
  args: Record<string, unknown>;
}

export function fixLLMOutput(raw: string): LLMOutput | null {
  let text = raw.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  text = text.slice(start, end + 1);

  try {
    return JSON.parse(text) as LLMOutput;
  } catch {
    text = text
      .replace(/'/g, '"')
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");
    try {
      return JSON.parse(text) as LLMOutput;
    } catch {
      return null;
    }
  }
}

// ─── 工具调用验证 ───

const VALID_TOOLS = new Set<string>(MCP_TOOL_NAMES);

export function validateToolCalls(
  calls: ToolCallCandidate[],
  knownClusters: Set<string>,
): ToolCallCandidate[] {
  const valid: ToolCallCandidate[] = [];

  for (const call of calls) {
    if (!VALID_TOOLS.has(call.tool)) continue;

    // hops > 1 → 钳制到 1
    if (typeof call.args.hops === "number" && call.args.hops > 1) {
      call.args.hops = 1;
    }

    // expand 的 cluster_id 必须已知
    if (call.tool === "expand") {
      const ids = call.args.cluster_ids;
      if (Array.isArray(ids)) {
        const known = ids.filter(
          (id: unknown) => typeof id === "string" && knownClusters.has(id),
        );
        if (known.length === 0) continue;
        call.args.cluster_ids = known;
      }
    }

    valid.push(call);
  }

  return valid;
}

// ─── 决策验证 ───

const VALID_DECISIONS = ["expand", "deep_dive", "verify", "sufficient", "stalemate"];

export function validateDecision(decision: string): string {
  if (VALID_DECISIONS.includes(decision)) return decision;

  if (decision.includes("expand")) return "expand";
  if (decision.includes("dive")) return "deep_dive";
  if (decision.includes("verif")) return "verify";
  if (decision.includes("sufficient")) return "sufficient";
  if (decision.includes("stale")) return "stalemate";

  return "expand";
}

// ─── 决策循环检测 ───

export function detectDecisionLoop(state: ExplorationState): boolean {
  if (state.last_n_decisions.length < 4) return false;

  const last4 = state.last_n_decisions.slice(-4);
  const allSame = last4.every((d) => d === last4[0]);
  if (!allSame) return false;

  const findingCounts = state.last_n_finding_counts.slice(-4);
  const noGrowth = findingCounts.every(
    (c, i) => i === 0 || c === findingCounts[i - 1],
  );

  return noGrowth;
}

export function applyLoopBreak(state: ExplorationState): void {
  const lastDecision = state.last_n_decisions[state.last_n_decisions.length - 1];

  if (lastDecision === "expand") {
    state.force_strategy = state.frontier.length > 0
      ? "deep_dive"
      : "verify";
  } else if (lastDecision === "deep_dive") {
    state.force_strategy = "verify";
  } else {
    state.force_sufficient = true;
  }
}

// ─── reliability_note 生成 ───

export function generateReliabilityNote(state: ExplorationState): string | null {
  const notes: string[] = [];

  if (state.reliability_note) notes.push(state.reliability_note);

  if (state.mcp_degraded) notes.push("部分 MCP 调用失败，数据可能不完整");
  if (state.force_sufficient) notes.push("探索被强制终止（决策循环检测）");
  if (state.token_warnings > 0)
    notes.push(
      `token 预算紧张时结束探索 (${state.budget.used_tokens}/${state.budget.total})`,
    );
  if (state.tool_call_failures > 0)
    notes.push(`${state.tool_call_failures} 次工具调用失败后跳过`);

  return notes.length > 0 ? notes.join("；") : null;
}

// ─── completion_reason 判定 ───

const MAX_EXPLORING_STEPS = 20;

export function determineCompletionReason(
  state: ExplorationState,
): ExplorationOutput["exploration_meta"]["completion_reason"] {
  const decision = state.last_n_decisions[state.last_n_decisions.length - 1];

  if (decision === "sufficient") return "sufficient";

  if (state.budget.used_tokens >= state.budget.exploring_limit) return "token_budget";
  if (state.step_count >= MAX_EXPLORING_STEPS) return "depth_exhausted";
  if (state.frontier.length === 0) return "frontier_empty";

  return "diminishing_returns";
}
