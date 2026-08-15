// LLM judge 调用的磁盘缓存。
// 存储路径：eval/runs/<run-id>/<scenario>/llm-judge-calls.jsonl（每行一次调用）
//
// 缓存策略（spec §三）：
// - 默认读：同 cache_key 命中 → 直接用 cache 里的 verdict，不调 LLM
// - alias 优先：Layer 0 命中的不进 cache（GT yaml 的 aliases 才是跨 run 的真正缓存）
// - --no-judge-cache flag：强制全部重新调 LLM（debug 用）
import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { JudgeCallRecord, JudgeVerdict } from "./llm-judge.js";

const CACHE_FILENAME = "llm-judge-calls.jsonl";

function cachePath(scenarioDir: string): string {
  return resolve(scenarioDir, CACHE_FILENAME);
}

// 读某 scenario 的所有 cache 记录，按 cache_key 索引
export function loadJudgeCache(scenarioDir: string): Map<string, JudgeCallRecord> {
  const map = new Map<string, JudgeCallRecord>();
  const path = cachePath(scenarioDir);
  if (!existsSync(path)) return map;
  const raw = readFileSync(path, "utf-8");
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as JudgeCallRecord;
      if (rec.cache_key) map.set(rec.cache_key, rec);
    } catch {
      // 损坏行跳过（不阻断整体流程）
    }
  }
  return map;
}

// 追加一条 cache 记录（不重写整个文件，避免覆盖其他记录）
export function appendJudgeCall(scenarioDir: string, record: JudgeCallRecord): void {
  const path = cachePath(scenarioDir);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}

// 从 cache 查 verdict（返回 null = miss）
export function lookupCache(
  cache: Map<string, JudgeCallRecord>,
  cacheKey: string,
): { verdict: JudgeVerdict; reason: string; model: string } | null {
  const rec = cache.get(cacheKey);
  if (!rec) return null;
  return { verdict: rec.verdict, reason: rec.reason, model: rec.model };
}
