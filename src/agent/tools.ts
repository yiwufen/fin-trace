// 工具系统 — v3: 仅 5 个 MCP 工具（删除 recall 工具）
// 对应 design-docs/tools.md

import type { McpToolName } from "./state.js";

// ─── 工具名称 ───

export const MCP_TOOL_NAMES = ["lookup", "trace", "timeline", "expand", "scan"] as const;

export function isMcpTool(name: string): name is McpToolName {
  return (MCP_TOOL_NAMES as readonly string[]).includes(name);
}

// ─── MCP 工具输入参数类型 ───

export interface LookupInput {
  entities: string[];
  intent?: "ENTITY_OVERVIEW" | "ENTITY_TIMELINE";
  time_range?: string;
  top_k?: number;
}

export interface TraceInput {
  entity_a: string;
  entity_b: string;
  hops?: number;
  time_range?: string;
}

export interface TimelineInput {
  entity: string;
  time_range?: string;
  top_k?: number;
}

export interface ExpandInput {
  cluster_ids: string[];
}

export interface ScanInput {
  entities: string[];
  event_types?: string[];
  time_range?: string;
}

export type ToolInput =
  | LookupInput
  | TraceInput
  | TimelineInput
  | ExpandInput
  | ScanInput;

// ─── MCP 调用参数 ───

export interface McpSearchParams {
  entities: string[];
  intent: string;
  hops?: number;
  target_entity?: string;
  event_types?: string[];
  time_range?: string;
  top_k?: number;
}

export interface McpExpandParams {
  cluster_ids: string[];
}

export type McpCall =
  | { method: "search_knowledge"; params: McpSearchParams }
  | { method: "expand_graph_detail"; params: McpExpandParams };

