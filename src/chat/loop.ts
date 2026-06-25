// 外层对话循环 — v3 核心
//
// 双模式:
//   human: 分析型助手 — 框架化、多轮探索、综合叙事
//   agent: 薄翻译层 — 接收子问题、返回摘要 + gaps
//
// handleUserMessage() 是聊天入口。每次用户消息触发一个 turn：
//   while(true):
//     LLM stream → text_delta SSE
//     如果 LLM 纯文本回复 → break
//     如果 LLM 调 graph_explore → 执行探索 → tool_result → 继续 while
//     探索结果回 LLM → LLM 翻译为自然语言 → break
//
// 内层 runExploration() 通过 onStep 回调透传 step/finalize SSE 事件。

import { randomUUID } from "node:crypto";
import type { ChatMessage, ContentBlock, TextBlock, ToolUseBlock, ToolResultBlock } from "./types.js";
import { getSystemPrompt, getEnvironmentContext, type ChatMode } from "./prompt.js";
import { formatExplorationResult } from "./result-formatter.js";
import { createLlmClient } from "../llm/client.js";
import { readConfig } from "../agent/config.js";
import { runExploration } from "../agent/loop.js";
import type { StepEvent, ExplorationInput } from "../agent/state.js";
import { categorize } from "../tool-categories.js";
import type {
  Tool,
  MessageParam,
  ContentBlock as LlmContentBlock,
  TextBlock as LlmTextBlock,
  ToolUseBlock as LlmToolUseBlock,
  ToolResultBlockParam,
  Message,
} from "../llm/types.js";

// ─── graph_explore 工具定义（Anthropic Tool 格式）───

const GRAPH_EXPLORE_TOOL: Tool = {
  name: "graph_explore",
  description:
    "在金融知识图谱上执行多跳关系探索。每次调用聚焦一个明确的子问题，" +
    "返回 findings（关键发现）、event_threads（事件脉络）和 stats（统计）。" +
    "如果问题复杂，分多次调用，每次聚焦一个方面。" +
    "当用户提到相对时间（今天、最近、上周、本季度等）时，必须将解析后的具体日期填入 time_range 参数。",
  input_schema: {
    type: "object",
    properties: {
      goal: {
        type: "string",
        description: "自然语言探索目标，如'追踪美国制裁对宁德时代欧洲供应链的影响'",
      },
      seed_entities: {
        type: "array",
        items: { type: "string" },
        description: "起始实体中文名，如 ['宁德时代']",
      },
      max_depth: {
        type: "integer",
        default: 3,
        minimum: 1,
        maximum: 5,
        description: "最大探索深度（跳数）",
      },
      time_range: {
        type: "string",
        description: "时间范围，格式 '2024-01-01:2024-12-31'。从用户的相对时间表达（今天、最近、上周）解析为具体日期。",
      },
    },
    required: ["goal", "seed_entities"],
  },
};

// ─── 广播辅助 ───

interface BroadcastFn {
  (eventType: string, data: unknown): void;
}

// ─── 入口：处理一条用户消息 ───
//
// history: session.messages（ChatMessage[]），含所有历史对话
// userMessage: 当前用户输入
// 返回本轮新增的 ChatMessage[]

export async function handleUserMessage(
  history: ChatMessage[],
  userMessage: string,
  broadcast: BroadcastFn,
  mode: ChatMode = "human",
): Promise<ChatMessage[]> {
  const apiMessages: MessageParam[] = historyToApiMessages(history);

  // 追加当前用户消息
  apiMessages.push({
    role: "user",
    content: userMessage,
  });

  return runOuterTurn(apiMessages, broadcast, mode);
}

// ─── ChatMessage[] → MessageParam[] ───
//
// 关键规则：Anthropic API 要求 tool_result 必须在 user 消息中。
// 按块顺序扫描，遇到 tool_result 时分叉为独立的 user 消息。

