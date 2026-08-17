// P3/P4: 新 intent 接入 — scan.TOPIC_RESEARCH + lookup.COMPARATIVE_ANALYSIS — 单元测试
// 运行: npx tsx tests/unit/kg-new-intents.test.ts
// 动机: 产业链类目标靠多轮 lookup/trace 拼链（5+ 步）；TOPIC_RESEARCH 一次召回实体集。
//      多实体对比目前拿 ENTITY_OVERVIEW 凑合；COMPARATIVE_ANALYSIS 服务端原生支持。

import { strict as assert } from "node:assert";
import { TOOL_DEFINITIONS, mapToMcpCall } from "../../src/agent/tools.js";

const failures: string[] = [];
let passed = 0;
async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
  } catch (err) {
    failures.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── P3: scan.intent ───

await test("scan 不传 intent → 默认 EVENT_ANALYSIS", () => {
  const call = mapToMcpCall("scan", { entities: ["宁德时代"], event_types: ["sanction"] });
  assert.equal((call.params as { intent?: string }).intent, "EVENT_ANALYSIS");
});

await test("scan EVENT_ANALYSIS → event_types 正常透传", () => {
  const call = mapToMcpCall("scan", {
    entities: ["宁德时代"], intent: "EVENT_ANALYSIS", event_types: ["sanction"],
  });
  assert.deepEqual((call.params as { event_types?: string[] }).event_types, ["sanction"]);
});

await test("scan TOPIC_RESEARCH → intent 透传、event_types 不发送", () => {
  const call = mapToMcpCall("scan", {
    entities: ["新能源车产业链"], intent: "TOPIC_RESEARCH", event_types: ["sanction"],
  });
  assert.equal((call.params as { intent?: string }).intent, "TOPIC_RESEARCH");
  assert.equal((call.params as { event_types?: string[] }).event_types, undefined,
    "TOPIC_RESEARCH 语义是主题召回，event_types 不适用");
});

await test("scan schema 含 intent 双值枚举", () => {
  const scan = TOOL_DEFINITIONS.find((d) => d.name === "scan")!;
  const intent = scan.inputSchema.properties.intent as { enum?: string[]; description?: string };
  assert.deepEqual(intent.enum, ["EVENT_ANALYSIS", "TOPIC_RESEARCH"]);
  assert.ok(intent.description?.includes("主题"), "应说明 TOPIC_RESEARCH 的主题召回语义");
});

await test("scan entities 描述说明两种 intent 下的不同含义", () => {
  const scan = TOOL_DEFINITIONS.find((d) => d.name === "scan")!;
  const entities = scan.inputSchema.properties.entities as { description?: string };
  assert.ok(entities.description?.includes("主题"), "entities 描述应涵盖 TOPIC_RESEARCH 的主题词用法");
});

// ─── P4: lookup.intent += COMPARATIVE_ANALYSIS ───

await test("lookup COMPARATIVE_ANALYSIS → intent 透传", () => {
  const call = mapToMcpCall("lookup", {
    entities: ["宁德时代", "比亚迪"], intent: "COMPARATIVE_ANALYSIS",
  });
  assert.equal((call.params as { intent?: string }).intent, "COMPARATIVE_ANALYSIS");
  assert.equal((call.params as { hops?: number }).hops, 1, "对比仍为单语义跳");
});

await test("lookup schema intent 枚举含 COMPARATIVE_ANALYSIS", () => {
  const lookup = TOOL_DEFINITIONS.find((d) => d.name === "lookup")!;
  const intent = lookup.inputSchema.properties.intent as { enum?: string[] };
  assert.ok(intent.enum?.includes("COMPARATIVE_ANALYSIS"));
});

// ─── 汇总 ───

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 个测试失败:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 个测试通过`);
