// OpenAI API 翻译层 — 将 Anthropic-format 输入转为 OpenAI format，响应转回 Anthropic format
//
// 所有翻译集中在此文件。DeepSeek 等 OpenAI 兼容 API 一并支持。

import type OpenAI from "openai";
import type {
  MessageParam,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  Tool,
  Message,
  Stream,
} from "./types.js";

// ═══════════════════════════════════════════════════════
// MessageParam → OpenAI messages
// ═══════════════════════════════════════════════════════

export function messagesToOpenAi(
  messages: MessageParam[],
  system?: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const result: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

  if (system) {
    result.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      // user 消息中的 content blocks — 提取 text 和 tool_result
      const textBlocks: string[] = [];
      const toolResults: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textBlocks.push(block.text);
        } else if (block.type === "tool_result") {
          toolResults.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: block.content,
          });
        }
      }

      if (textBlocks.length > 0) {
        result.push({ role: "user", content: textBlocks.join("\n") });
      }
      for (const tr of toolResults) {
        result.push(tr);
      }
    } else {
      // assistant 消息 — 提取 text 和 tool_use
      let textContent: string | null = null;
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

      for (const block of msg.content) {
        if (block.type === "text") {
          textContent = (textContent ?? "") + block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        }
      }

      const assistantMsg: OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam = {
        role: "assistant",
        content: textContent,
        refusal: null,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════
// Tool 定义 → OpenAI tools
// ═══════════════════════════════════════════════════════

export function toolsToOpenAi(tools: Tool[]): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

// ═══════════════════════════════════════════════════════
// OpenAI 响应 → Message (Anthropic format)
// ═══════════════════════════════════════════════════════

export function responseToMessage(
  raw: OpenAI.Chat.Completions.ChatCompletion,
): Message {
  const choice = raw.choices[0];
  const content: (TextBlock | ToolUseBlock)[] = [];

  const text = choice?.message?.content;
  if (text) {
    content.push({ type: "text", text });
  }

  const toolCalls = choice?.message?.tool_calls;
  if (toolCalls) {
    for (const tc of toolCalls) {
      if (!("function" in tc)) continue;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  return {
    id: raw.id,
    content,
    usage: {
      input_tokens: raw.usage?.prompt_tokens ?? 0,
      output_tokens: raw.usage?.completion_tokens ?? 0,
    },
  };
}

// ═══════════════════════════════════════════════════════
// OpenAI Stream → Stream (Anthropic-style events)
// ═══════════════════════════════════════════════════════

export function openAiStreamToAnthropic(
  openAiStream: AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>,
): Stream {
  const textCallbacks: Array<(text: string) => void> = [];
  let collectedText = "";
  const collectedToolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
  let messageId = "";
  let finalInputTokens = 0;
  let finalOutputTokens = 0;
  let streamDone = false;
  let resolveFinal: ((msg: Message) => void) | undefined;
  let finalMessagePromise: Promise<Message> | undefined;

  // 启动消费
  void (async () => {
    try {
      for await (const chunk of openAiStream) {
        messageId = chunk.id || messageId;

        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        // 文本增量
        if (delta.content) {
          collectedText += delta.content;
          for (const cb of textCallbacks) {
            cb(delta.content);
          }
        }

        // 工具调用增量（OpenAI 分多块发送 arguments）
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            let entry = collectedToolCalls.get(idx);
            if (!entry) {
              entry = { id: tc.id ?? "", name: tc.function?.name ?? "", arguments: "" };
              collectedToolCalls.set(idx, entry);
            }
            if (tc.id) entry.id = tc.id;
            if (tc.function?.name) entry.name = tc.function.name;
            if (tc.function?.arguments) entry.arguments += tc.function.arguments;
          }
        }

        // usage（可能出现在最后一块）
        if (chunk.usage) {
          finalInputTokens = chunk.usage.prompt_tokens ?? 0;
          finalOutputTokens = chunk.usage.completion_tokens ?? 0;
        }
      }
    } catch {
      // stream error — 返回已有内容
    } finally {
      streamDone = true;
    }
  })();

  finalMessagePromise = new Promise<Message>((resolve) => {
    resolveFinal = resolve;
    // 轮询直到 stream 结束
    const check = () => {
      if (streamDone) {
        const content: (TextBlock | ToolUseBlock)[] = [];
        if (collectedText) {
          content.push({ type: "text", text: collectedText });
        }
        for (const [, tc] of [...collectedToolCalls].sort((a, b) => a[0] - b[0])) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(tc.arguments);
          } catch {
            input = {};
          }
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input });
        }
        resolve({
          id: messageId || "stream_msg",
          content,
          usage: { input_tokens: finalInputTokens, output_tokens: finalOutputTokens },
        });
      } else {
        setTimeout(check, 10);
      }
    };
    check();
  });

  return {
    on(event: "text", cb: (text: string) => void) {
      if (event === "text") textCallbacks.push(cb);
    },
    finalMessage(): Promise<Message> {
      return finalMessagePromise!;
    },
  };
}
