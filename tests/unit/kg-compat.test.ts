// KG MCP 服务兼容修复 — 单元测试
// 运行: npx tsx tests/unit/kg-compat.test.ts
// 仓库未配置测试框架，采用 tsx + node:assert 轻量断言（与 CI 的 typecheck 流程并行）

import { strict as assert } from "node:assert";
import {
  EVENT_TYPES,
  TOOL_DEFINITIONS,
  validateTimeRange,
  validateToolArgs,
} from "../../src/agent/tools.js";
import { extractErrorPayload } from "../../src/agent/mcp-client.js";

// ─── 微型测试运行器 ───

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

// ─── validateTimeRange: 服务端要求双端 ISO 日期 ───

await test("合法区间 '2024-01-01:2024-12-31' 通过", () => {
  assert.equal(validateTimeRange("2024-01-01:2024-12-31"), null);
});

await test("undefined（未传）通过", () => {
  assert.equal(validateTimeRange(undefined), null);
});

await test("开放区间 '2024-01-01:' 被拒绝", () => {
  const msg = validateTimeRange("2024-01-01:");
  assert.ok(typeof msg === "string" && msg.length > 0, `应返回错误信息，得到 ${msg}`);
});

await test("开放区间 ':2024-12-31' 被拒绝", () => {
  assert.ok(validateTimeRange(":2024-12-31"));
});

await test("缺分隔符 '2024-01-01' 被拒绝", () => {
  assert.ok(validateTimeRange("2024-01-01"));
});

await test("非 ISO 日期 '2024-1-1:2024-12-31' 被拒绝", () => {
  assert.ok(validateTimeRange("2024-1-1:2024-12-31"));
});

await test("空字符串被拒绝（视为非法而非未传）", () => {
  assert.ok(validateTimeRange(""));
});

// ─── validateToolArgs: 工具级参数校验入口 ───

await test("scan 开放 time_range 返回错误", () => {
  const msg = validateToolArgs("scan", {
    entities: ["宁德时代"],
    event_types: ["sanction"],
    time_range: "2024-01-01:",
  });
  assert.ok(msg && msg.includes("time_range"), `应提示 time_range 问题，得到 ${msg}`);
});

await test("lookup 合法参数通过", () => {
  assert.equal(
    validateToolArgs("lookup", { entities: ["宁德时代"], time_range: "2024-01-01:2024-12-31" }),
    null,
  );
});

await test("expand 无 time_range 参数，通过", () => {
  assert.equal(validateToolArgs("expand", { cluster_ids: ["cluster_x"] }), null);
});

// ─── extractErrorPayload: 服务端 {"error": ...} 形态识别 ───

await test("识别 {error: string} 为错误载荷", () => {
  assert.equal(
    extractErrorPayload({ error: "Unknown event types: ['供应链中断/调整']" }),
    "Unknown event types: ['供应链中断/调整']",
  );
});

await test("正常结果载荷（含 knowledge_units）不误判", () => {
  assert.equal(extractErrorPayload({ knowledge_units: [], entities: [], total_count: 0 }), null);
});

await test("纯字符串结果不误判", () => {
  assert.equal(extractErrorPayload("some text"), null);
});

await test("非字符串 error 字段不误判", () => {
  assert.equal(extractErrorPayload({ error: { code: -32000 } }), null);
});

await test("null / undefined 输入不误判", () => {
  assert.equal(extractErrorPayload(null), null);
  assert.equal(extractErrorPayload(undefined), null);
});

// ─── EVENT_TYPES: 32 类 canonical 闭集契约 ───

await test("EVENT_TYPES 恰好 32 类", () => {
  assert.equal(EVENT_TYPES.length, 32);
});

await test("EVENT_TYPES 含关键 canonical 值", () => {
  for (const t of ["restructuring", "sanction", "regulatory_action", "debt_default", "investment"]) {
    assert.ok(EVENT_TYPES.includes(t), `缺少 ${t}`);
  }
});

await test("scan 工具描述完整列出全部 32 类（LLM 可见契约）", () => {
  const scan = TOOL_DEFINITIONS.find((d) => d.name === "scan");
  assert.ok(scan, "scan 工具定义应存在");
  const missing = EVENT_TYPES.filter((t) => !scan!.description.includes(t));
  assert.deepEqual(missing, [], `scan 描述缺少: ${missing.join(", ")}`);
});

await test("scan schema 描述不再引用已失效的旧类型", () => {
  const scan = TOOL_DEFINITIONS.find((d) => d.name === "scan");
  const schemaText = JSON.stringify(scan!.inputSchema);
  assert.ok(!schemaText.includes("供应链中断/调整"), "schema 描述仍含旧类型'供应链中断/调整'");
});

// ─── 汇总 ───

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 个测试失败:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 个测试通过`);
