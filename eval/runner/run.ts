// 单元 1：执行器。进程内调用 runExploration，落盘 raw output + state + manifest。
import { writeFileSync, mkdirSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runExploration } from "../../src/agent/loop.js";
import { serializeState } from "../../src/agent/state.js";
import type { ExplorationInput } from "../../src/agent/state.js";
import { loadScenario, loadScenarios } from "./golden-loader.js";
import type { RunManifest } from "../types.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const RUNS_DIR = resolve(REPO_ROOT, "eval/runs");

function gitShortSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "nogit";
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

function makeRunId(): string {
  return `${timestamp()}-${gitShortSha()}`;
}

// hash config.json with api_key/redacted fields stripped
function configHash(): string {
  const cfgPath = resolve(REPO_ROOT, "config.json");
  if (!existsSync(cfgPath)) return "noconfig";
  const raw = readFileSync(cfgPath, "utf-8");
  const obj = JSON.parse(raw);
  // 删除所有可能的敏感字段
  delete obj?.llm?.api_key;
  delete obj?.mcp?.servers?.["knowledge-graph"]?.api_key;
  delete obj?.a2a?.inbound_token;
  return createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 12);
}

function readLlmModel(): string {
  const cfgPath = resolve(REPO_ROOT, "config.json");
  if (!existsSync(cfgPath)) return "unknown";
  try {
    const obj = JSON.parse(readFileSync(cfgPath, "utf-8"));
    return obj?.llm?.model ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readKgEndpoint(): string {
  const cfgPath = resolve(REPO_ROOT, "config.json");
  if (!existsSync(cfgPath)) return "unknown";
  try {
    const obj = JSON.parse(readFileSync(cfgPath, "utf-8"));
    return obj?.mcp?.servers?.["knowledge-graph"]?.url ?? "unknown";
  } catch {
    return "unknown";
  }
}

function goldenSetSha(): string {
  try {
    return execSync("git rev-parse --short HEAD:eval/golden", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "nogit";
  }
}

export interface RunScenarioOptions {
  noCache: boolean;
}

export async function runScenario(
  scenarioId: string,
  runId: string,
  opts: RunScenarioOptions,
): Promise<void> {
  const scenario = loadScenario(scenarioId);
  const scenarioDir = resolve(RUNS_DIR, runId, scenarioId);
  const outputPath = resolve(scenarioDir, "raw-output.json");
  const statePath = resolve(scenarioDir, "raw-state.json");

  if (!opts.noCache && existsSync(outputPath)) {
    console.log(`[run] ${scenarioId}: 已存在 raw-output.json，跳过（用 --no-cache 强制重跑）`);
    return;
  }

  mkdirSync(scenarioDir, { recursive: true });

  const input: ExplorationInput = {
    goal: scenario.goal,
    seed_entities: scenario.seed_entities,
    max_depth: scenario.max_depth,
    ...(scenario.time_range ? { time_range: scenario.time_range } : {}),
  };

  console.log(`[run] ${scenarioId}: 开始探索（goal: ${scenario.goal}）`);
  const startMs = Date.now();

  let result;
  try {
    result = await runExploration(input, (e) => {
      if (e.type === "step_complete") {
        console.log(`[run] ${scenarioId}: step ${e.step} phase=${e.phase} decision=${e.decision ?? "-"}`);
      }
    });
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    console.error(`[run] ${scenarioId}: 探索失败 — ${msg}`);
    writeFileSync(
      resolve(scenarioDir, "run-error.json"),
      JSON.stringify({ run_status: "failed", error: msg, timestamp: new Date().toISOString() }, null, 2),
    );
    return;
  }

  const durationSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`[run] ${scenarioId}: 完成（${durationSec}s, steps=${result.output.exploration_meta.stats.steps}, findings=${result.output.findings.length}）`);

  writeFileSync(outputPath, JSON.stringify(result.output, null, 2));
  writeFileSync(statePath, JSON.stringify(serializeState(result.state), null, 2));
}

export function writeManifest(runId: string, scenarioIds: string[]): RunManifest {
  const manifest: RunManifest = {
    run_id: runId,
    timestamp: new Date().toISOString(),
    git_sha: gitShortSha(),
    config_hash: configHash(),
    llm_model: readLlmModel(),
    kg_endpoint: readKgEndpoint(),
    golden_set_sha: goldenSetSha(),
  };
  const manifestDir = resolve(RUNS_DIR, runId);
  mkdirSync(manifestDir, { recursive: true });
  writeFileSync(resolve(manifestDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[run] manifest 写入: ${resolve(manifestDir, "manifest.json")}`);
  return manifest;
}

export function latestRunId(): string | null {
  if (!existsSync(RUNS_DIR)) return null;
  const entries = readdirSync(RUNS_DIR)
    .filter((name) => !name.startsWith("."))
    .sort()
    .reverse();
  return entries[0] ?? null;
}

export async function runCommand(args: { scenario?: string; noCache: boolean }): Promise<void> {
  const runId = makeRunId();
  console.log(`[run] run_id = ${runId}`);

  const scenarios = args.scenario ? [args.scenario] : loadScenarios().map((s) => s.id);
  writeManifest(runId, scenarios);

  for (const id of scenarios) {
    await runScenario(id, runId, { noCache: args.noCache });
  }
  console.log(`[run] 全部完成。产物在 eval/runs/${runId}/`);
}
