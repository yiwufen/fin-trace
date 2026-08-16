// 临时探测脚本 — 列出 knowledge-graph MCP 服务当前提供的全部工具
// 用后即删。API key 从 config.json 读取，不打印。
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface KgConfig {
  url: string;
  transport?: string;
  api_key?: string;
}

const config = JSON.parse(readFileSync("config.json", "utf-8")) as {
  mcp: { servers: Record<string, KgConfig> };
};
const kg = config.mcp.servers["knowledge-graph"] ?? config.mcp.servers.knowledge_graph;
if (process.argv[2]) kg.url = process.argv[2];

const requestInit: RequestInit = kg.api_key
  ? { headers: { Authorization: `Bearer ${kg.api_key}` } }
  : {};

const client = new Client({ name: "fin-trace-probe", version: "0.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(kg.url), { requestInit });

await client.connect(transport);
const { tools } = await client.listTools();

console.log(`=== ${tools.length} tools on ${kg.url} ===\n`);
for (const t of tools) {
  console.log("──────────────────────────────");
  console.log(`TOOL: ${t.name}`);
  console.log(`DESCRIPTION: ${t.description ?? "(none)"}`);
  console.log(`SCHEMA: ${JSON.stringify(t.inputSchema, null, 2)}`);
  console.log();
}
await transport.close();
