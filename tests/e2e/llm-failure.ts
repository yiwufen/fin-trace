// E2E 测试 — LLM 模型 API 故障场景（认证失败 / 网络不可达 / 超时）
//
// 运行: npx tsx tests/e2e/llm-failure.ts
// 不依赖真实付费 API：
//   - 场景 a（auth_invalid）：本地 stub HTTP 服务返回 401（DeepSeek 风格错误体）
//   - 场景 b（network_unreachable）：base_url 指向不可达地址 http://127.0.0.1:9
//   - 场景 c（timeout）：本地 stub 服务挂起不响应，通过 AbortSignal 触发中止
// 断言：
//   - SSE error payload 以「当前模型不可用：」开头并含映射原因，不含原始 SDK 报错特征
//   - turn 正确结束，会话无残留 running 状态（等效 runningExplorations 清理）
// 退出码 0 = 全部通过，1 = 有失败

import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

// 动态 import（cwd 切换前解析路径）
const { handleUserMessage } = await import(join(ROOT, "src/chat/loop.ts")).catch(() =>
  import(join(ROOT, "dist/chat/loop.js")),
);
const { llmErrorSSEPayload } = await import(join(ROOT, "src/llm/errors.ts")).catch(() =>
  import(join(ROOT, "dist/llm/errors.js")),
);
const { clearConfigCache } = await import(join(ROOT, "src/agent/config.ts")).catch(() =>
  import(join(ROOT, "dist/agent/config.js")),
);
const { setLoggerSink, resetLoggerSink } = await import(join(ROOT, "src/logger.ts")).catch(() =>
  import(join(ROOT, "dist/logger.js")),
);

// 服务端日志改道收集（原始 SDK 错误必须留在服务端日志，但不能进入本脚本 stdout —
// A2 要求 stdout 不含原始报错特征；同时可断言服务端日志确实保留了原始错误）
const serverLogLines: string[] = [];
setLoggerSink((line: string) => {
  serverLogLines.push(line);
});

// ─── 环境：临时 cwd + config.json（openai provider 指向 stub）───

const TMP_DIR = mkdtempSync(join(tmpdir(), "fin-trace-llm-failure-"));
const prevCwd = process.cwd();
process.chdir(TMP_DIR);
process.env.OPENAI_API_KEY = "sk-test-invalid-key";

function writeConfig(baseUrl: string): void {
  writeFileSync(
    join(TMP_DIR, "config.json"),
    JSON.stringify({
      llm: { provider: "openai", base_url: baseUrl, model: "stub-model", max_tokens: 1024 },
      mcp: { servers: { "knowledge-graph": { url: "http://127.0.0.1:1/mcp", transport: "streamable-http" } } },
    }),
  );
  clearConfigCache();
}

// ─── stub 服务 ───

/** 401 认证失败 stub（DeepSeek 风格错误体） */
function startAuthFailServer(): Promise<Server> {
  return new Promise((resolveSrv) => {
    const srv = createServer((req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Authentication Fails (no such user)", type: "authentication_error" } }));
    });
    srv.listen(0, "127.0.0.1", () => resolveSrv(srv));
  });
}

/** 挂起不响应 stub（配合 AbortSignal 触发超时/中止） */
function startHangServer(): Promise<Server> {
  return new Promise((resolveSrv) => {
    const srv = createServer(() => {
      // 接受请求，永不响应
    });
    srv.listen(0, "127.0.0.1", () => resolveSrv(srv));
  });
}

// ─── 场景执行 ───

interface ScenarioResult {
  name: string;
  expectedPhrase: string;
  errorPayload: { error: string; kind?: string } | null;
  runningAfterTurn: boolean;
}

