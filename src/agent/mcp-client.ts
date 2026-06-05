// MCP client 封装 — 连接 knowledge-graph MCP 服务
// 对应 design-docs/tools.md 的 MCP 映射 + design-docs/error-handling.md 的降级逻辑

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { readConfig } from "./config.js";
import { type ToolInput, mapToMcpCall } from "./tools.js";
import type { ToolResult, McpToolName } from "./state.js";

// ─── 常量 ───

const MCP_TIMEOUT_MS = 30_000;
const RETRY_DELAY_L1 = 2_000; // L1: 首次重试 2s
const RETRY_DELAY_L2 = 5_000; // L2: 二次重试 5s
const MAX_CONSECUTIVE_ERRORS = 3;

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
  private transport: StreamableHTTPClientTransport | null = null;
  private connected = false;
  private _state: McpClientState = {
    degraded: false,
    consecutiveErrors: 0,
  };

  constructor() {
    this.client = new Client({
      name: "fin-trace",
      version: "1.0.0",
    });
  }

  // ─── 连接管理 ───

  async connect(): Promise<void> {
    const config = readConfig();
    const url = new URL(config.mcp.servers.knowledge_graph.url);
    this.transport = new StreamableHTTPClientTransport(url);
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (this.transport) {
      await this.transport.terminateSession();
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
      this._state.consecutiveErrors++;

      if (this._state.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        this._state.degraded = true;
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
    } catch {
      // fall through to retry
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
    return this.extractContent(result.content);
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
