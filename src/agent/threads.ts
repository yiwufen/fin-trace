// Event Thread 构建与验证 — v3: 使用 raw_event_archive（替代 event_buffer）

import type { RawEvent, EventThread } from "./state.js";

const VALID_RELATION_TYPES = new Set(["causal", "temporal", "entity_shared", "contradiction"]);

export interface ThreadValidationResult {
  threads: EventThread[];
  warnings: string[];
}

// ─── 时间解析 ───

function parseTimestamp(ts: string): number {
  const iso = Date.parse(ts);
  if (!isNaN(iso)) return iso;

  const quarterMatch = ts.match(/^(\d{4})-Q(\d)$/);
  if (quarterMatch) {
    const month = parseInt(quarterMatch[2]) * 3 - 2;
    return Date.parse(`${quarterMatch[1]}-${String(month).padStart(2, "0")}-01`);
  }

  const monthMatch = ts.match(/^(\d{4})-(\d{2})$/);
  if (monthMatch) return Date.parse(`${ts}-01`);

  const yearMatch = ts.match(/^(\d{4})$/);
  if (yearMatch) return Date.parse(`${ts}-01-01`);

  return 0;
}

// ─── Thread 验证 ───

export function validateThreads(
  threads: EventThread[],
  rawEventArchive: RawEvent[],
): ThreadValidationResult {
  const archiveKuIds = new Set(rawEventArchive.map((e) => e.ku_id));
  const validThreads: EventThread[] = [];
  const warnings: string[] = [];

  for (const thread of threads) {
    const problems: string[] = [];

    // 校验 1: ku_id 存在性
    const validEvents = thread.thread_events.filter((event) => {
      if (!archiveKuIds.has(event.ku_id)) {
        problems.push(`事件 ${event.ku_id} 不在 raw_event_archive 中 — hallucination`);
        return false;
      }
      return true;
    });

    // 校验 1b: streaming_snapshot 不进因果链
    const snapshotRemoved: string[] = [];
    const causalEvents = validEvents.filter((event) => {
      const archiveEvent = rawEventArchive.find((e) => e.ku_id === event.ku_id);
      if (archiveEvent?.event_data_type === "streaming_snapshot") {
        snapshotRemoved.push(event.ku_id);
        return false;
      }
      return true;
    });
    if (snapshotRemoved.length > 0) {
      problems.push(`移除 ${snapshotRemoved.length} 个流式快照事件: ${snapshotRemoved.join(", ")}`);
    }

    if (causalEvents.length < 3) {
      warnings.push(
        `Thread "${thread.title}" 移除无效事件后只剩 ${causalEvents.length} 个事件，丢弃`,
      );
      continue;
    }

    thread.thread_events = causalEvents;

    // 更新 relationship indices
    thread.relationships = thread.relationships.filter(
      (rel) => rel.from_idx < causalEvents.length && rel.to_idx < causalEvents.length,
    );

    // 校验 2: 时间线一致性
    for (const rel of thread.relationships) {
      const fromEvent = causalEvents[rel.from_idx];
      const toEvent = causalEvents[rel.to_idx];
      if (fromEvent.timestamp && toEvent.timestamp) {
        const fromTs = parseTimestamp(fromEvent.timestamp);
        const toTs = parseTimestamp(toEvent.timestamp);
        if (fromTs > 0 && toTs > 0 && rel.type === "causal" && fromTs > toTs) {
          problems.push(
            `因果顺序错误: 事件 ${rel.from_idx} 在 ${rel.to_idx} 之后`,
          );
        }
      }
    }

    // 校验 3: 关系类型合法性
    for (const rel of thread.relationships) {
      if (!VALID_RELATION_TYPES.has(rel.type)) {
        rel.type = "entity_shared";
        problems.push("非法关系类型，已钳制为 entity_shared");
      }
    }

    // 校验 4: Thread 过长
    if (causalEvents.length > 10) {
      warnings.push(
        `Thread "${thread.title}" 有 ${causalEvents.length} 个事件，可能是过度串连`,
      );
    }

    if (problems.length > 0) {
      warnings.push(
        `Thread "${thread.title}" 有 ${problems.length} 个问题: ${problems.join("; ")}`,
      );
    }

    validThreads.push(thread);
  }

  return { threads: validThreads, warnings };
}
