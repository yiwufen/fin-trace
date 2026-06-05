// 端到端集成测试驱动 — 以 MCP 客户端身份连接本地 graph-explorer 服务，调用 graph_explore
// 用法: tsx tests/e2e-driver.ts [--goal "..."] [--seed "X,Y"] [--timeout-ms 180000]
// 默认: goal="追踪宁德时代在欧洲市场的供应链布局", seed=["宁德时代"]

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface Args {
  goal: string;
  seed: string[];
  timeoutMs: number;
  url: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  let goal = "追踪宁德时代在欧洲市场的供应链布局";
  let seed: string[] = ["宁德时代"];
  let timeoutMs = 600_000;
  let url = "http://127.0.0.1:3001/mcp";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--goal") goal = argv[++i];
    else if (a === "--seed") seed = argv[++i].split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--timeout-ms") timeoutMs = Number(argv[++i]);
    else if (a === "--url") url = argv[++i];
  }
  return { goal, seed, timeoutMs, url };
}

async function main() {
  const args = parseArgs();
  console.log("[e2e] connecting to", args.url);
  const transport = new StreamableHTTPClientTransport(new URL(args.url));
  const client = new Client({ name: "e2e-driver", version: "0.0.0" });
  await client.connect(transport);
  console.log("[e2e] connected, listing tools...");
  const tools = await client.listTools();
  console.log(
    "[e2e] tools:",
    tools.tools.map((t) => t.name).join(", "),
  );

  console.log("[e2e] calling graph_explore", { goal: args.goal, seed: args.seed });
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  try {
    const result = await client.callTool(
      {
        name: "graph_explore",
        arguments: {
          goal: args.goal,
          seed_entities: args.seed,
          max_depth: 2,
        },
      },
      undefined,
      { signal: controller.signal, timeout: args.timeoutMs },
    );
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[e2e] callTool returned in ${elapsed}s`);
    if (!result.content || result.content.length === 0) {
      console.error("[e2e] ERROR: empty content");
      process.exit(2);
    }
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      console.error("[e2e] ERROR: response is not JSON. First 500 chars:");
      console.error(text.slice(0, 500));
      process.exit(3);
    }
    validateResult(parsed);
    const outPath = new URL("../e2e-output.json", import.meta.url);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(outPath, JSON.stringify(parsed, null, 2));
    console.log("[e2e] full output written to", outPath.pathname);
  } finally {
    clearTimeout(timer);
    await client.close();
  }
}

function validateResult(parsed: unknown) {
  if (typeof parsed !== "object" || parsed === null) {
    console.error("[e2e] FAIL: result is not an object");
    process.exit(4);
  }
  const r = parsed as Record<string, unknown>;
  const has = (k: string) => k in r;
  console.log("[e2e] top-level keys:", Object.keys(r).join(", "));
  for (const k of ["findings", "event_threads", "exploration_meta"]) {
    if (!has(k)) {
      console.error(`[e2e] FAIL: missing top-level field '${k}'`);
      process.exit(5);
    }
  }
  const findings = r.findings as unknown[];
  const threads = r.event_threads as unknown[];
  const meta = r.exploration_meta as Record<string, unknown>;
  console.log(
    `[e2e] counts: findings=${findings.length} event_threads=${threads.length}`,
  );
  console.log("[e2e] exploration_meta:", JSON.stringify(meta, null, 2));

  let findingsWithoutEvidence = 0;
  for (const f of findings) {
    const o = f as Record<string, unknown>;
    const ev = o.evidence;
    if (!Array.isArray(ev) || ev.length === 0) findingsWithoutEvidence++;
  }
  if (findingsWithoutEvidence > 0) {
    console.warn(
      `[e2e] WARN: ${findingsWithoutEvidence} findings lack evidence (design says evidence is required)`,
    );
  }

  // 抽样打印前 3 个 findings 标题
  console.log("[e2e] sample findings:");
  for (const f of findings.slice(0, 3)) {
    const o = f as Record<string, unknown>;
    console.log(
      `  - [${o.category}] ${(o.headline ?? o.summary ?? "").toString().slice(0, 80)} (conf=${o.confidence})`,
    );
  }
  console.log("[e2e] sample event_threads:");
  for (const t of threads.slice(0, 3)) {
    const o = t as Record<string, unknown>;
    console.log(
      `  - [${o.relation_type}] ${(o.narrative ?? "").toString().slice(0, 80)}`,
    );
  }

  if (findings.length === 0 && threads.length === 0) {
    console.warn(
      "[e2e] WARN: both findings and event_threads are empty — possible LLM/MCP failure",
    );
  }
}

main().catch((err) => {
  console.error("[e2e] FATAL:", err);
  process.exit(1);
});
