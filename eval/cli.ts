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

const { positionals } = parseArgs({
  allowPositionals: true,
  strict: false,
  args: process.argv.slice(2),
});

const subcommand = positionals[0];
if (!subcommand || subcommand === "--help" || subcommand === "-h") {
  printHelp();
  process.exit(0);
}

console.error(`[eval] 子命令 "${subcommand}" 尚未实现（Task 2+ 会接入）。`);
console.error(`[eval] 运行 npx tsx eval/cli.ts --help 查看用法。`);
process.exit(1);
