// 规则匹配：finding 命中判定 + thread 子序列判定 + 关键词 token 化。
// 完全自实现，不 import src/agent/findings.ts。
import type { AgentFindingView, AgentThreadView, KnownFinding, KnownThread } from "../../types.js";

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

export function matchFinding(
  gt: KnownFinding,
  agentFindings: AgentFindingView[],
): FindingMatchResult {
  let best: FindingMatchResult = {
    matched: false,
    matched_finding_id: null,
    rule_scores: { jaccard: 0, keyword_overlap: 0, category_match: false },
  };

  for (const f of agentFindings) {
    // alias 是人工裁决回填的"语义等价表述"（agent finding 的 statement 文本）。
    // 设计要点（Bug 2 修复, 2026-07-19）：alias 必须是 TEXT 而非 finding_id UUID——
    // UUID 每次 run 都变（agent 用随机 UUID 生成 finding.id），跨 run 失效；
    // statement 文本则只要 agent 还在表达同样的核心含义就会再次出现。
    const aliases = (gt.aliases ?? []).filter((a) => a && !a.startsWith("finding_"));
    const hasAlias = aliases.length > 0;

    const categoryMatch = f.category === gt.category;
    const jaccard = entityJaccard(gt.key_entities, f.entities_involved);

    // keyword overlap：考虑 gt.statement + aliases
    // alias 是历史 run 中被人工判定等价的 agent 表述，把它一起纳入关键词比对
    const gtTexts = [gt.statement, ...aliases];
    let maxKw = 0;
    for (const t of gtTexts) {
      maxKw = Math.max(maxKw, keywordOverlap(t, f.statement));
    }
    // alias 也可能是实体表述（短 alias 如"台积电"），与 agent entities 比对
    const entityAliasMatch = aliases.some((alias) =>
      f.entities_involved.some((e) => e.includes(alias) || alias.includes(e)),
    );
    // 关键：alias 与当前 finding 的高文本相似度 → 视为人工已认定等价的复发
    // （alias 自己就是历史 agent 表述；如果当前 finding 接近它，说明 agent 又说了同样的话）
    const aliasTextMatch = hasAlias && aliases.some((alias) => keywordOverlap(alias, f.statement) >= 0.5);

    // 命中条件：
    //   常规：category + Jaccard≥0.5 + kw≥0.6 + evidence≥min_evidence
    //   entity alias 放宽 Jaccard：alias 实体匹配 → Jaccard 通过
    //   alias 文本复发：alias 与 finding 高度相似 → 整体命中（绕过 kw 阈值）
    //     （因为 alias 是历史 run 已认定等价的表述，复发时若措辞仍接近就应算命中）
    const jaccardPass = jaccard >= 0.5 || entityAliasMatch;
    const kwPass = maxKw >= 0.6;
    const evidencePass = f.evidence.length >= gt.min_evidence;
    const matched = evidencePass && (
      aliasTextMatch || (categoryMatch && jaccardPass && kwPass)
    );

    const scores = { jaccard, keyword_overlap: maxKw, category_match: categoryMatch };

    // 记录最高分（用于 audit-pending 判定）
    if (matched && !best.matched) {
      best = { matched: true, matched_finding_id: f.id, rule_scores: scores };
    } else if (!best.matched && (scores.jaccard > best.rule_scores.jaccard || scores.keyword_overlap > best.rule_scores.keyword_overlap)) {
      best = { matched: false, matched_finding_id: f.id, rule_scores: scores };
    }
  }
  return best;
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
