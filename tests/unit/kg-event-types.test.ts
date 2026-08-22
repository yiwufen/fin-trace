// P1: event_types 过滤透出给 lookup/timeline/trace — 单元测试
// 运行: npx tsx tests/unit/kg-event-types.test.ts
// 动机: 热点实体无过滤 lookup 实测 ~55s / ~112k tok；叠加 event_types 后 ~7s / ~4.7k tok

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

// ─── 映射层透传 ───

await test("lookup 传 event_types → MCP 参数透传", () => {
  const call = mapToMcpCall("lookup", { entities: ["宁德时代"], event_types: ["sanction"] });
  assert.equal(call.method, "search_knowledge");
  assert.deepEqual(
    (call.params as { event_types?: string[] }).event_types,
    ["sanction"],
  );
});

await test("timeline 传 event_types → MCP 参数透传", () => {
  const call = mapToMcpCall("timeline", { entity: "宁德时代", event_types: ["debt_default"] });
  assert.deepEqual(
    (call.params as { event_types?: string[] }).event_types,
    ["debt_default"],
  );
});

await test("trace 传 event_types → MCP 参数透传", () => {
  const call = mapToMcpCall("trace", {
    entity_a: "宁德时代", entity_b: "比亚迪", event_types: ["strategic_cooperation"],
  });
  assert.deepEqual(
    (call.params as { event_types?: string[] }).event_types,
    ["strategic_cooperation"],
  );
});

await test("不传 event_types → 不发送该参数（不传空数组）", () => {
  const call = mapToMcpCall("lookup", { entities: ["宁德时代"] });
  assert.equal((call.params as { event_types?: string[] }).event_types, undefined);
});

await test("expand 不接受 event_types", () => {
  const call = mapToMcpCall("expand", { cluster_ids: ["c1"] });
  assert.equal(call.method, "expand_graph_detail");
  assert.equal("event_types" in call.params, false);
});

// ─── LLM 可见 schema ───

for (const tool of ["lookup", "timeline", "trace"] as const) {
  await test(`${tool} schema 含 event_types 可选参数且指向 scan 的 32 类闭集`, () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === tool);
    assert.ok(def, `${tool} 定义应存在`);
    const props = def!.inputSchema.properties as Record<string, { description?: string }>;
    assert.ok(props.event_types, `${tool} schema 应含 event_types`);
    assert.ok(
      props.event_types.description?.includes("scan"),
      `${tool} 的 event_types 描述应指向 scan 工具的 32 类闭集（避免重复列举）`,
    );
    assert.ok(!def!.inputSchema.required.includes("event_types"), "应为可选");
  });
}

await test("lookup 描述含使用时机指引（定向过滤 vs 摸底不过滤）", () => {
  const def = TOOL_DEFINITIONS.find((d) => d.description.includes("摸底") || d.description.includes("定向"));
  assert.ok(def, "工具描述应包含 event_types 使用时机指引");
});

// ─── 汇总 ───

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 个测试失败:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 个测试通过`);
