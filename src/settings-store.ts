// 服务端凭据存储 — 存入 data/settings.json
//
// 与 config.json 职责分离:
//   config.json     → 基础设施配置（provider, base_url, model, max_tokens, kg_url, transport, ...）
//   settings.json   → 仅存储凭据/密钥（api_key, admin_token），前端 UI 可读写
//
// getApiKey() 优先级:
//   1. 环境变量 (OPENAI_API_KEY / ANTHROPIC_API_KEY)
//   2. data/settings.json 中的 llm.api_key
//   3. config.json 中的 llm.api_key
//   4. base_url 非官方时返回 "unused"
//
// API key 一旦设置后不可从 API 读取明文（仅返回 configured: true/false）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

export interface SettingsStore {
  // LLM 凭据 — 前端 UI 可设置，优先级高于 config.json
  llm?: {
    api_key?: string;
  };
  // MCP 凭据 — 前端 UI 可设置
  mcp?: {
    api_key?: string;
  };
  // Web 管理端配置
  // admin_token: 管理 /api/sessions* 的门禁 token；
  //   未配置则不鉴权（本地开发），首次启动自动生成。
  // demo_session_id: 固定为访客展示的「已完成会话」(只读，不计次)。
  // invite_codes: 生效的注册邀请码（空数组 = 不校验邀请码，开放注册）
  // user_signup_quota: 新用户注册赠送额度，默认 20
  // user_registration_enabled: 是否开放注册（false 时注册端点拒绝）
  web?: {
    admin_token?: string;
    demo_session_id?: string;
    invite_codes?: string[];
    user_signup_quota?: number;
    user_registration_enabled?: boolean;
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
