// fin-trace — A2A Agent Server
//
// 暴露 A2A 协议端点，被 OpenClaw 等 Host Agent 通过 a2a_discover / a2a_send_task 调用。
// 同时提供 HTTP API (/api/*) 供前端 UI 使用，SSE 推送探索进度。
// 生产模式托管 web/dist/ 静态文件，SPA fallback。
//
// 启动时自动检测 config.json，不存在则从 config.example.json 复制。

import { createServer } from "node:http";
import { existsSync, copyFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./api.js";
import { handleStatic } from "./static-files.js";
import { handleA2ARequest } from "./a2a/handler.js";
import { buildAgentCard } from "./a2a/agent-card.js";

// ─── config.json 初始化 ───

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureConfig(): void {
  const configPath = resolve(process.cwd(), "config.json");
  if (existsSync(configPath)) return;

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

  const port = 3001;
  const baseUrl = `http://localhost:${port}`;

  const httpServer = createServer(async (req, res) => {
    const url = req.url ?? "/";

    // 1. A2A Agent Card discovery (/.well-known/agent-card.json)
    if (url === "/.well-known/agent-card.json" || url === "/.well-known/agent.json") {
      const card = buildAgentCard(baseUrl);
      const body = JSON.stringify(card, null, 2);
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Access-Control-Allow-Origin": "*",
      });
      res.end(body);
      return;
    }

    // 2. A2A JSON-RPC endpoint (/a2a)
    const a2aHandled = await handleA2ARequest(req, res);
    if (a2aHandled) return;

    // 3. HTTP API (/api/*)
    const apiHandled = await handleApiRequest(req, res);
    if (apiHandled) return;

    // 4. Static files (web/dist/) + SPA fallback
    if (handleStatic(req, res)) return;

    // 5. Unknown route
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
    console.log(`fin-trace A2A Agent listening on port ${port}`);
    console.log(`  Agent Card:    ${baseUrl}/.well-known/agent-card.json`);
    console.log(`  A2A endpoint:  ${baseUrl}/a2a`);
    console.log(`  API endpoint:  ${baseUrl}/api/sessions`);
    console.log(`  Web UI:        ${baseUrl}`);
  });

  // 自动打开浏览器
  setTimeout(() => openBrowser(`${baseUrl}`), 500);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
