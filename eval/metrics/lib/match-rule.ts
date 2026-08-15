// Finding 匹配：三层架构（alias cache / rule pre-filter / LLM-as-Judge）
// + Thread 子序列判定 + 关键词 token 化。
// 完全自实现 finding 匹配的核心逻辑；LLM 调用委托给 llm-judge.ts。
//
// 设计文档：docs/superpowers/specs/2026-07-20-eval-llm-judge-design.md
import type { AgentFindingView, AgentThreadView, KnownFinding, KnownThread } from "../../types.js";
import { judgeFindingPair, makeCacheKey, JudgeError } from "./llm-judge.js";
import { appendJudgeCall } from "./judge-cache.js";

// ─── token 化（中文 bigram + 标点切分，不引入分词库）───
export function tokenize(text: string): string[] {
  if (!text) return [];
  // 按标点和空格切成段
  const segments = text.split(/[\s,，。；;:：!！?？()（）\[\]【】"'`'']/).filter(Boolean);
  const tokens: string[] = [];
  for (const seg of segments) {
    if (/^[A-Za-z0-9]+$/.test(seg)) {
      // 英文/数字段：整体作为一个 token（小写化）
      tokens.push(seg.toLowerCase());
    } else {
      // 中文段：单字 bigram
      const chars = [...seg];
      for (let i = 0; i < chars.length - 1; i++) {
        tokens.push(chars[i] + chars[i + 1]);
      }
      // 单字也保留（长度 1 的段）
      if (chars.length === 1) tokens.push(chars[0]);
    }
  }
  return tokens;
}

// ─── 实体 Jaccard ───
export function entityJaccard(a: string[], b: string[]): number {
  const setA = new Set(a.map((s) => s.trim()).filter(Boolean));
  const setB = new Set(b.map((s) => s.trim()).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ─── 关键词重叠率 ───
export function keywordOverlap(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter += 1;
  const minLen = Math.min(setA.size, setB.size);
  return minLen === 0 ? 0 : inter / minLen;
}

// ─── Finding 命中判定（含 aliases 扩展）───
export interface FindingMatchResult {
  matched: boolean;
  matched_finding_id: string | null;
  rule_scores: { jaccard: number; keyword_overlap: number; category_match: boolean };
}

export interface MatchContext {
  /** run 目录下的 scenario 子目录，用于写 judge cache 文件。run 模式下必填 */
  scenarioDir: string | null;
  /** false = 只用 rule pre-filter（兼容旧模式，等价于 PR #4 的 rule matching）；true = 启用 LLM judge */
  useLlmJudge: boolean;
  /** true = 忽略磁盘 cache 强制重调 LLM（debug 用） */
  noJudgeCache: boolean;
  /** 当前 GT 的 scenario id（写入 cache 记录用） */
  scenarioId: string;
}

// 扩展 MatchResult：带 verdict + judge 来源（用于 audit-pending 区分）
export interface FindingMatchResult {
  matched: boolean;                // true = match 或 partial；false = no_match
  verdict: "match" | "partial" | "no_match";
  matched_finding_id: string | null;
  rule_scores: { jaccard: number; keyword_overlap: number; category_match: boolean };
  /** 判定来自哪一层：alias / rule_prefilter_no / llm_judge / llm_judge_failed */
  source: "alias" | "rule_prefilter_no" | "llm_judge" | "llm_judge_failed";
  /** LLM judge 给出的理由（仅 source=llm_judge 时有） */
  reason?: string;
  /** LLM judge 是否应回填 alias（仅 match/partial 时为 true） */
  shouldBackfillAlias: boolean;
}

export async function matchFinding(
  gt: KnownFinding,
  agentFindings: AgentFindingView[],
  ctx: MatchContext,
): Promise<FindingMatchResult> {
  const noMatch: FindingMatchResult = {
    matched: false, verdict: "no_match", matched_finding_id: null,
    rule_scores: { jaccard: 0, keyword_overlap: 0, category_match: false },
    source: "rule_prefilter_no", shouldBackfillAlias: false,
  };
  if (agentFindings.length === 0) return noMatch;

  // 加载磁盘 cache（仅 LLM judge 模式且未禁用 cache 时）
  let cache: Map<string, import("./llm-judge.js").JudgeCallRecord> | null = null;
  if (ctx.useLlmJudge && !ctx.noJudgeCache && ctx.scenarioDir) {
    const { loadJudgeCache } = await import("./judge-cache.js");
    cache = loadJudgeCache(ctx.scenarioDir);
  }

  // 遍历 agent findings，找最佳匹配。一旦 match/partial 立即返回。
  let bestCandidate: FindingMatchResult | null = null;
  for (const f of agentFindings) {
    const categoryMatch = f.category === gt.category;
    const jaccard = entityJaccard(gt.key_entities, f.entities_involved);
    const scores = { jaccard, keyword_overlap: 0, category_match: categoryMatch };
    const evidencePass = f.evidence.length >= gt.min_evidence;

    // ─── Layer 0: Alias 缓存 ───
    const aliases = (gt.aliases ?? []).filter((a) => a && !a.startsWith("finding_"));
    if (aliases.length > 0) {
      const aliasTextMatch = aliases.some((alias) => keywordOverlap(alias, f.statement) >= 0.5);
      const entityAliasMatch = aliases.some((alias) =>
        f.entities_involved.some((e) => e.includes(alias) || alias.includes(e)),
      );
      if ((aliasTextMatch || entityAliasMatch) && evidencePass) {
        return {
          matched: true, verdict: "match", matched_finding_id: f.id,
          rule_scores: { jaccard, keyword_overlap: aliasTextMatch ? 1 : scores.keyword_overlap, category_match: categoryMatch },
          source: "alias", shouldBackfillAlias: false,  // 已经在 alias 里，不重复回填
        };
      }
    }

    // ─── Layer 1: Rule pre-filter ───
    // 实体 Jaccard ≥ 0.2 AND (category 相同 OR 实体重合 ≥ 0.5) AND evidence ≥ min
    const prefilterPass = jaccard >= 0.2 && (categoryMatch || jaccard >= 0.5) && evidencePass;
    if (!prefilterPass) {
      // pre-filter 淘汰：记录为候选（用于 audit-pending），但不是命中
      if (!bestCandidate || scores.jaccard > bestCandidate.rule_scores.jaccard) {
        bestCandidate = {
          matched: false, verdict: "no_match", matched_finding_id: f.id,
          rule_scores: scores, source: "rule_prefilter_no", shouldBackfillAlias: false,
        };
      }
      continue;
    }

    // ─── Layer 2a: 兼容模式（不调 LLM）── 用旧 rule matching（kw≥0.6）
    if (!ctx.useLlmJudge) {
      const maxKw = keywordOverlap(gt.statement, f.statement);
      scores.keyword_overlap = maxKw;
      if (categoryMatch && jaccard >= 0.5 && maxKw >= 0.6) {
        return {
          matched: true, verdict: "match", matched_finding_id: f.id,
          rule_scores: scores, source: "llm_judge" /* 兼容字段 */, shouldBackfillAlias: false,
        };
      }
      if (!bestCandidate || scores.jaccard > bestCandidate.rule_scores.jaccard) {
        bestCandidate = {
          matched: false, verdict: "no_match", matched_finding_id: f.id,
          rule_scores: scores, source: "rule_prefilter_no", shouldBackfillAlias: false,
        };
      }
      continue;
    }

    // ─── Layer 2b: LLM judge ───
    scores.keyword_overlap = keywordOverlap(gt.statement, f.statement);
    const cacheKey = makeCacheKey({
      gt_statement: gt.statement, gt_category: gt.category, gt_key_entities: gt.key_entities,
      agent_statement: f.statement, agent_category: f.category, agent_entities: f.entities_involved,
    });

    // 先查磁盘 cache
    if (cache && !ctx.noJudgeCache) {
      const { lookupCache } = await import("./judge-cache.js");
      const cached = lookupCache(cache, cacheKey);
      if (cached) {
        const matched = cached.verdict === "match" || cached.verdict === "partial";
        if (matched) {
          return {
            matched: true, verdict: cached.verdict, matched_finding_id: f.id,
            rule_scores: scores, source: "llm_judge", reason: cached.reason,
            shouldBackfillAlias: false,  // cache 命中说明之前已回填过（或这层不重复回填）
          };
        }
        // cache 里是 no_match：记录候选，继续找下一个
        if (!bestCandidate || scores.jaccard > bestCandidate.rule_scores.jaccard) {
          bestCandidate = {
            matched: false, verdict: "no_match", matched_finding_id: f.id,
            rule_scores: scores, source: "llm_judge", reason: cached.reason, shouldBackfillAlias: false,
          };
        }
        continue;
      }
    }

    // cache miss：调 LLM
    try {
      const { result, tokensUsed } = await judgeFindingPair({
        gt_statement: gt.statement, gt_category: gt.category, gt_key_entities: gt.key_entities,
        agent_statement: f.statement, agent_category: f.category, agent_entities: f.entities_involved,
      });
      // 写 cache
      if (ctx.scenarioDir) {
        const { appendJudgeCall } = await import("./judge-cache.js");
        const { readConfig } = await import("../../../src/agent/config.js");
        appendJudgeCall(ctx.scenarioDir, {
          cache_key: cacheKey, gt_id: gt.id, agent_finding_id: f.id,
          category_match: categoryMatch, jaccard,
          verdict: result.verdict, reason: result.reason,
          model: readConfig().llm.model, timestamp: new Date().toISOString(),
          tokens_used: tokensUsed,
        });
      }
      if (result.verdict === "match" || result.verdict === "partial") {
        return {
          matched: true, verdict: result.verdict, matched_finding_id: f.id,
          rule_scores: scores, source: "llm_judge", reason: result.reason,
          shouldBackfillAlias: true,  // 让调用方把 agent statement 写入 gt.aliases
        };
      }
      // LLM 判 no_match：继续找下一个 finding
      if (!bestCandidate || scores.jaccard > bestCandidate.rule_scores.jaccard) {
        bestCandidate = {
          matched: false, verdict: "no_match", matched_finding_id: f.id,
          rule_scores: scores, source: "llm_judge", reason: result.reason, shouldBackfillAlias: false,
        };
      }
    } catch (err) {
      // LLM 失败（重试后仍失败）：写 audit-pending，记录为 judge_failed
      if (!bestCandidate || scores.jaccard > bestCandidate.rule_scores.jaccard) {
        bestCandidate = {
          matched: false, verdict: "no_match", matched_finding_id: f.id,
          rule_scores: scores, source: "llm_judge_failed",
          reason: (err as Error).message, shouldBackfillAlias: false,
        };
      }
    }
  }
  return bestCandidate ?? noMatch;
}

// ─── "近似候选"判定（用于 audit-pending）───
export function isApproximateCandidate(scores: { jaccard: number; keyword_overlap: number; category_match: boolean }): boolean {
  // 未达命中阈值但有信号：Jaccard ≥ 0.3，或 category 相同且 keyword_overlap ≥ 0.3
  return scores.jaccard >= 0.3 || (scores.category_match && scores.keyword_overlap >= 0.3);
}

// ─── Thread 子序列判定（gt key_events 是 agent thread_events 的子序列）───
export type ThreadMatchKind = "full" | "partial" | "mismatch";

export function matchThread(gt: KnownThread, agentThread: AgentThreadView): ThreadMatchKind {
  const gtKuIds = gt.key_events.map((e) => e.ku_id);
  const agentKuIds = agentThread.thread_event_ku_ids;

  // 判定 gt key_events 是否为 agent 的子序列，并统计覆盖数
  const coverage = subsequenceCoverage(gtKuIds, agentKuIds);

  // 因果方向：检查 agent 的关系类型分布是否与 gt.causal_direction 一致
  // forward：主要关系应为 causal/temporal；reverse：视为方向不符
  // 简化：只要 agent 有 ≥1 个 causal/temporal 关系即视为方向 OK（精确方向对比留待后续）
  const hasCausal = agentThread.relationships.some(
    (r) => r.type === "causal" || r.type === "temporal",
  );
  const directionOk = gt.causal_direction === "forward" ? hasCausal : true;  // reverse 暂不严格校验

  if (coverage.count === gtKuIds.length && coverage.subsequence && directionOk) {
    return "full";
  }
  // partial 要求 subsequence（顺序不颠倒）——spec §3.3：
  // "gt key_events 不是 agent thread 的子序列（顺序颠倒）" → mismatch
  if (coverage.subsequence && coverage.count >= Math.ceil((gtKuIds.length * 2) / 3) && directionOk) {
    return "partial";
  }
  return "mismatch";
}

// 返回（已存在的 gt 元素是否作为 agent 的子序列出现）以及已存在的元素数
// "subsequence" 的含义：gt 中那些实际出现在 agent 里的元素，它们的相对顺序在 agent 中保持。
// 缺失元素不算破坏顺序（那是 partial 的覆盖问题，不是顺序问题）。
// 顺序颠倒（如 gt=[A,B,C] agent=[A,C,B]）才破坏 subsequence。
function subsequenceCoverage(gtIds: string[], agentIds: string[]): { subsequence: boolean; count: number } {
  const agentSet = new Set(agentIds);
  // 只保留 gt 中存在于 agent 的元素，保持 gt 原序
  const present = gtIds.filter((g) => agentSet.has(g));
  let count = present.length;
  if (present.length === 0) return { subsequence: false, count: 0 };

  // 判定 present 是否为 agentIds 的子序列（标准贪心算法）
  let agentIdx = 0;
  let subsequence = true;
  for (const g of present) {
    const foundAt = agentIds.indexOf(g, agentIdx);
    if (foundAt === -1) {
      subsequence = false;
      break;
    }
    agentIdx = foundAt + 1;
  }
  return { subsequence, count };
}
