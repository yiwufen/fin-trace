// 临时调用脚本 — 对 KG MCP 服务做功能冒烟测试（只读查询），用后即删
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

interface KgConfig {
  url: string;
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

// 结果体积摘要：只打印结构和计数，不打印全文
function summarize(label: string, ok: boolean, data: unknown) {
  if (!ok) {
    console.log(`[${label}] ERROR`);
    return;
  }
  const d = data as Record<string, any>;
  const parts: string[] = [];
  if (Array.isArray(d.knowledge_units)) parts.push(`ku=${d.knowledge_units.length}`);
  if (Array.isArray(d.entities)) parts.push(`entities=${d.entities.length}`);
  if (Array.isArray(d.event_clusters)) parts.push(`clusters=${d.event_clusters.length}`);
  const gd = d.graph_data as Record<string, any> | undefined;
  if (gd?.clusters_overview) parts.push(`clusters_overview=${gd.clusters_overview.length}`);
  if (Array.isArray(d.nodes)) parts.push(`nodes=${d.nodes.length}`);
  if (Array.isArray(d.edges)) parts.push(`edges=${d.edges.length}`);
  if (d.total_count !== undefined) parts.push(`total_count=${d.total_count}`);
  console.log(`[${label}] OK ${parts.join(" ")}`);
}

async function call(label: string, args: Record<string, unknown>) {
  try {
    const result = await client.callTool(
      { name: "search_knowledge", arguments: args },
      undefined,
      { timeout: 60_000 },
    );
    const isError = (result as { isError?: boolean }).isError;
    const text = Array.isArray(result.content)
      ? (result.content as { type: string; text?: string }[])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("\n")
      : "";
    if (isError) {
      console.log(`[${label}] MCP-ERROR: ${text.slice(0, 400)}`);
      return;
    }
    try {
      summarize(label, true, JSON.parse(text));
    } catch {
      console.log(`[${label}] OK (non-JSON) ${text.slice(0, 200)}`);
    }
  } catch (err) {
    console.log(`[${label}] THREW: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}`);
  }
}

// 1. 回归基线：当前 lookup 映射原样调用
await call("baseline-overview", {
  entities: ["宁德时代"], intent: "ENTITY_OVERVIEW", hops: 1, top_k: 5,
});

// 2. 旧 scan 文档里的 event_types（"供应链中断/调整"）是否已失效
await call("old-scan-type", {
  entities: ["宁德时代"], intent: "EVENT_ANALYSIS", event_types: ["供应链中断/调整"],
});

// 3. 新 intent: TOPIC_RESEARCH
await call("topic-research", {
  entities: ["新能源车"], intent: "TOPIC_RESEARCH", top_k: 5,
});

// 4. 新 intent: COMPARATIVE_ANALYSIS
await call("comparative", {
  entities: ["宁德时代", "比亚迪"], intent: "COMPARATIVE_ANALYSIS", top_k: 5,
});

// 5. trace 现行映射（RELATIONSHIP_QUERY hops=2）
await call("trace-current", {
  entities: ["宁德时代"], intent: "RELATIONSHIP_QUERY", target_entity: "比亚迪", hops: 2,
});

// 6. trace + edge_role 剪枝
await call("trace-edge-role", {
  entities: ["宁德时代"], intent: "RELATIONSHIP_QUERY", target_entity: "比亚迪", hops: 2,
  edge_role: ["subject"],
});

// 7. edge_scope 剪枝
await call("trace-edge-scope", {
  entities: ["宁德时代"], intent: "RELATIONSHIP_QUERY", target_entity: "比亚迪", hops: 2,
  edge_scope: ["corporate"],
});

// 8. time_range 开放区间是否报错（服务端要求双端）
await call("open-time-range", {
  entities: ["宁德时代"], intent: "ENTITY_OVERVIEW", hops: 1, top_k: 3,
  time_range: "2024-01-01:",
});

await transport.close();
