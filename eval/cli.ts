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
    // 用法: npx tsx eval/cli.ts recall <run-id> <scenario-id>
    // 隐藏命令：读已有 run 的 raw-output/state + ground truth，算 recall，写 metrics/quality-recall.json + audit-pending.json
    const { computeRecall } = await import("./metrics/quality-recall.js");
    const { buildStateView } = await import("./metrics/lib/state-view.js");
    const { loadGroundTruth } = await import("./runner/golden-loader.js");
    const { readFileSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const rid = positionals[1];
    const sid = positionals[2];
    if (!rid || !sid) {
      console.error("用法: npx tsx eval/cli.ts recall <run-id> <scenario-id>");
      process.exit(1);
    }
    const base = resolve("eval/runs", rid, sid);
    const output = JSON.parse(readFileSync(resolve(base, "raw-output.json"), "utf-8"));
    const stateRaw = JSON.parse(readFileSync(resolve(base, "raw-state.json"), "utf-8"));
    const view = buildStateView({ output, state: stateRaw });
    const gt = loadGroundTruth(sid);
    const { report, audit } = computeRecall({ view, groundTruth: gt });
    const outDir = resolve(base, "metrics");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, "quality-recall.json"), JSON.stringify(report, null, 2));
    writeFileSync(resolve(base, "audit-pending.json"), JSON.stringify(audit, null, 2));
    console.log(`[recall] ${sid}: must=${report.recall_must.hit}/${report.recall_must.total}, should=${report.recall_should.hit}/${report.recall_should.total}, thread_full=${report.thread_full_rate.full}/${report.thread_full_rate.total}, audit_items=${audit.items.length}`);
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
  case "report":
    console.error("[eval] report 尚未实现（Task 7 会接入）");
    process.exit(1);
  default:
    console.error(`[eval] 未知子命令 "${subcommand}"。运行 --help 查看用法。`);
    process.exit(1);
}
