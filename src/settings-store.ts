// 服务端持久化存储 — 存入 data/settings.json，与 config.json 解耦
//
// 存储结构:
//   llm: { provider, base_url, model, api_key }
//   mcp: { knowledge_graph_url }
//
// getApiKey() 优先级:
//   1. 环境变量 (OPENAI_API_KEY / ANTHROPIC_API_KEY)
//   2. data/settings.json 中的 llm.api_key
//   3. config.json 中的 llm.api_key
//   4. base_url 非官方时返回 "unused"
//
// 前端通过 PUT /api/settings 写入，GET /api/settings 返回完整配置（api_key 脱敏）。
// API key 一旦设置后不可从 API 读取明文。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface SettingsStore {
  llm?: {
    api_key?: string;
    provider?: "anthropic" | "openai";
    base_url?: string;
    model?: string;
  };
  mcp?: {
    knowledge_graph_url?: string;
    transport?: "streamable-http" | "sse";
    api_key?: string;
  };
}

const DATA_DIR = resolve(process.cwd(), "data");
const SETTINGS_PATH = resolve(DATA_DIR, "settings.json");

export function readSettings(): SettingsStore {
  try {
    if (existsSync(SETTINGS_PATH)) {
      const raw = readFileSync(SETTINGS_PATH, "utf-8");
      return JSON.parse(raw);
    }
  } catch {
    // 文件损坏或不存在
  }
  return {};
}

export function writeSettings(store: SettingsStore): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
  writeFileSync(SETTINGS_PATH, JSON.stringify(store, null, 2), "utf-8");
}

/** 从 settings.json 读取 api_key（如有） */
export function getSettingsApiKey(): string | undefined {
  return readSettings().llm?.api_key;
}
