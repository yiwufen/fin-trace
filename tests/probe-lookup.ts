// 探针 — 直接调 knowledge-graph MCP 的 lookup，把原始返回结构 dump 出来。
// 用法: tsx tests/probe-lookup.ts <entity>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readConfig } from "../src/agent/config.js";

async function main() {
  const entity = process.argv[2] ?? "宁德时代";
  const cfg = readConfig();
  const transport = new StreamableHTTPClientTransport(new URL(cfg.mcp.servers.knowledge_graph.url));
  const client = new Client({ name: "probe", version: "0.0.0" });
  await client.connect(transport);

  // 直接调 search_knowledge
  console.log(`[probe] calling search_knowledge({ entities: ["${entity}"], intent: "ENTITY_OVERVIEW", hops: 1 })`);
  const result = await client.callTool(
    { name: "search_knowledge", arguments: { entities: [entity], intent: "ENTITY_OVERVIEW", hops: 1 } },
    undefined,
    { timeout: 30_000 },
  );
  const text = Array.isArray(result.content)
    ? result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n")
    : "";
  let parsed: unknown = text;
  try { parsed = JSON.parse(text); } catch { /* keep as text */ }
  const outPath = new URL("../probe-lookup-output.json", import.meta.url);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(parsed, null, 2));
  console.log("[probe] wrote", outPath.pathname);
  summarize(parsed);
  await client.close();
}

function summarize(data: unknown, depth = 0, path = "$"): void {
  if (depth > 3) return;
  if (Array.isArray(data)) {
    console.log(`${path}: Array(len=${data.length})`);
    if (data.length > 0) summarize(data[0], depth + 1, `${path}[0]`);
    return;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    console.log(`${path}: Object keys=[${Object.keys(obj).join(",")}]`);
    for (const k of Object.keys(obj)) {
      summarize(obj[k], depth + 1, `${path}.${k}`);
    }
    return;
  }
  console.log(`${path}: ${typeof data} ${JSON.stringify(data)?.slice(0, 60)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
