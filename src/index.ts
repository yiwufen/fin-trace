// MCP Server 入口 — 暴露 graph_explore 工具 — 对应 design-docs/agent-card.md
//
// Stateless 模式：每个 HTTP 请求创建独立的 McpServer + transport。
//
// 同时提供 HTTP API (/api/*) 供前端调用，SSE 推送探索进度。
// 生产模式托管 web/dist/ 静态文件，SPA fallback。
//
// 启动时自动检测 config.json，不存在则从 config.example.json 复制。

import { createServer } from "node:http";
import { existsSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { runExploration } from "./agent/loop.js";
import { handleApiRequest } from "./api.js";
import { handleStatic } from "./static-files.js";

const TOOL_DESCRIPTION = `在金融知识图谱上执行多跳关系探索。

每次调用聚焦一个明确的子问题。如果问题复杂，上游 Agent 应拆解后多次调用。

输入探索目标(goal)和起始实体(seed_entities)，Agent 自动进行多跳探索，返回:
1. findings — 关键发现（statement + confidence + evidence + entities_involved）
2. event_threads — 事件脉络（narrative + causal/temporal 关系链）
3. exploration_meta — 统计 + 完成原因 + 可靠性说明

适合: 多跳关系推理、供应链风险追踪、传导路径分析
不适合: 单实体事实查询、统计汇总、实时行情
延迟: 通常 30s，最长 120s。`;

function buildServer(): McpServer {
  const server = new McpServer({
    name: "fin-trace",
    version: "1.0.0",
  });

  server.tool(
    "graph_explore",
    TOOL_DESCRIPTION,
    {
      goal: z.string().describe("探索目标，自然语言。聚焦一个子问题，不要在一次调用中覆盖多个不相关方向"),
      seed_entities: z.array(z.string()).describe("起始实体中文名，如 ['宁德时代']"),
      max_depth: z.number().int().min(1).max(5).default(3).describe("最大探索深度（跳数）"),
      time_range: z.string().optional().describe("时间范围，格式 '2024-01-01:2024-12-31'"),
    },
    async (args) => {
      const { output: result } = await runExploration({
        goal: args.goal,
        seed_entities: args.seed_entities,
        max_depth: args.max_depth,
        time_range: args.time_range,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

const MCP_PATH_PREFIX = "/mcp";

// ─── config.json 初始化 ───

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureConfig(): void {
  const configPath = resolve(process.cwd(), "config.json");
  if (existsSync(configPath)) return;

  // 从包内 config.example.json 复制到用户工作目录
  const examplePath = resolve(__dirname, "..", "config.example.json");
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, configPath);
    console.log("[init] config.json 已从 config.example.json 自动创建，请编辑配置");
  }
}

// ─── 打开浏览器 ───

async function openBrowser(url: string): Promise<void> {
  const platform = process.platform;
  const cmd =
    platform === "win32" ? `start "" "${url}"` :
    platform === "darwin" ? `open "${url}"` :
    `xdg-open "${url}"`;

  const { exec } = await import("node:child_process");
  exec(cmd, (err) => {
    if (err) {
      console.log(`  打开浏览器: ${url}`);
    }
  });
}

async function main() {
  ensureConfig();

  const httpServer = createServer(async (req, res) => {
    // 1. API 路由 (/api/*)
    const apiHandled = await handleApiRequest(req, res);
    if (apiHandled) return;

    // 2. MCP 路由 (/mcp)
    const url = req.url ?? "/";
    if (url.startsWith(MCP_PATH_PREFIX)) {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      transport.onerror = (err) => {
        console.error("[transport error]", err);
      };
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        console.error("[handleRequest error]", err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.end(String(err));
        }
      }
      return;
    }

    // 3. 静态文件 (web/dist/) + SPA fallback
    if (handleStatic(req, res)) return;

    // 4. 未知路由
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  const port = 3001;
  httpServer.listen(port, () => {
    console.log(`Graph Explorer server listening on port ${port}`);
    console.log(`  MCP endpoint:  http://localhost:${port}/mcp`);
    console.log(`  API endpoint:  http://localhost:${port}/api/sessions`);
    console.log(`  Web UI:        http://localhost:${port}`);
  });

  // 自动打开浏览器
  setTimeout(() => openBrowser(`http://localhost:${port}`), 500);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
