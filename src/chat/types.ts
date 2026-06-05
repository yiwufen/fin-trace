// 聊天消息类型 — v3 外层对话循环
//
// ChatMessage 对应 Anthropic API 的 message 格式，支持多模态 content blocks。
// ExplorationSummary 是探索结果的截断摘要，注入外层对话上下文。

import type { Finding, EventThread } from "../agent/state.js";

// ─── 对话消息 ───

export interface ChatMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  created_at: string;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ─── 探索摘要 — 存在 tool_result 中，注入外层上下文 ───

export interface ExplorationSummary {
  goal: string;
  seed_entities: string[];
  findings: Finding[];
  event_threads: EventThread[];
  stats: {
    steps: number;
    entities_visited: number;
    findings_count: number;
    events_buffered: number;
    completion_reason: string;
  };
}
