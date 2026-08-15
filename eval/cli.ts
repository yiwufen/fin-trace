// 评测 CLI 入口
// 用法: npx tsx eval/cli.ts <run|judge|report> [scenario] [options]
import { parseArgs } from "node:util";

function printHelp(): void {
  console.log(`fin-trace eval (phase 1)

用法:
  npx tsx eval/cli.ts run     [scenario] [--no-cache]
  npx tsx eval/cli.ts judge   [scenario] [--commit]
  npx tsx eval/cli.ts report  [scenario] [--run-id <id>] [--baseline <id>]

子命令:
  run      跑探索 + 算所有指标（调 LLM + MCP，最重）
  judge    渲染或回填人工裁决工作表（不调 LLM）
  report   生成 scorecard（不调 LLM）

Note: 每个 task 会逐步把子命令的实际逻辑接进来。本骨架仅打印帮助。`);
}

import { runCommand } from "./runner/run.js";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    help: { type: "boolean", default: false },
    h: { type: "boolean", default: false },
    "no-cache": { type: "boolean", default: false },
    commit: { type: "boolean", default: false },
    "run-id": { type: "string" },
    baseline: { type: "string" },
    // LLM judge 控制（spec §三）：
    "no-llm-judge": { type: "boolean", default: false },   // 仅用 rule pre-filter（兼容 PR #4 行为）
    "no-judge-cache": { type: "boolean", default: false }, // 强制重调 LLM（debug）
  },
  args: process.argv.slice(2),
});

const subcommand = positionals[0];
const scenario = positionals[1];

if (!subcommand || values.help || values.h) {
  printHelp();
  process.exit(0);
}

