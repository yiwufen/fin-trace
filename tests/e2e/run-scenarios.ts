// E2E 测试 — 4 个英伟达场景
// 运行: npx tsx tests/e2e/run-scenarios.ts [scenario_number]
// 不传参数则运行全部 4 个场景

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runExploration } from "../../src/agent/loop.js";
import type { ExplorationInput, ExplorationOutput } from "../../src/agent/state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, "output");

interface Scenario {
  name: string;
  input: ExplorationInput;
}

const SCENARIOS: Scenario[] = [
  {
    name: "scenario-1-supply-chain",
    input: {
      goal: "追踪美国对华芯片出口管制对英伟达供应链的传导影响",
      seed_entities: ["英伟达", "台积电"],
      max_depth: 4,
    },
  },
  {
    name: "scenario-2-competitive-landscape",
    input: {
      goal: "英伟达在 AI 芯片市场的竞争地位，以及主要竞争对手的动态",
      seed_entities: ["英伟达"],
      max_depth: 4,
    },
  },
  {
    name: "scenario-3-multi-hop",
    input: {
      goal: "英伟达和特斯拉之间通过哪些中间实体产生关联",
      seed_entities: ["英伟达", "特斯拉"],
      max_depth: 4,
    },
  },
  {
    name: "scenario-4-geopolitical",
    input: {
      goal: "中美科技竞争背景下，英伟达面临的政策风险有哪些传导路径",
      seed_entities: ["英伟达"],
      max_depth: 4,
    },
  },
];

function printDivider(label: string): void {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${label}`);
  console.log("=".repeat(60));
}

function printResult(result: ExplorationOutput, durationMs: number): void {
  const { findings, event_threads, exploration_meta } = result;

  console.log(`\n完成原因: ${exploration_meta.completion_reason}`);
  console.log(`耗时: ${(durationMs / 1000).toFixed(1)}s`);
  console.log(`步数: ${exploration_meta.stats.steps}`);
  console.log(`已探索实体: ${exploration_meta.stats.entities_visited}`);
  console.log(`Finding 数: ${exploration_meta.stats.findings_count}`);
  console.log(`归档事件: ${exploration_meta.stats.events_buffered}`);
  console.log(`Token 用量: ${exploration_meta.stats.tokens_used.toLocaleString()}`);
  if (exploration_meta.reliability_note) {
    console.log(`可靠性说明: ${exploration_meta.reliability_note}`);
  }

  console.log(`\n─── Key Findings (${findings.length}) ───`);
  for (const f of findings) {
    console.log(`  [${f.category}] ${f.confidence}`);
    console.log(`    ${f.statement}`);
    console.log(`    实体: ${f.entities_involved.join(", ")}`);
    console.log(`    evidence: ${f.evidence.join(", ")}`);
    if (f.conflict_with) {
      console.log(`    ⚠ 冲突: ${f.conflict_with}`);
    }
    console.log();
  }

  if (event_threads.length > 0) {
    console.log(`─── Event Threads (${event_threads.length}) ───`);
    for (const t of event_threads) {
      console.log(`  ${t.title} [${t.confidence}]`);
      console.log(`    ${t.summary}`);
      console.log(`    事件数: ${t.thread_events.length}`);
      const earliest = t.time_span?.earliest ?? "?";
      const latest = t.time_span?.latest ?? "?";
      console.log(`    时间跨度: ${earliest} ~ ${latest}`);
      console.log(`    关系: ${t.relationships.map((r) => r.type).join(", ")}`);
      console.log();
    }
  }
}

async function runScenario(scenario: Scenario): Promise<void> {
  printDivider(scenario.name);
  console.log(`Goal: ${scenario.input.goal}`);
  console.log(`Seed: ${scenario.input.seed_entities.join(", ")}`);
  console.log(`Max Depth: ${scenario.input.max_depth}`);

  const start = Date.now();
  let result: ExplorationOutput | null = null;
  let error: string | null = null;

  try {
    result = await runExploration(scenario.input);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    console.error(`\n[ERROR] ${error}`);
  }

  const duration = Date.now() - start;

  // 保存原始输出
  const outputPath = resolve(OUTPUT_DIR, `${scenario.name}.json`);
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        scenario: scenario.name,
        goal: scenario.input.goal,
        seed_entities: scenario.input.seed_entities,
        duration_ms: duration,
        error,
        result,
      },
      null,
      2,
    ),
    "utf-8",
  );
  console.log(`\n原始输出已保存: ${outputPath}`);

  if (result) {
    printResult(result, duration);
  }

  console.log(`\n${"-".repeat(60)}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args[0] ? parseInt(args[0]) : null;

  console.log("Graph Explorer E2E — 英伟达场景测试\n");

  if (target && (target < 1 || target > SCENARIOS.length)) {
    console.error(`无效场景编号: ${target} (1-${SCENARIOS.length})`);
    process.exit(1);
  }

  const toRun = target ? [SCENARIOS[target - 1]] : SCENARIOS;

  const startAll = Date.now();

  for (let i = 0; i < toRun.length; i++) {
    const idx = target ? target : i + 1;
    console.log(`[${idx}/${SCENARIOS.length}] 开始场景: ${toRun[i].name}`);
    await runScenario(toRun[i]);
  }

  console.log(`\n全部完成，总耗时: ${((Date.now() - startAll) / 1000 / 60).toFixed(1)} 分钟`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
