// LLM 共享类型 — provider-agnostic，镜像 Anthropic 格式
//
// 内部代码使用这些类型。OpenAI provider 在 llm/openai.ts 中做翻译。

// ─── MessageParam ───

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

// ─── ContentBlock ───

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlockParam;

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

export interface ToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

// ─── Tool 定义 ───

export interface Tool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ─── 响应消息 ───

export interface Message {
  id: string;
  content: (TextBlock | ToolUseBlock)[];
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ─── 流式适配器接口 ───

export interface Stream {
  on(event: "text", cb: (text: string) => void): void;
  finalMessage(): Promise<Message>;
}
