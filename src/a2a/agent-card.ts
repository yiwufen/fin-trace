// Agent Card — /.well-known/agent-card.json
//
// This is the machine-readable contract that tells A2A clients
// (e.g. OpenClaw's a2a_discover) what fin-trace can do.

import type { AgentCard } from "./types.js";

export function buildAgentCard(baseUrl: string): AgentCard {
  return {
    name: "fin-trace",
    description:
      "金融知识图谱多跳关系推理 Agent。在金融知识图谱上执行供应链追踪、传导路径分析、关联方排查。输入探索目标和起始实体，自主进行多跳探索，返回关键发现和事件脉络。",
    protocolVersion: "1.0.0",
    version: "1.0.0",
    url: `${baseUrl}/a2a`,
    capabilities: {
      streaming: true,
      pushNotifications: false,
    },
    skills: [
      {
        id: "graph_explore",
        name: "金融知识图谱多跳探索",
        description:
          "在金融知识图谱上执行多跳关系推理。给定探索目标和起始实体，自主进行多跳探索，返回结构化关键发现（findings）和事件脉络（event_threads）。适合供应链追踪、传导路径分析、关联方排查、竞争对手关系分析。不适合单实体事实查询。延迟：depth=1 约 3-5 分钟，depth=2 约 5-12 分钟。",
        tags: [
          "graph",
          "supply-chain",
          "sanctions",
          "multi-hop",
          "risk",
          "compliance",
          "financial-analysis",
        ],
        inputModes: ["text", "data"],
        outputModes: ["text", "data"],
      },
    ],
    defaultInputModes: ["text", "data"],
    defaultOutputModes: ["text", "data"],
    authentication: {
      schemes: ["bearer"],
    },
  };
}