switch (subcommand) {
  case "run":
    await runCommand({ scenario, noCache: values["no-cache"] === true });
    break;
  case "efficiency": {
    // 用法: npx tsx eval/cli.ts efficiency <run-id> <scenario-id>
    // 隐藏命令：读已有 run 的 raw-output/state，算 efficiency，写 metrics/efficiency.json
    const { computeEfficiency } = await import("./metrics/efficiency.js");
    const { buildStateView } = await import("./metrics/lib/state-view.js");
    const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rid = positionals[1];
    const sid = positionals[2];
    if (!rid || !sid) {
      console.error("用法: npx tsx eval/cli.ts efficiency <run-id> <scenario-id>");
      process.exit(1);
    }
    const base = resolve("eval/runs", rid, sid);
    const output = JSON.parse(readFileSync(resolve(base, "raw-output.json"), "utf-8"));
    const stateRaw = JSON.parse(readFileSync(resolve(base, "raw-state.json"), "utf-8"));
    const view = buildStateView({ output, state: stateRaw });
    const report = computeEfficiency(view);
    const outDir = resolve(base, "metrics");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "efficiency.json"), JSON.stringify(report, null, 2));
    console.log(`[efficiency] ${sid}: useful=${report.useful_events_count} total=${report.total_events_count}`);
    break;
  }
  case "structural": {
    // 用法: npx tsx eval/cli.ts structural <run-id> <scenario-id>
    // 隐藏命令：读已有 run 的 raw-output/state，算 structural quality，写 metrics/quality-structural.json
    const { computeStructuralQuality } = await import("./metrics/quality-structural.js");
    const { buildStateView } = await import("./metrics/lib/state-view.js");
    const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rid = positionals[1];
    const sid = positionals[2];
    if (!rid || !sid) {
      console.error("用法: npx tsx eval/cli.ts structural <run-id> <scenario-id>");
      process.exit(1);
    }
    const base = resolve("eval/runs", rid, sid);
    const output = JSON.parse(readFileSync(resolve(base, "raw-output.json"), "utf-8"));
    const stateRaw = JSON.parse(readFileSync(resolve(base, "raw-state.json"), "utf-8"));
    const view = buildStateView({ output, state: stateRaw });
    const report = computeStructuralQuality(view);
    const outDir = resolve(base, "metrics");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "quality-structural.json"), JSON.stringify(report, null, 2));
    console.log(`[structural] ${sid}: ku_id_provenance=${report.ku_id_provenance.matched}/${report.ku_id_provenance.total}, causal_depth=${report.thread_causal_depth.causal_temporal}/${report.thread_causal_depth.total}, redundancy=${report.thread_redundancy}`);
    break;
  }
  case "recall": {
    // 用法: npx tsx eval/cli.ts recall <run-id> <scenario-id> [--no-llm-judge] [--no-judge-cache]
    // 隐藏命令：读已有 run 的 raw-output/state + ground truth，算 recall，写 metrics/quality-recall.json + audit-pending.json
    // 默认启用 LLM judge；match/partial 自动回填 alias 到 GT yaml
    const { computeRecall } = await import("./metrics/quality-recall.js");
    const { buildStateView } = await import("./metrics/lib/state-view.js");
    const { loadGroundTruth } = await import("./runner/golden-loader.js");
    const { writeGroundTruth } = await import("./report/worksheet.js");
    const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rid = positionals[1];
    const sid = positionals[2];
    if (!rid || !sid) {
      console.error("用法: npx tsx eval/cli.ts recall <run-id> <scenario-id> [--no-llm-judge] [--no-judge-cache]");
      process.exit(1);
    }
    const base = resolve("eval/runs", rid, sid);
    const output = JSON.parse(readFileSync(resolve(base, "raw-output.json"), "utf-8"));
    const stateRaw = JSON.parse(readFileSync(resolve(base, "raw-state.json"), "utf-8"));
    const view = buildStateView({ output, state: stateRaw });
    const gt = loadGroundTruth(sid);
    const useLlmJudge = values["no-llm-judge"] !== true;
    const { report, audit, aliasBackfills } = await computeRecall({
      view,
      groundTruth: gt,
      matchContext: {
        scenarioDir: base,
        useLlmJudge,
        noJudgeCache: values["no-judge-cache"] === true,
        scenarioId: sid,
      },
    });
    const outDir = resolve(base, "metrics");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "quality-recall.json"), JSON.stringify(report, null, 2));
    writeFileSync(resolve(base, "audit-pending.json"), JSON.stringify(audit, null, 2));
    // 自动回填 alias 到 GT yaml（spec §二：LLM 判 match/partial → alias 自动持久化）
    if (aliasBackfills.length > 0) {
      writeGroundTruth(sid, gt);
      console.log(`[recall] ${sid}: 回填 ${aliasBackfills.length} 条 alias 到 GT yaml`);
    }
    console.log(`[recall] ${sid}: must=${report.recall_must.hit}/${report.recall_must.total}, should=${report.recall_should.hit}/${report.recall_should.total}, thread_full=${report.thread_full_rate.full}/${report.thread_full_rate.total}, audit_items=${audit.items.length}${useLlmJudge ? "" : " (rule-only mode)"}`);
    break;
  }
  case "judge": {
    const { renderWorksheet, writeWorksheet, parseWorksheet, applyVerdictsToGroundTruth, writeGroundTruth } =
      await import("./report/worksheet.js");
    const { loadGroundTruth } = await import("./runner/golden-loader.js");
    const { latestRunId } = await import("./runner/run.js");
    const { readFileSync, existsSync: existsSyncSafe } = await import("node:fs");
    const { resolve } = await import("node:path");
    const sid = scenario;
    if (!sid) {
      console.error("用法: npx tsx eval/cli.ts judge <scenario> [--commit]");
      process.exit(1);
    }
    if (values.commit) {
      // 回填模式：解析 worksheet → 更新 ground truth
      const fm = parseWorksheet(sid);
      if (!fm) {
        console.error(`[judge] 未找到 ${sid} 的 worksheet.md。先跑 npx tsx eval/cli.ts judge <scenario>（不带 --commit）生成。`);
        process.exit(1);
      }
      const gt = loadGroundTruth(sid);
      const updated = applyVerdictsToGroundTruth(sid, fm.verdicts, gt);
      const path = writeGroundTruth(sid, updated);
      console.log(`[judge] 回填 ${sid} 的 aliases 到 ${path}`);
    } else {
      // 渲染模式：读最新 run 的 audit-pending → 渲染 worksheet
      const rid = values["run-id"] ?? latestRunId();
      if (!rid) {
        console.error(`[judge] 没有 run 可用。先跑 npx tsx eval/cli.ts run。`);
        process.exit(1);
      }
      const auditPath = resolve("eval/runs", rid, sid, "audit-pending.json");
      if (!existsSyncSafe(auditPath)) {
        console.error(`[judge] 未找到 ${auditPath}。先对该 scenario 跑 run + recall。`);
        process.exit(1);
      }
      const audit = JSON.parse(readFileSync(auditPath, "utf-8"));
      const content = renderWorksheet(audit, rid, sid);
      const path = writeWorksheet(sid, content);
      console.log(`[judge] 渲染 ${sid} 的 worksheet 到 ${path}`);
      console.log(`[judge] 编辑后跑 npx tsx eval/cli.ts judge ${sid} --commit 回填。`);
    }
    break;
  }
  case "report": {
    const { buildScenarioScorecard, writeScenarioScorecard, renderScenarioScorecardMd, renderComparisonSection, compareManifests } =
      await import("./report/scorecard.js");
    const { loadScenarios } = await import("./runner/golden-loader.js");
    const { latestRunId } = await import("./runner/run.js");
    const { writeFileSync, readFileSync, existsSync, mkdirSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rid = values["run-id"] ?? latestRunId();
    const baselineId = values.baseline;
    if (!rid) {
      console.error("[report] 没有 run 可用。先跑 npx tsx eval/cli.ts run。");
      process.exit(1);
    }
    const scenariosToReport = scenario ? [scenario] : loadScenarios().map((s) => s.id);

    // 读 manifest
    const manifestPath = resolve("eval/runs", rid, "manifest.json");
    if (!existsSync(manifestPath)) {
      console.error(`[report] 未找到 ${manifestPath}`);
      process.exit(1);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));

    // baseline manifest（如指定）
    let baselineManifest = null;
    let baselineWarnings: import("./report/scorecard.js").BaselineWarning[] = [];
    if (baselineId) {
      const bp = resolve("eval/runs", baselineId, "manifest.json");
      if (existsSync(bp)) {
        baselineManifest = JSON.parse(readFileSync(bp, "utf-8"));
        baselineWarnings = compareManifests(manifest, baselineManifest);
      }
    }

    const allScMd: string[] = [];
    for (const sid of scenariosToReport) {
      const sc = buildScenarioScorecard(rid, sid);
      writeScenarioScorecard(rid, sid, sc);
      let md = renderScenarioScorecardMd(sc);
      if (baselineId && baselineManifest) {
        const baselineSc = buildScenarioScorecard(baselineId, sid);
        md += "\n" + renderComparisonSection(sc, baselineSc, baselineWarnings);
      }
      writeFileSync(resolve("eval/runs", rid, sid, "scorecard.md"), md);
      console.log(`[report] ${sid}: scorecard 写入 eval/runs/${rid}/${sid}/scorecard.md`);
      allScMd.push(md);
    }

    // 汇总
    const summary = `# Scorecard Summary — run ${rid}\n\n${allScMd.join("\n\n---\n\n")}\n`;
    writeFileSync(resolve("eval/runs", rid, "scorecard-summary.md"), summary);
    console.log(`[report] 汇总: eval/runs/${rid}/scorecard-summary.md`);
    break;
  }
  default:
    console.error(`[eval] 未知子命令 "${subcommand}"。运行 --help 查看用法。`);
    process.exit(1);
}
