// KG MCP 兼容修复 — 集成测试（本地进程内假 KG 服务，不依赖真实服务可用）
// 运行: npx tsx tests/unit/kg-compat.integration.test.ts
//
// 验证 KgMcpClient 完整链路（connect → callTool）：
// 1. 服务端 {"error": ...} 正常 content 载荷 → 失败 ToolResult，错误信息透出
// 2. 确定性错误只发 1 次请求（不重试）、不计入降级计数
// 3. 映射层 time_range 校验在客户端拦截（不发请求）
// 4. 合法调用正常成功

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";

// KgMcpClient 经 readConfig() 从 cwd 读 config.json —— 切到临时目录注入本地地址
const scriptDir = dirname(fileURLToPath(import.meta.url));
const workDir = mkdtempSync(join(tmpdir(), "kg-compat-test-"));
const originalCwd = process.cwd();
process.chdir(workDir);
writeFileSync(
  join(workDir, "config.json"),
  JSON.stringify({
    llm: { provider: "openai", base_url: "http://localhost", model: "test", max_tokens: 1000 },
    mcp: { servers: { "knowledge-graph": { url: "", transport: "streamable-http" } } },
  }),
);

// 动态导入以使 chdir 在模块加载前生效
const { KgMcpClient } = await import("../../src/agent/mcp-client.js");
const { clearConfigCache } = await import("../../src/agent/config.js");

// ─── 假 KG 服务：复刻真实服务的关键行为 ───

let searchCallCount = 0; // 服务端实际收到的 search_knowledge 调用数
let lastReceivedArgs: Record<string, unknown> | null = null; // 最近一次调用参数（验证透传）

const fakeServer = new McpServer({ name: "kg-fake", version: "0.0.0" });
fakeServer.registerTool(
  "search_knowledge",
  {
    description: "fake kg",
    inputSchema: z.object({}).passthrough(),
  },
  async (args) => {
    searchCallCount++;
    const record = args as Record<string, unknown>;
    lastReceivedArgs = record;
    const types = record.event_types as string[] | undefined;

    // 复刻真实服务：参数校验失败以 {"error": ...} 挂在正常 content（isError=false）
    if (types?.includes("供应链中断/调整")) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ error: `Unknown event types: ${JSON.stringify(types)}. Valid canonical values: ...` }),
        }],
      };
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          knowledge_units: [{ ku_id: "ku_1", text: "某事件" }],
          entities: [],
          total_count: 1,
        }),
      }],
    };
  },
);

const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
await fakeServer.connect(transport);

const httpServer = createServer(async (req, res) => {
  if ((req.url ?? "").startsWith("/mcp")) {
    let body: unknown;
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    }
    await transport.handleRequest(req, res, body);
  } else {
    res.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const port = (httpServer.address() as { port: number }).port;

writeFileSync(
  join(workDir, "config.json"),
  JSON.stringify({
    llm: { provider: "openai", base_url: "http://localhost", model: "test", max_tokens: 1000 },
    mcp: { servers: { "knowledge-graph": { url: `http://127.0.0.1:${port}/mcp`, transport: "streamable-http" } } },
  }),
);
clearConfigCache(); // 丢弃 chdir 前可能已缓存的配置

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

// ─── 用例 ───

const client = new KgMcpClient();
await client.connect();

await test("服务端 error 载荷 → 失败 ToolResult 且错误信息透出", async () => {
  const r = await client.callTool("scan", {
    entities: ["宁德时代"], event_types: ["供应链中断/调整"],
  } as never);
  assert.equal(r.success, false);
  assert.ok(r.error?.includes("Unknown event types"), `错误信息应透出，得到: ${r.error}`);
});

await test("确定性错误只发 1 次请求（无 L1/L2/L3 重试）", async () => {
  const before = searchCallCount;
  await client.callTool("scan", {
    entities: ["宁德时代"], event_types: ["供应链中断/调整"],
  } as never);
  assert.equal(searchCallCount, before + 1, `应只请求 1 次，实际 ${searchCallCount - before} 次`);
});

await test("开放 time_range 在客户端拦截（服务端零请求）", async () => {
  const before = searchCallCount;
  const r = await client.callTool("scan", {
    entities: ["宁德时代"], event_types: ["sanction"], time_range: "2024-01-01:",
  } as never);
  assert.equal(r.success, false);
  assert.ok(r.error?.includes("time_range"));
  assert.equal(searchCallCount, before, "不应发出网络请求");
});

await test("两次确定性错误后合法调用仍成功（降级未误触发）", async () => {
  const r = await client.callTool("scan", {
    entities: ["宁德时代"], event_types: ["sanction"],
  } as never);
  assert.equal(r.success, true, `合法调用应成功，error=${r.error}`);
  assert.equal(client.state.degraded, false, "确定性错误不应触发 degraded");
  assert.equal(client.state.consecutiveErrors, 0, "确定性错误不应累计 consecutiveErrors");
});

await test("lookup 合法调用无回归", async () => {
  const r = await client.callTool("lookup", { entities: ["宁德时代"] } as never);
  assert.equal(r.success, true);
  const data = r.data as { knowledge_units?: unknown[] };
  assert.ok((data.knowledge_units?.length ?? 0) > 0);
});

await test("lookup 传 event_types 时服务端收到透传参数", async () => {
  await client.callTool("lookup", {
    entities: ["宁德时代"], event_types: ["sanction"],
  } as never);
  assert.deepEqual(lastReceivedArgs?.event_types, ["sanction"]);
});

await client.close();
await new Promise<void>((resolve) => httpServer.close(() => resolve()));

// ─── 清理与汇总 ───

process.chdir(originalCwd);
rmSync(workDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 个测试失败:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`✓ 全部 ${passed} 个集成测试通过`);
