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
