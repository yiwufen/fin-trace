// A2A protocol types — mapped from A2A v1.0 spec
//
// Task is the core unit of work. It progresses through:
//   submitted → working → input-required → completed / failed / canceled / rejected

import type { ExplorationOutput } from "../agent/state.js";

// ─── Agent Card (/.well-known/agent-card.json) ───

export interface AgentCard {
  name: string;
  description: string;
  protocolVersion: string;
  version: string;
  url: string;
  capabilities: {
    streaming: boolean;
    pushNotifications?: boolean;
  };
  skills: AgentCardSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  authentication?: {
    schemes: string[];
  };
}

export interface AgentCardSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputModes: string[];
  outputModes: string[];
}

// ─── Task ───

export type TaskStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

export interface Task {
  taskId: string;
  status: TaskStatus;
  createdAt: string;
  params: GraphExploreParams;
  statusMessage?: TaskStatusMessage;
  artifacts?: Artifact[];
  abortController: AbortController;
  // set when exploration completes or fails
  output?: ExplorationOutput;
  error?: string;
}

export interface GraphExploreParams {
  goal: string;
  seed_entities: string[];
  max_depth: number;
  time_range?: string;
}

export interface TaskStatusMessage {
  parts: MessagePart[];
  metadata?: Record<string, unknown>;
}

// ─── Message ───

export interface Message {
  messageId: string;
  role: "user" | "agent";
  parts: MessagePart[];
}

export type MessagePart = TextPart | FilePart | DataPart;

export interface TextPart {
  type: "text";
  text: string;
}

export interface FilePart {
  type: "file";
  file: {
    uri?: string;
    bytes?: string; // base64
    mimeType?: string;
  };
}

export interface DataPart {
  type: "data";
  data: Record<string, unknown>;
}

// ─── Artifact ───

export interface Artifact {
  artifactId: string;
  parts: MessagePart[];
}

// ─── JSON-RPC ───

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ─── A2A method params ───

export interface TasksSendParams {
  message: Message;
}

export interface TasksGetParams {
  taskId: string;
}

export interface TasksCancelParams {
  taskId: string;
}
