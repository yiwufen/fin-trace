// LLM Client 工厂 — 根据 config.provider 路由到 Anthropic SDK 或 OpenAI SDK
//
// 对外暴露统一接口（Anthropic-format 参数和返回值），对内做 provider 翻译。

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { AppConfig } from "../agent/config.js";
import { readConfig, getApiKey, resolveProvider } from "../agent/config.js";
import type { MessageParam, Tool, Message, Stream } from "./types.js";
import { messagesToOpenAi, toolsToOpenAi, responseToMessage, openAiStreamToAnthropic } from "./openai.js";

// ─── 创建参数 ───

export interface CreateParams {
  model: string;
  max_tokens: number;
  system?: string;
  messages: MessageParam[];
  tools?: Tool[];
  signal?: AbortSignal;
}

// ─── Client 接口 ───

export interface LlmClient {
  messages: {
    create(params: CreateParams): Promise<Message>;
    stream(params: CreateParams): Stream;
  };
}

// ─── Factory ───

export function createLlmClient(): LlmClient {
  const config = readConfig();
  const provider = resolveProvider();

  if (provider === "openai") {
    return createOpenAiClient(config);
  }
  return createAnthropicClient(config);
}

// ─── Anthropic 实现 ───

function createAnthropicClient(config: AppConfig): LlmClient {
  const client = new Anthropic({
    apiKey: getApiKey(),
    baseURL: config.llm.base_url,
  });

  return {
    messages: {
      async create(params: CreateParams): Promise<Message> {
        const response = await client.messages.create({
          model: params.model,
          max_tokens: params.max_tokens,
          system: params.system,
          messages: params.messages as Anthropic.MessageParam[],
          tools: params.tools as Anthropic.Tool[] | undefined,
        });

        const content = response.content
          .filter((b): b is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
            b.type === "text" || b.type === "tool_use"
          )
          .map((block) => {
            if (block.type === "text") return { type: "text" as const, text: block.text };
            return {
              type: "tool_use" as const,
              id: block.id,
              name: block.name,
              input: (block.input as Record<string, unknown>) ?? {},
            };
          });

        return {
          id: response.id,
          content,
          usage: {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
          },
        };
      },

      stream(params: CreateParams): Stream {
        const stream = client.messages.stream({
          model: params.model,
          max_tokens: params.max_tokens,
          system: params.system,
          messages: params.messages as Anthropic.MessageParam[],
          tools: params.tools as Anthropic.Tool[] | undefined,
        }, params.signal ? { signal: params.signal } : undefined);

        const textCallbacks: Array<(text: string) => void> = [];

        stream.on("text", (text: string) => {
          for (const cb of textCallbacks) cb(text);
        });

        return {
          on(event: "text", cb: (text: string) => void) {
            if (event === "text") textCallbacks.push(cb);
          },
          async finalMessage(): Promise<Message> {
            const msg = await stream.finalMessage();
            const content = msg.content
              .filter((b): b is Anthropic.TextBlock | Anthropic.ToolUseBlock =>
                b.type === "text" || b.type === "tool_use"
              )
              .map((block) => {
                if (block.type === "text") return { type: "text" as const, text: block.text };
                return {
                  type: "tool_use" as const,
                  id: block.id,
                  name: block.name,
                  input: (block.input as Record<string, unknown>) ?? {},
                };
              });
            return {
              id: msg.id,
              content,
              usage: {
                input_tokens: msg.usage.input_tokens,
                output_tokens: msg.usage.output_tokens,
              },
            };
          },
        };
      },
    },
  };
}

// ─── OpenAI 实现 ───

function createOpenAiClient(config: AppConfig): LlmClient {
  const client = new OpenAI({
    apiKey: getApiKey(),
    baseURL: config.llm.base_url,
  });

  return {
    messages: {
      async create(params: CreateParams): Promise<Message> {
        const response = await client.chat.completions.create({
          model: params.model,
          max_tokens: params.max_tokens,
          messages: messagesToOpenAi(params.messages, params.system),
          tools: params.tools ? toolsToOpenAi(params.tools) : undefined,
        });

        return responseToMessage(response as OpenAI.Chat.Completions.ChatCompletion);
      },

      stream(params: CreateParams): Stream {
        const stream = client.chat.completions.stream({
          model: params.model,
          max_tokens: params.max_tokens,
          messages: messagesToOpenAi(params.messages, params.system),
          tools: params.tools ? toolsToOpenAi(params.tools) : undefined,
        }, params.signal ? { signal: params.signal } : undefined);

        // OpenAI SDK 的 .stream() 返回 Stream 对象，本身也是 AsyncIterable
        return openAiStreamToAnthropic(stream as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>);
      },
    },
  };
}