function historyToApiMessages(history: ChatMessage[]): MessageParam[] {
  const result: MessageParam[] = [];

  for (const msg of history) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    let pending: LlmContentBlock[] = [];
    let pendingToolResults: ToolResultBlockParam[] = [];

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        if (pending.length > 0) {
          result.push({ role: msg.role, content: pending });
          pending = [];
        }
        pendingToolResults.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: block.content,
          ...(block.is_error ? { is_error: true } : {}),
        });
      } else {
        // 遇到非 tool_result 块时，先 flush 已收集的 tool_results
        if (pendingToolResults.length > 0) {
          result.push({ role: "user", content: pendingToolResults });
          pendingToolResults = [];
        }
        pending.push(blockToApiBlock(block));
      }
    }

    // flush 剩余的 tool_results（单条 user 消息包含所有 tool_result）
    if (pendingToolResults.length > 0) {
      result.push({ role: "user", content: pendingToolResults });
    }

    if (pending.length > 0) {
      result.push({ role: msg.role, content: pending });
    }
  }

  return result;
}

function blockToApiBlock(block: ContentBlock): LlmContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "tool_use":
      return { type: "tool_use", id: block.id, name: block.name, input: block.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
  }
}

// ─── Turn 循环 ───

async function runOuterTurn(
  apiMessages: MessageParam[],
  broadcast: BroadcastFn,
  mode: ChatMode,
): Promise<ChatMessage[]> {
  const newMessages: ChatMessage[] = [];
  const config = readConfig();
  const systemPrompt = getSystemPrompt(mode) + "\n\n" + getEnvironmentContext();

  while (true) {
    const llm = createLlmClient();

    // ─── 流式调用 LLM ───
    const stream = llm.messages.stream({
      model: config.llm.model,
      max_tokens: config.llm.max_tokens,
      system: systemPrompt,
      messages: apiMessages,
      tools: [GRAPH_EXPLORE_TOOL],
    });

    let fullText = "";

    stream.on("text", (text: string) => {
      fullText += text;
      broadcast("text_delta", { text });
    });

    let finalMessage: Message;
    try {
      finalMessage = await stream.finalMessage();
    } catch (err) {
      const errorMsg = String((err as Error)?.message ?? err);
      throw err;
    }

    // 分离 text 和 tool_use 块
    const responseContent = finalMessage.content;
    const toolUseBlocks: LlmToolUseBlock[] = [];
    const textBlocks: LlmTextBlock[] = [];

    for (const block of responseContent) {
      if (block.type === "tool_use") {
        toolUseBlocks.push(block as LlmToolUseBlock);
      } else if (block.type === "text") {
        textBlocks.push(block as LlmTextBlock);
      }
    }

    // 构建 ChatMessage content blocks
    const contentBlocks: ContentBlock[] = [];

    for (const tb of textBlocks) {
      if (tb.text) {
        contentBlocks.push({ type: "text", text: tb.text });
      }
    }

    const toolUseContentBlocks: ToolUseBlock[] = [];
    for (const tb of toolUseBlocks) {
      const block: ToolUseBlock = {
        type: "tool_use",
        id: tb.id,
        name: tb.name,
        input: (tb.input as Record<string, unknown>) ?? {},
      };
      contentBlocks.push(block);
      toolUseContentBlocks.push(block);
    }

    // 追加 assistant 消息到 API 历史
    apiMessages.push({
      role: "assistant",
      content: responseContent,
    });

    // 无 tool call → turn 结束
    if (toolUseBlocks.length === 0) {
      const msg: ChatMessage = {
        role: "assistant",
        content: contentBlocks.length === 0 ? fullText : contentBlocks,
        created_at: new Date().toISOString(),
      };
      newMessages.push(msg);

      // 异步持久化到 session（调用方负责）
      break;
    }

    // 构建 assistant ChatMessage（先把 text + tool_use 部分写入）
    const assistantMsg: ChatMessage = {
      role: "assistant",
      content: [...contentBlocks],
      created_at: new Date().toISOString(),
    };

    // ─── 执行 tool calls（并行/串行分组）───
    const toolResultBlocks: ToolResultBlock[] = [];
    const apiToolResults: ToolResultBlockParam[] = [];
    const resultByToolUseId = new Map<string, { summaryJson?: string; error?: string }>();

    // 分类：并行（只读）vs 串行（写操作）
    const parallelCalls: LlmToolUseBlock[] = [];
    const serialCalls: LlmToolUseBlock[] = [];

    for (const tb of toolUseBlocks) {
      if (tb.name !== "graph_explore") continue;
      (categorize(tb.name) === "parallel" ? parallelCalls : serialCalls).push(tb);
    }

    // 广播所有 tool_start（并行工具同时发出）
    for (const tb of [...parallelCalls, ...serialCalls]) {
      broadcast("tool_start", {
        tool_name: tb.name,
        tool_use_id: tb.id,
        args: (tb.input as Record<string, unknown>) ?? {},
      });
    }

    async function executeOneToolCall(tb: LlmToolUseBlock): Promise<void> {
      const args = (tb.input as Record<string, unknown>) ?? {};
      try {
        const explorationInput: ExplorationInput = {
          goal: typeof args.goal === "string" ? args.goal : "",
          seed_entities: Array.isArray(args.seed_entities)
            ? args.seed_entities.filter((e): e is string => typeof e === "string")
            : [],
          max_depth: typeof args.max_depth === "number" ? args.max_depth : 3,
          time_range: typeof args.time_range === "string" ? args.time_range : undefined,
        };

        // 执行内层探索，透传 step/finalize 事件，注入 tool_use_id 供前端区分并行交织
        const { output } = await runExploration(
          explorationInput,
          (event: StepEvent) => {
            const enriched = { ...event, tool_use_id: tb.id };
            if (event.type === "finalize") {
              broadcast("finalize", enriched);
            } else {
              // 所有步骤事件（含 error 类型）统一走 "step" 通道，
              // 避免 SSE "error" 事件触发前端 finishTurn 终止会话
              broadcast("step", enriched);
            }
          },
        );

        const summary = formatExplorationResult(
          output,
          explorationInput.goal,
          explorationInput.seed_entities,
        );

        broadcast("tool_result", {
          tool_name: tb.name,
          tool_use_id: tb.id,
          result: summary,
        });

        resultByToolUseId.set(tb.id, { summaryJson: JSON.stringify(summary) });
      } catch (err) {
        const errorMsg = String((err as Error)?.message ?? err);
        broadcast("tool_result", {
          tool_name: tb.name,
          tool_use_id: tb.id,
          is_error: true,
          error: errorMsg,
        });
        resultByToolUseId.set(tb.id, { error: errorMsg });
      }
    }

    // Phase A: 并行执行只读工具
    if (parallelCalls.length > 0) {
      await Promise.allSettled(parallelCalls.map((tb) => executeOneToolCall(tb)));
    }

    // Phase B: 串行执行写操作工具
    for (const tb of serialCalls) {
      await executeOneToolCall(tb);
    }

    // 按 toolUseBlocks 原始顺序收集结果
    for (const tb of toolUseBlocks) {
      const result = resultByToolUseId.get(tb.id);
      if (!result) continue;

      if (result.summaryJson) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tb.id,
          content: result.summaryJson,
        });
        apiToolResults.push({
          type: "tool_result",
          tool_use_id: tb.id,
          content: result.summaryJson,
        });
      } else if (result.error) {
        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: tb.id,
          content: `探索失败: ${result.error}`,
          is_error: true,
        });
        apiToolResults.push({
          type: "tool_result",
          tool_use_id: tb.id,
          content: `Exploration failed: ${result.error}`,
          is_error: true,
        });
      }
    }

    // 所有 tool_result 必须在同一条 user 消息中（紧跟 assistant tool_use 消息）
    if (apiToolResults.length > 0) {
      apiMessages.push({
        role: "user",
        content: apiToolResults,
      });
    }

    // 将 tool_result 追加到 assistant 消息的 content
    const finalContent: ContentBlock[] = [
      ...(Array.isArray(assistantMsg.content) ? assistantMsg.content : []),
      ...toolResultBlocks,
    ];
    assistantMsg.content = finalContent;
    newMessages.push(assistantMsg);

    // 继续 while — LLM 看到探索结果后生成文本回复
  }

  broadcast("message_complete", {});
  return newMessages;
}
