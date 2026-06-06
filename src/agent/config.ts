import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getSettingsApiKey, readSettings } from "../settings-store.js";

export interface McpServerConfig {
  url: string;
  transport: string;
}

export interface LlmConfig {
  provider: "anthropic" | "openai";
  base_url: string;
  model: string;
  max_tokens: number;
  api_key?: string;
}

export interface AppConfig {
  llm: LlmConfig;
  mcp: {
    servers: {
      knowledge_graph: McpServerConfig;
    };
  };
}

let _config: AppConfig | null = null;

export function clearConfigCache(): void {
  _config = null;
}

export function readConfig(): AppConfig {
  if (_config) return _config;

  const __dirname = dirname(fileURLToPath(import.meta.url));
  // config.json 在用户工作目录（npx 使用时与包安装位置不同）
  let path = resolve(process.cwd(), "config.json");
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    // fallback: 包内 config.example.json
    path = resolve(__dirname, "..", "..", "config.example.json");
    raw = readFileSync(path, "utf-8");
  }
  const parsed = JSON.parse(raw);

  // config.json 用 "knowledge-graph" 作为 key，映射为合法的 JS 属性名
  const servers = parsed.mcp.servers as Record<string, McpServerConfig>;
  if (servers["knowledge-graph"]) {
    servers.knowledge_graph = servers["knowledge-graph"];
    delete servers["knowledge-graph"];
  }

  // settings.json 覆盖 config.json 中的 LLM 和 MCP 字段
  const settings = readSettings();
  if (settings.llm) {
    parsed.llm = { ...parsed.llm };
    if (settings.llm.provider) parsed.llm.provider = settings.llm.provider;
    if (settings.llm.base_url) parsed.llm.base_url = settings.llm.base_url;
    if (settings.llm.model) parsed.llm.model = settings.llm.model;
    // api_key 不挂到 config 上，由 getApiKey() 单独处理
  }
  if (settings.mcp?.knowledge_graph_url) {
    parsed.mcp = { ...parsed.mcp, servers: { ...parsed.mcp.servers } };
    parsed.mcp.servers.knowledge_graph = {
      url: settings.mcp.knowledge_graph_url,
      transport: "streamable-http",
    };
  }

  _config = parsed;
  return _config!;
}

export function getApiKey(): string {
  const config = readConfig();

  // 1. 环境变量（生产部署推荐方式）
  const provider = resolveProvider();
  if (provider === "openai") {
    const key = process.env.OPENAI_API_KEY;
    if (key) return key;
  } else {
    const key = process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN;
    if (key) return key;
  }

  // 2. data/settings.json（前端 UI 设置）
  const settingsKey = getSettingsApiKey();
  if (settingsKey) return settingsKey;

  // 3. config.json 中的 api_key
  if (config.llm.api_key) return config.llm.api_key;

  // 4. 本地代理场景：base_url 非官方，允许不设 key
  const baseUrl = config.llm.base_url;
  if (baseUrl && !baseUrl.includes("anthropic.com") && !baseUrl.includes("api.openai.com")) {
    return "unused";
  }

  throw new Error(`${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} env var required`);
}

export function resolveProvider(): "anthropic" | "openai" {
  const config = readConfig();
  return config.llm.provider;
}
