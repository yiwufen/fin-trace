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
  case "judge":
    console.error("[eval] judge 尚未实现（Task 6 会接入）");
    process.exit(1);
  case "report":
    console.error("[eval] report 尚未实现（Task 7 会接入）");
    process.exit(1);
  default:
    console.error(`[eval] 未知子命令 "${subcommand}"。运行 --help 查看用法。`);
    process.exit(1);
}
