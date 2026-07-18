// 渲染 audit-pending.json → worksheet.md（YAML front-matter + Markdown 表格）
// 解析 worksheet.md front-matter → 回填 ground-truth aliases
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { load as yamlLoad, dump as yamlDump } from "js-yaml";
import type { AuditPending, GroundTruth } from "../types.js";

const JUDGMENTS_DIR = resolve(import.meta.dirname, "../judgments");

interface WorksheetVerdict {
  gt_id: string;
  candidate_finding_id: string | null;
  verdict: "unjudged" | "match" | "no_match" | "partial";
}

interface WorksheetFrontMatter {
  run_id: string;
  scenario: string;
  rendered_at: string;
  verdicts: WorksheetVerdict[];
}

export function renderWorksheet(audit: AuditPending, runId: string, scenarioId: string): string {
  const fm: WorksheetFrontMatter = {
    run_id: runId,
    scenario: scenarioId,
    rendered_at: new Date().toISOString(),
    verdicts: audit.items.map((it) => ({
      gt_id: it.gt_id,
      candidate_finding_id: it.candidate_finding_id,
      verdict: "unjudged",
    })),
  };

  const fmYaml = yamlDump(fm, { lineWidth: 120 });
  const body = renderBody(audit);
  return `---\n${fmYaml}---\n\n${body}\n`;
}

function renderBody(audit: AuditPending): string {
  if (audit.items.length === 0) {
    return `# Annotation Worksheet — ${audit.scenario}\n\n（无待裁决项。所有 known_findings 都已被规则匹配命中。）\n`;
  }
  const lines: string[] = [];
  lines.push(`# Annotation Worksheet — ${audit.scenario}`);
  lines.push("");
  lines.push("## 待裁决项");
  lines.push("");
  lines.push("> 在 YAML front-matter（文件顶部 --- 之间）把对应 verdict 字段从 unjudged 改为 match / no_match / partial。然后跑 `npx tsx eval/cli.ts judge <scenario> --commit`。");
  lines.push("");
  for (const it of audit.items) {
    lines.push(`### ${it.gt_id}（${it.gt_importance}）`);
    lines.push(`- GT statement: ${it.gt_statement}`);
    if (it.candidate_finding_id) {
      lines.push(`- 近似候选 ${it.candidate_finding_id}（rule scores: jaccard=${it.rule_scores.jaccard.toFixed(2)}, keyword=${it.rule_scores.keyword_overlap.toFixed(2)}, category_match=${it.rule_scores.category_match}）`);
    } else {
      lines.push(`- 无近似候选（规则完全未命中）`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function writeWorksheet(scenarioId: string, content: string): string {
  const dir = resolve(JUDGMENTS_DIR, scenarioId);
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, "worksheet.md");
  writeFileSync(path, content, "utf-8");
  return path;
}

// 解析 worksheet.md 的 front-matter
export function parseWorksheet(scenarioId: string): WorksheetFrontMatter | null {
  const path = resolve(JUDGMENTS_DIR, scenarioId, "worksheet.md");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  try {
    return yamlLoad(m[1]) as WorksheetFrontMatter;
  } catch {
    return null;
  }
}

// 把裁决回填到 ground-truth yaml 的 aliases 字段
// 规则：verdict=match 或 partial → 把 candidate_finding_id 作为 alias 加入对应 known_finding
export function applyVerdictsToGroundTruth(
  scenarioId: string,
  verdicts: WorksheetVerdict[],
  currentGt: GroundTruth,
): GroundTruth {
  // 构建 gt_id → finding 查找
  const gtMap = new Map(currentGt.known_findings.map((f) => [f.id, f]));
  for (const v of verdicts) {
    if (v.verdict !== "match" && v.verdict !== "partial") continue;
    const gt = gtMap.get(v.gt_id);
    if (!gt) continue;
    if (v.candidate_finding_id && !gt.aliases.includes(v.candidate_finding_id)) {
      gt.aliases.push(v.candidate_finding_id);
    }
  }
  return currentGt;
}

export function writeGroundTruth(scenarioId: string, gt: GroundTruth): string {
  const path = resolve(import.meta.dirname, "../golden/ground-truth", `${scenarioId}.yaml`);
  // 保留 annotation_meta 字段顺序，重新 dump
  const dumped = yamlDump(gt, { lineWidth: 120 });
  writeFileSync(path, `# 标注文件 —— 由 judge --commit 自动回填 aliases。手工编辑请保留 schema。\n${dumped}`, "utf-8");
  return path;
}
