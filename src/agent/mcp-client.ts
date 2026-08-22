// MCP client 封装 — 连接 knowledge-graph MCP 服务
// 对应 design-docs/tools.md 的 MCP 映射 + design-docs/error-handling.md 的降级逻辑

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readConfig, type McpServerConfig } from "./config.js";
import { type ToolInput, mapToMcpCall, validateToolArgs } from "./tools.js";
import type { ToolResult, McpToolName } from "./state.js";

// ─── 常量 ───

// KG 服务升级后实测延迟 21-97s（热点实体/主题召回类查询），30s 会间歇性击穿；
// 60s 覆盖绝大多数实测样本，配合 event_types 过滤指引控制常态延迟
const MCP_TIMEOUT_MS = 60_000;
const RETRY_DELAY_L1 = 2_000; // L1: 首次重试 2s
const RETRY_DELAY_L2 = 5_000; // L2: 二次重试 5s
const MAX_CONSECUTIVE_ERRORS = 3;

// ─── 服务端错误载荷识别 ───
// KG 服务把参数校验等错误作为 {"error": "..."} 放在正常 content（isError=false）里返回；
// 不识别的话错误会被当作数据喂给 LLM

export function extractErrorPayload(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const error = (data as { error?: unknown }).error;
  return typeof error === "string" ? error : null;
}

// 确定性错误（参数被服务端拒绝等）：重试必然同样失败，
// 也不计入 consecutiveErrors（连续 3 次会触发 degraded 跳过后续所有调用，
// 两次 LLM 传参失误不应废掉整个会话的 MCP 通道）
class McpDeterministicError extends Error {}

// ─── Client 状态（供 Agent Loop 读取降级标志）───

export interface McpClientState {
  degraded: boolean;
  consecutiveErrors: number;
}

// ─── MCP 结果中的 content block ───

interface TextContent {
  type: "text";
  text: string;
}

function isTextContent(c: unknown): c is TextContent {
  return typeof c === "object" && c !== null && (c as TextContent).type === "text" && typeof (c as TextContent).text === "string";
}

// ─── KgMcpClient ───

export class KgMcpClient {
  private client: Client;
  private transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
  private connected = false;
  private serverConfig?: McpServerConfig;
  private _state: McpClientState = {
    degraded: false,
    consecutiveErrors: 0,
  };

  // serverConfig：注入的服务端配置（嵌入式宿主用）；不传则 connect() 时读 config.json
  constructor(serverConfig?: McpServerConfig) {
    this.client = new Client({
      name: "fin-trace",
      version: "1.0.0",
    });
    this.serverConfig = serverConfig;
  }

  // ─── 连接管理 ───

  async connect(): Promise<void> {
    const kg = this.serverConfig ?? readConfig().mcp.servers.knowledge_graph;
    const url = new URL(kg.url);
    const transportType = kg.transport ?? "streamable-http";
    const apiKey = kg.api_key;

    const requestInit: RequestInit = apiKey
      ? { headers: { Authorization: `Bearer ${apiKey}` } }
      : {};

    if (transportType === "sse") {
      this.transport = new SSEClientTransport(url, { requestInit });
    } else {
      this.transport = new StreamableHTTPClientTransport(url, { requestInit });
    }

    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.close();
      this.transport = null;
    }
    this.connected = false;
  }

  // ─── 工具调用入口 ───

  async callTool(toolName: McpToolName, args: ToolInput): Promise<ToolResult> {
    const argsRecord = args as unknown as Record<string, unknown>;
    const baseResult = { tool_name: toolName, args: argsRecord };

    if (!this.connected) {
      return { ...baseResult, success: false, data: null, error: "MCP client not connected", total_count: 0 };
    }

    if (this._state.degraded) {
      return { ...baseResult, success: false, data: null, error: "MCP service degraded — skipping call", total_count: 0 };
    }

    // 映射层参数校验 —— 非法参数不发网络请求，错误信息反馈给 LLM 自纠
    const argError = validateToolArgs(toolName, args);
    if (argError) {
      return { ...baseResult, success: false, data: null, error: argError, total_count: 0 };
    }

    const mcpCall = mapToMcpCall(toolName, args);

    try {
      const data = await this.executeWithRetry(mcpCall);
      this._state.consecutiveErrors = 0;
      return {
        ...baseResult,
        success: true,
        data,
        total_count: 1,
      };
    } catch (err) {
      if (!(err instanceof McpDeterministicError)) {
        this._state.consecutiveErrors++;

        if (this._state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          this._state.degraded = true;
        }
      }

      return {
        ...baseResult,
        success: false,
        data: null,
        error: err instanceof Error ? err.message : String(err),
        total_count: 0,
      };
    }
  }

  // ─── 三级重试策略 ───

  private async executeWithRetry(mcpCall: ReturnType<typeof mapToMcpCall>): Promise<unknown> {
    // L1: 首次尝试
    try {
      return await this.executeMcpCall(mcpCall);
    } catch (err) {
      // 确定性错误重试必然同样失败，直接抛出
      if (err instanceof McpDeterministicError) throw err;
    }

    await this.sleep(RETRY_DELAY_L1);

    // L2: 二次尝试
    try {
      return await this.executeMcpCall(mcpCall);
    } catch {
      // fall through to final retry
    }

    await this.sleep(RETRY_DELAY_L2);

    // L3: 最后一次，失败则抛出
    return this.executeMcpCall(mcpCall);
  }

  private async executeMcpCall(mcpCall: ReturnType<typeof mapToMcpCall>): Promise<unknown> {
    const result = await this.client.callTool(
      { name: mcpCall.method, arguments: mcpCall.params as unknown as Record<string, unknown> },
      undefined,
      { timeout: MCP_TIMEOUT_MS },
    );

    // MCP 错误
    if (result.isError) {
      const errorText = Array.isArray(result.content)
        ? result.content.filter(isTextContent).map((c) => c.text).join("\n")
        : "Unknown MCP error";
      throw new Error(`MCP tool error: ${errorText}`);
    }

    // 提取并解析内容
    const data = this.extractContent(result.content);

    // 服务端 {"error": ...} 形态（isError=false 的正常 content）→ 确定性失败
    const errorPayload = extractErrorPayload(data);
    if (errorPayload !== null) {
      throw new McpDeterministicError(`MCP tool error: ${errorPayload}`);
    }

    return data;
  }

  // ─── MCP content 解析 ───

  private extractContent(content: unknown): unknown {
    if (!Array.isArray(content)) return content;

    const texts = content.filter(isTextContent).map((c) => c.text);
    if (texts.length === 0) return content;

    if (texts.length === 1) {
      // 单个文本块 → 尝试 JSON 解析
      try {
        return JSON.parse(texts[0]);
      } catch {
        return texts[0];
      }
    }

    // 多个文本块 → 逐个尝试解析
    return texts.map((t) => {
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    });
  }

  // ─── 状态访问 ───

  get state(): Readonly<McpClientState> {
    return this._state;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
