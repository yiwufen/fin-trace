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
  event_types?: string[];
}

export interface TraceInput {
  entity_a: string;
  entity_b: string;
  hops?: number;
  time_range?: string;
  event_types?: string[];
}

export interface TimelineInput {
  entity: string;
  time_range?: string;
  top_k?: number;
  event_types?: string[];
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

// ─── 事件类型闭集（KG 服务端 32 类 canonical）───
// 中文别名由服务端归一化；未知类型服务端报错并列出合法值。
// 供 scan 的 LLM 可见描述与测试契约使用。

export const EVENT_TYPES = [
  // 公司资本类
  "restructuring", "ipo", "shareholding_change", "equity_pledge", "dividend",
  "company_establishment", "investment",
  // 公司经营类
  "financial_performance", "product_launch", "business_strategy", "executive_change",
  // 公司风险类
  "debt_default", "legal_proceeding", "risk_warning",
  // 市场分析类
  "stock_price_change", "price_change", "sector_performance", "market_analysis",
  "industry_analysis", "rating_change",
  // 监管类
  "regulatory_action", "sanction", "policy_announcement",
  // 宏观类
  "economic_data", "trade_data",
  // 影响因素类
  "diplomatic_event", "military_action", "political_statement",
  // 关系/披露类
  "strategic_cooperation", "disclosure", "meeting", "non_financial",
] as const;

// ─── time_range 校验（服务端要求双端 ISO 日期，不支持开放区间）───

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validateTimeRange(timeRange: string | undefined): string | null {
  if (timeRange === undefined) return null;
  const parts = timeRange.split(":");
  if (parts.length !== 2 || !ISO_DATE.test(parts[0]) || !ISO_DATE.test(parts[1])) {
    return `time_range 必须为双端 ISO 日期 'YYYY-MM-DD:YYYY-MM-DD'（不支持开放区间），收到 '${timeRange}'`;
  }
  return null;
}

// 工具级参数校验入口 —— 映射层收口，非法参数不发网络请求
export function validateToolArgs(toolName: McpToolName, args: ToolInput): string | null {
  const timeRange = (args as { time_range?: string }).time_range;
  return validateTimeRange(timeRange);
}

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

想深入了解某个 cluster → 记下 cluster_id → 下一步用 expand 展开

event_types 过滤指引: 首轮摸底/陌生实体不要过滤（先看全貌）；
定向子目标（制裁暴露、债务风险、监管动态等）带 event_types 过滤——
热点实体不带过滤的返回很大且慢，过滤可数十倍缩减。取值见 scan 工具的 32 类闭集`,
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
        event_types: {
          type: "array",
          items: { type: "string" },
          description: "可选事件类型过滤（定向子目标用），取值同 scan 工具的 32 类闭集，也接受中文别名",
        },
        time_range: {
          type: "string",
          description: "可选，格式 '2024-01-01:2024-12-31'（双端必填，不支持开放区间）",
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
          minimum: 2,
          maximum: 2,
          description:
            "固定为 2——KG 为实体-事件二部图，1 语义跳（实体→事件→实体）= 2 条边；映射层固定传 2，深度控制由 Agent Loop 组合调用实现",
        },
        event_types: {
          type: "array",
          items: { type: "string" },
          description: "可选事件类型过滤（只追某类事件关联时用），取值同 scan 工具的 32 类闭集",
        },
        time_range: {
          type: "string",
          description: "可选，格式 '2024-01-01:2024-12-31'（双端必填，不支持开放区间）",
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
          description: "可选时间范围 '2024-01-01:2024-12-31'（双端必填，不支持开放区间）",
        },
        top_k: {
          type: "integer",
          default: 20,
        },
        event_types: {
          type: "array",
          items: { type: "string" },
          description: "可选事件类型过滤（只看某类事件脉络时用），取值同 scan 工具的 32 类闭集",
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
- 验证假设: "这些供应商中有多少被制裁过" → scan(["SupplierA","SupplierB","SupplierC"], ["sanction"])
- 发现模式: "有没有债务违约事件" → scan(frontier_entities, ["debt_default"])
- 确认比例 → key_finding (concentration 类型)

可用的事件类型（32 类闭集；传 canonical 英文值或中文别名均可，服务端归一化，
未知类型会报错并列出合法值）:
  公司资本类: restructuring(重组/并购)、ipo(上市/增发)、shareholding_change(增减持/大宗交易)、
    equity_pledge(股权质押)、dividend(分红/派息)、company_establishment(企业设立)、investment(投资/融资)
  公司经营类: financial_performance(财报/业绩)、product_launch(产品发布)、business_strategy(企业战略)、
    executive_change(高管变动/实控人变动)
  公司风险类: debt_default(债务违约)、legal_proceeding(诉讼)、risk_warning(风险提示)
  市场分析类: stock_price_change(股价)、price_change(商品价格)、sector_performance(板块表现)、
    market_analysis(市场分析)、industry_analysis(行业分析)、rating_change(评级调整/目标价)
  监管类: regulatory_action(监管处罚)、sanction(制裁)、policy_announcement(政策发布)
  宏观类: economic_data(经济数据)、trade_data(贸易数据)
  影响因素类: diplomatic_event(外交)、military_action(军事)、political_statement(政治声明)
  关系/披露类: strategic_cooperation(战略合作/签约)、disclosure(澄清/回应/停牌)、meeting(会议)、
    non_financial(明确非金融内容)`,
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
            "事件类型过滤，canonical 值如 ['sanction', 'debt_default']，也接受中文别名（服务端归一化）",
        },
        time_range: {
          type: "string",
          description: "可选，格式 '2024-01-01:2024-12-31'（双端必填，不支持开放区间）",
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
          event_types: a.event_types,
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
          event_types: a.event_types,
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
          event_types: a.event_types,
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
