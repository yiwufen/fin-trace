// LLM-as-Judge：判断 agent finding 是否实质性回答了 GT 要求的结论。
// 这是评测代码接触 LLM 的唯一模块（spec §6.1 第三个稳定入口点）。
//
// 设计要点（见 docs/superpowers/specs/2026-07-20-eval-llm-judge-design.md）：
// - 强制 GT-first 视角（"GT 辩护人"），缓解 agent/judge 同模型的自评偏置
// - temperature=0，确定性解码
// - 输出 JSON：{verdict, reason}，便于程序解析 + 人工抽查
// - 失败重试 1 次 → 仍失败 → 抛错（由调用方决定 audit-pending 兜底）

import { createLlmClient } from "../../../src/llm/client.js";
import { readConfig } from "../../../src/agent/config.js";
import { createHash } from "node:crypto";

export interface JudgeInput {
  gt_statement: string;
  gt_category: string;
  gt_key_entities: string[];
  agent_statement: string;
  agent_category: string;
  agent_entities: string[];
}

export type JudgeVerdict = "match" | "partial" | "no_match";

export interface JudgeResult {
  verdict: JudgeVerdict;
  reason: string;
}

// cache 文件里一行记录的完整结构（比 JudgeResult 多元数据）
export interface JudgeCallRecord extends JudgeResult {
  cache_key: string;
  gt_id: string;
  agent_finding_id: string;
  category_match: boolean;
  jaccard: number;
  model: string;
  timestamp: string;
  tokens_used: number;
}

// ─── Cache key ───
// 基于内容 hash，与 finding_id 无关 —— 跨 run 稳定
export function makeCacheKey(input: JudgeInput): string {
  const payload = [
    input.gt_statement,
    input.agent_statement,
    input.gt_category,
    input.agent_category,
  ].join("\n---\n");
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

// ─── Prompt 构造 ───
// 注意 GT-first 顺序：先呈现 GT，让 LLM 以"GT 辩护人"视角判断 agent 是否回答了 GT 的问题
function buildPrompt(input: JudgeInput): string {
  return `你是一名严格的金融分析师评审。判断 Agent 的 finding 是否实质性回答了 GT 要求的结论。

【Ground Truth（本应发现什么）】
statement: ${input.gt_statement}
category: ${input.gt_category}
key_entities: ${input.gt_key_entities.join(", ")}

【Agent Finding 候选】
statement: ${input.agent_statement}
category: ${input.agent_category}
entities_involved: ${input.agent_entities.join(", ")}

判断标准：
- match: Agent 的 finding 实质性回答了 GT 的核心结论（措辞/细节/侧重不同可接受）
- partial: Agent 的 finding 方向对、与 GT 主题相关，但只覆盖了 GT 要求的一部分
- no_match: Agent 的 finding 答非所问、方向相反，或与 GT 完全不相关

注意：不要因为 Agent 的措辞不同于 GT 就判 no_match；关注核心结论是否被回答。
注意：你是 GT 的辩护人——你的任务是判断 Agent 有没有回答 GT 问的问题，而不是反过来。

只输出 JSON，不要其他文字：
{"verdict": "match|partial|no_match", "reason": "一句话理由"}`;
}

// ─── JSON 解析（容忍 LLM 输出前后多余的文本）───
function parseJudgeJson(raw: string): JudgeResult {
  // 尝试直接解析
  try {
    const obj = JSON.parse(raw);
    return normalizeVerdict(obj);
  } catch {
    // 失败：尝试从文本里抽取最外层的 {...}
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const obj = JSON.parse(match[0]);
        return normalizeVerdict(obj);
      } catch {
        // 继续抛
      }
    }
  }
  throw new Error(`无法解析 LLM judge 输出为 JSON: ${raw.slice(0, 200)}`);
}

function normalizeVerdict(obj: unknown): JudgeResult {
  if (typeof obj !== "object" || obj === null) {
    throw new Error("LLM judge 输出不是对象");
  }
  const o = obj as { verdict?: string; reason?: string };
  const verdict = o.verdict;
  if (verdict !== "match" && verdict !== "partial" && verdict !== "no_match") {
    throw new Error(`LLM judge verdict 不合法: ${verdict}`);
  }
  return {
    verdict,
    reason: typeof o.reason === "string" ? o.reason : "",
  };
}

// ─── 从 Message 提取文本 ───
function extractText(content: { type: string; text?: string }[]): string {
  const textBlocks = content.filter((b) => b.type === "text" && typeof b.text === "string");
  return textBlocks.map((b) => b.text as string).join("\n");
}

// ─── 单次调用 LLM ───
async function callLlmOnce(prompt: string): Promise<{ text: string; tokensUsed: number }> {
  const client = createLlmClient();
  const config = readConfig();
  const response = await client.messages.create({
    model: config.llm.model,
    max_tokens: 200,
    system: "你是严格的金融分析师评审，只输出 JSON。",
    messages: [{ role: "user", content: prompt }],
  });
  if (process.env.EVAL_JUDGE_DEBUG) {
    console.error("[judge] response.content:", JSON.stringify(response.content));
    console.error("[judge] response.usage:", JSON.stringify(response.usage));
  }
  const text = extractText(response.content as { type: string; text?: string }[]);
  const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);
  return { text, tokensUsed };
}

// ─── 主入口：判定一对 (GT, agent) ───
// 失败处理：第一次失败 → 重试 1 次 → 仍失败 → 抛 JudgeError（由调用方捕获并写入 audit-pending）
export class JudgeError extends Error {
  constructor(message: string, public readonly lastOutput: string) {
    super(message);
    this.name = "JudgeError";
  }
}

export async function judgeFindingPair(input: JudgeInput): Promise<{ result: JudgeResult; tokensUsed: number }> {
  const prompt = buildPrompt(input);

  let lastError: Error | null = null;
  let lastOutput = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { text, tokensUsed } = await callLlmOnce(prompt);
      lastOutput = text;
      const result = parseJudgeJson(text);
      return { result, tokensUsed };
    } catch (err) {
      lastError = err as Error;
      // 重试前等一小段（避免连续打）
      if (attempt === 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new JudgeError(
    `LLM judge 失败（重试 1 次后仍失败）: ${lastError?.message ?? "unknown"}`,
    lastOutput,
  );
}
