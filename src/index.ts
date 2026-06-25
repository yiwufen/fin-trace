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
import { randomBytes } from "node:crypto";
import { handleApiRequest } from "./api.js";
import { handleStatic } from "./static-files.js";
import { handleA2ARequest } from "./a2a/handler.js";
import { buildAgentCard } from "./a2a/agent-card.js";
import { handleMcpRequest, initMcpServer } from "./mcp-server.js";
import { readSettings, writeSettings } from "./settings-store.js";
import { createLogger } from "./logger.js";

const log = createLogger("init");

// ─── config.json 初始化 ───

const __dirname = dirname(fileURLToPath(import.meta.url));

function ensureConfig(): void {
  const configPath = resolve(process.cwd(), "config.json");
  if (existsSync(configPath)) return;

  const examplePath = resolve(__dirname, "..", "config.example.json");
  if (existsSync(examplePath)) {
    copyFileSync(examplePath, configPath);
    log.info("config.json 已从 config.example.json 自动创建，请编辑配置");
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
      log.info({ url }, "打开浏览器");
    }
  });
}

async function main() {
  ensureConfig();

  // 公网部署若未设置 admin_token，自动生成并持久化（仅首次）
  // 这样管理端默认受保护；可在设置页查看/更新。
  const settings = readSettings();
  if (!settings.web?.admin_token) {
    const token = randomBytes(18).toString("base64url");
    settings.web = { ...settings.web, admin_token: token };
    writeSettings(settings);
    log.info("首次部署：已自动生成 admin_token（用于管理端访问）");
    log.info("请通过管理端登录页面输入令牌访问后台");
  }

  // 初始化 MCP Server
  await initMcpServer();

  // PORT / BASE_URL / HEADLESS 从环境变量读取，容器友好
  const port = Number(process.env.PORT ?? 3001);
  const baseUrl = process.env.BASE_URL ?? `http://localhost:${port}`;
  const headless = process.env.HEADLESS === "true";

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

    // 2. MCP Streamable HTTP endpoint (/mcp)
    const mcpHandled = await handleMcpRequest(req, res);
    if (mcpHandled) return;

    // 3. A2A JSON-RPC endpoint (/a2a)
    const a2aHandled = await handleA2ARequest(req, res);
    if (a2aHandled) return;

    // 4. HTTP API (/api/*)
    const apiHandled = await handleApiRequest(req, res);
    if (apiHandled) return;

    // 5. Static files (web/dist/) + SPA fallback
    if (handleStatic(req, res)) return;

    // 6. Unknown route
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, () => {
  log.info({ port, baseUrl }, "服务启动");
  log.info({ endpoint: `${baseUrl}/.well-known/agent-card.json` }, "Agent Card");
  log.info({ endpoint: `${baseUrl}/a2a` }, "A2A endpoint");
  log.info({ endpoint: `${baseUrl}/mcp` }, "MCP endpoint");
  log.info({ endpoint: `${baseUrl}/api/sessions` }, "API endpoint");
  log.info({ endpoint: baseUrl }, "Web UI");
  });

  // 自动打开浏览器（仅本地开发；HEADLESS=true 时跳过，如容器环境）
  if (!headless) {
    setTimeout(() => openBrowser(`${baseUrl}`), 500);
  }
}

main().catch((err) => {
  log.fatal({ err }, "进程退出");
  process.exit(1);
});