// ─── 工具定义（供 LLM 系统提示参考）───

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "lookup",
    description: `查询一个或多个实体的基本信息和相关事件。

返回: entities(实体画像) + knowledge_units(事件摘要) + event_clusters(事件聚类) + graph_data.clusters_overview

典型用法:
- 第一次接触一个实体: lookup(["宁德时代"])
- 同时查多个实体对比: lookup(["宁德时代", "比亚迪"])
- 获取时间线: lookup(["宁德时代"], intent="ENTITY_TIMELINE")

想深入了解某个 cluster → 记下 cluster_id → 下一步用 expand 展开`,
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: { type: "string" },
          description: "实体中文名列表，如 ['宁德时代', '比亚迪']",
        },
        intent: {
          type: "string",
          enum: ["ENTITY_OVERVIEW", "ENTITY_TIMELINE"],
          default: "ENTITY_OVERVIEW",
          description: "ENTITY_OVERVIEW=综合概览, ENTITY_TIMELINE=时间线",
        },
        time_range: {
          type: "string",
          description: "可选，格式 '2024-01-01:2024-12-31'",
        },
        top_k: {
          type: "integer",
          default: 20,
          minimum: 1,
          maximum: 100,
        },
      },
      required: ["entities"],
    },
  },
  {
    name: "trace",
    description: `追踪两个实体间的关系路径——"A 和 B 怎么关联的"。

返回: 关系路径（含中间实体、关联事件）+ graph_data.clusters_overview

典型用法:
- 追两家公司关系: trace("宁德时代", "特斯拉")
- 追公司和事件关系: trace("宁德时代", "Northvolt")
- 如果想看路径上的具体事件 → 记下 cluster_id → 下一步用 expand 展开

限制: 一次只追一对实体。需要追多对就多次调用`,
    inputSchema: {
      type: "object",
      properties: {
        entity_a: {
          type: "string",
          description: "第一个实体的中文名",
        },
        entity_b: {
          type: "string",
          description: "第二个实体的中文名",
        },
        hops: {
          type: "integer",
          default: 2,
          minimum: 1,
          maximum: 1,
          description: "固定为 1——深度控制由 Agent Loop 执行",
        },
        time_range: {
          type: "string",
          description: "可选",
        },
      },
      required: ["entity_a", "entity_b"],
    },
  },
  {
    name: "timeline",
    description: `拉取一个实体的事件时间线，按时间排列。

返回: 按时间排列的事件列表 + 聚类概览

典型用法:
- 发现一个实体有多个事件 → timeline("宁德时代") 排时序
- 排完时序后 → LLM 判断事件发展链 → key_finding
- 发展链的触发源为外部实体 → 加入 frontier`,
    inputSchema: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          description: "实体中文名",
        },
        time_range: {
          type: "string",
          description: "可选时间范围 '2024-01-01:2024-12-31'",
        },
        top_k: {
          type: "integer",
          default: 20,
        },
      },
      required: ["entity"],
    },
  },
  {
    name: "expand",
    description: `展开事件聚类的完整详情——节点、边、路径。

返回: 聚类中的所有节点（实体和知识单元）、边（关系）、路径

典型用法:
- lookup/trace 返回的 cluster 看起来重要 → expand(["cluster_abc123"])
- 想看事件间的具体关联 → 展开聚类
- 展开后 → 新实体（聚类中的边指向的实体）→ 加入 frontier

建议一次 ≤ 5 个 cluster_id，cluster_id 必须来自之前工具返回的 clusters_overview`,
    inputSchema: {
      type: "object",
      properties: {
        cluster_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "聚类 ID 列表，来自 search_knowledge 返回的 graph_data.clusters_overview[].cluster_id",
        },
      },
      required: ["cluster_ids"],
    },
  },
  {
    name: "scan",
    description: `批量筛选实体是否有特定类型的事件。

返回: 匹配到的实体和事件列表

典型用法:
- 验证假设: "这些供应商中有多少被制裁过" → scan(["SupplierA","SupplierB","SupplierC"], ["政策制裁/出口管制"])
- 发现模式: "有没有供应中断事件" → scan(frontier_entities, ["供应链中断/调整"])
- 确认比例 → key_finding (concentration 类型)

可用的事件类型（传给 event_types）:
  政策制裁/出口管制、股市波动/市场异动、企业并购/重组、供应链中断/调整、
  财报发布/业绩预告、监管处罚/合规调查、关税调整/贸易协定、高管变动/人事调整、
  IPO/融资事件、地缘政治影响`,
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          items: { type: "string" },
          description: "要检查的实体中文名列表",
        },
        event_types: {
          type: "array",
          items: { type: "string" },
          description:
            "事件类型过滤，如 ['政策制裁/出口管制', '供应链中断/调整']",
        },
        time_range: {
          type: "string",
          description: "可选",
        },
      },
      required: ["entities"],
    },
  },
];

// ─── MCP 工具参数 → MCP 调用参数映射 ───

export function mapToMcpCall(toolName: McpToolName, args: ToolInput): McpCall {
  switch (toolName) {
    case "lookup": {
      const a = args as LookupInput;
      return {
        method: "search_knowledge",
        params: {
          entities: a.entities,
          intent: a.intent ?? "ENTITY_OVERVIEW",
          hops: 1,
          time_range: a.time_range,
          top_k: a.top_k,
        },
      };
    }
    case "trace": {
      const a = args as TraceInput;
      return {
        method: "search_knowledge",
        params: {
          entities: [a.entity_a],
          intent: "RELATIONSHIP_QUERY",
          target_entity: a.entity_b,
          hops: 2,
          time_range: a.time_range,
        },
      };
    }
    case "timeline": {
      const a = args as TimelineInput;
      return {
        method: "search_knowledge",
        params: {
          entities: [a.entity],
          intent: "ENTITY_TIMELINE",
          time_range: a.time_range,
          top_k: a.top_k,
        },
      };
    }
    case "expand": {
      const a = args as ExpandInput;
      return {
        method: "expand_graph_detail",
        params: { cluster_ids: a.cluster_ids },
      };
    }
    case "scan": {
      const a = args as ScanInput;
      return {
        method: "search_knowledge",
        params: {
          entities: a.entities,
          intent: "EVENT_ANALYSIS",
          event_types: a.event_types,
          time_range: a.time_range,
        },
      };
    }
  }
}
