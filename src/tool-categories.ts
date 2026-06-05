// 工具分类 — 并行工具集（只读）和串行工具集（写操作）
//
// 所有只读工具可安全并发执行。写操作工具必须串行（当前为空，预留）。
// 未分类的新工具默认串行——安全优先。

// ─── 并行工具（只读）───

const PARALLEL_TOOLS = new Set([
  "graph_explore", // chat 层探索
  "lookup",        // agent 层实体查询
  "trace",         // agent 层关系追踪
  "timeline",      // agent 层事件时间线
  "expand",        // agent 层聚类展开
  "scan",          // agent 层批量筛选
]);

// ─── 串行工具（写操作）───

const SERIAL_TOOLS = new Set<string>([]);

// ─── 类型 ───

export type ToolCategory = "parallel" | "serial";

// ─── 分类函数 ───

export function categorize(name: string): ToolCategory {
  if (SERIAL_TOOLS.has(name)) return "serial";
  if (!PARALLEL_TOOLS.has(name)) return "serial"; // 未分类默认串行
  return "parallel";
}