/** 复刻 src/api.ts chat 入口的编排：broadcast catch payload + finally 清理 running 标记 */
async function runChatTurnScenario(
  name: string,
  baseUrl: string,
  expectedPhrase: string,
  signal?: AbortSignal,
): Promise<ScenarioResult> {
  writeConfig(baseUrl);

  const events: Array<{ type: string; data: unknown }> = [];
  let running = true; // 等效 runningExplorations.set(...)
  let caught: unknown = undefined;

  await handleUserMessage([], "你好，请分析一下", (eventType: string, data: unknown) => {
    events.push({ type: eventType, data }); // 等效 broadcastSSE
  }, "human", signal)
    .catch((err: unknown) => {
      caught = err;
      // 等效 src/api.ts chat catch：LLM 故障 → 归因 payload；否则 String(message) 兜底
      const payload = llmErrorSSEPayload(err) ?? { error: String((err as Error)?.message ?? err) };
      events.push({ type: "error", data: payload });
    })
    .finally(() => {
      running = false; // 等效 runningExplorations.delete(...)
    });

  const errorEvent = events.find((e) => e.type === "error");
  return {
    name,
    expectedPhrase,
    errorPayload: (errorEvent?.data as ScenarioResult["errorPayload"]) ?? null,
    runningAfterTurn: running,
  };
}

// ─── 断言 ───

let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS: ${label}`);
  } else {
    failures++;
    console.error(`FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const RAW_SDK_MARKERS = ['"status":401', "APIError", "ECONNREFUSED"];

function assertNoRawSdkError(payloadStr: string): boolean {
  return !RAW_SDK_MARKERS.some((m) => payloadStr.includes(m));
}

// ─── 主流程 ───

const authServer = await startAuthFailServer();
const hangServer = await startHangServer();
const authPort = (authServer.address() as { port: number }).port;
const hangPort = (hangServer.address() as { port: number }).port;

try {
  const results: ScenarioResult[] = [];

  // 场景 a：无效 API key（stub 返回 401）→ auth_invalid
  results.push(await runChatTurnScenario(
    "a-invalid-api-key",
    `http://127.0.0.1:${authPort}/v1`,
    "API 密钥无效或未授权",
  ));

  // 场景 b：不可达 base_url（端口 9，连接拒绝）→ network_unreachable
  results.push(await runChatTurnScenario(
    "b-unreachable-base-url",
    "http://127.0.0.1:9/v1",
    "无法连接模型服务（网络不可达）",
  ));

  // 场景 c：超时（stub 挂起 + AbortSignal.timeout）→ timeout
  results.push(await runChatTurnScenario(
    "c-timeout",
    `http://127.0.0.1:${hangPort}/v1`,
    "连接模型服务超时",
    AbortSignal.timeout(3000),
  ));

  // ─── 逐场景断言（stdout 各含一行「当前模型不可用：{原因}」）───
  let allNoRaw = true;
  let allNotRunning = true;
  for (const r of results) {
    const errText = r.errorPayload?.error ?? "";
    console.log(`scenario ${r.name}: 当前模型不可用：${errText.replace(/^当前模型不可用：/, "")} (kind=${r.errorPayload?.kind ?? "none"})`);
    check(`error-event-${r.name}`, !!r.errorPayload, "未收到 SSE error 事件");
    check(`prefix-${r.name}`, errText.startsWith("当前模型不可用："), `实际: ${errText}`);
    check(`reason-${r.name}`, errText.includes(r.expectedPhrase), `未含原因「${r.expectedPhrase}」: ${errText}`);
    const noRaw = assertNoRawSdkError(JSON.stringify(r.errorPayload ?? {}));
    if (!noRaw) allNoRaw = false;
    if (r.runningAfterTurn) allNotRunning = false;
  }

  // A2：payload 不含原始 SDK 报错特征
  check("no-raw-sdk-error", allNoRaw);

  // A3：turn 结束后会话无残留 running 状态
  check("session-not-running", results.every((r) => !r.runningAfterTurn));

  // A7 佐证：原始 SDK 错误保留在服务端日志（而非 SSE payload）
  const rawLogText = serverLogLines.join("\n");
  check("raw-error-in-server-log", rawLogText.includes("401") || rawLogText.toLowerCase().includes("connection error"));
} finally {
  resetLoggerSink();
  process.chdir(prevCwd);
  clearConfigCache();
  await new Promise<void>((r) => authServer.close(() => r()));
  await new Promise<void>((r) => hangServer.close(() => r()));
  rmSync(TMP_DIR, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} 项断言失败`);
  process.exit(1);
}
console.log("\n全部故障场景通过");
process.exit(0);
