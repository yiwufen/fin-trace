// dsh web 客户端半边 — classic-script bundle（window.__ModuleLoader__.load 工厂形式，见 tsup.config.ts）
//
// 注册 fintrace_* 三工具的 tool.call.toolview 自定义卡片：
//   - StartCard：探索任务的实时过程面板（运行中每 3s 轮询宿主 /fintrace/task，
//     渲染 step/决策/计数/预算条/最近步骤时间线；settle 后定格终态摘要）
//   - StatusCard：按结果侧 presentationMeta（宿主 tool/result 事件持久化）渲染四态快照
//   - CancelCard：取消结果简单渲染
// 组件只读 block（frozen 调用/结果切片），live 与会话回放共用同一渲染路径。

import { useEffect, useState } from "react";
import type { CSSProperties, FC } from "react";

export const inject = ["slots"];

// ─── 宿主契约最小本地类型（对应 dsh-client-runtime ToolCallBlock / dsh-client-ui-tool ToolCallOwnerProps）───

interface RunningToolCall {
  callId: string;
  name: string;
  argsRaw: string;
}

interface ToolResultNode {
  kind: "tool-result";
  callId: string;
  content: readonly { type: string; text?: string }[];
  isError: boolean;
  error?: { name: string; code: string };
  /** presentationMeta 投影（宿主 tool/result 事件持久化，随会话回放） */
  meta?: unknown;
  call: { name: string; argsRaw: string } | null;
}

type ToolCallBlock = RunningToolCall | ToolResultNode;

interface ToolCallOwnerProps {
  callId?: string;
  toolName?: string;
  block: ToolCallBlock;
}

interface SlotCtx {
  slots: {
    inject(name: string, callback: () => unknown): unknown;
    register(options: { name: string; key: string }, Component: FC<ToolCallOwnerProps>): () => void;
  };
}

// ─── 数据形状（与宿主端 taskSnapshot / StatusCardMeta / presentationMeta 对应）───

interface TaskSnapshot {
  task_id: string;
  status: "running" | "completed" | "failed" | "canceled";
  created_at: string;
  elapsed_ms: number;
  progress?: {
    step: number;
    decision?: string;
    total_findings: number;
    total_entities: number;
    total_events: number;
    budget_used: number;
    budget_limit: number;
  };
  recent_steps?: {
    step: number;
    type: string;
    phase: string;
    decision?: string;
    detail?: string;
    error?: string;
  }[];
  summary?: {
    counts: { findings: number; entities: number; events: number; threads: number; tokens: number };
    completion_reason?: string;
    reliability_note?: string | null;
    top_findings: { category: string; statement: string; confidence: string }[];
    threads?: { title: string; confidence: string }[];
  };
  error?: string;
}

interface StatusCardMeta {
  status?: string;
  progress?: { step: number; decision?: string; findings: number; entities: number; events: number };
  counts?: { findings: number; entities: number; threads: number; tokens: number };
  completion_reason?: string;
  recent_steps?: { step: number; type: string; decision?: string; detail?: string }[];
  top_findings?: { category: string; statement: string; confidence: string }[];
  error?: string;
}

// ─── 工具函数 ───

const isSettled = (block: ToolCallBlock): block is ToolResultNode => "kind" in block;

const resultText = (block: ToolCallBlock): string =>
  isSettled(block)
    ? block.content
        .map((c) => (c.type === "text" ? c.text ?? "" : ""))
        .join("\n")
        .trim()
    : "";

const argsJson = (block: ToolCallBlock): Record<string, unknown> => {
  const raw = isSettled(block) ? block.call?.argsRaw : block.argsRaw;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const metaOf = <T,>(block: ToolCallBlock): T | undefined => (isSettled(block) ? (block.meta as T | undefined) : undefined);

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

const fmtElapsed = (ms: number): string => {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
};

const fmtTokens = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const STATUS_LABEL: Record<string, string> = {
  running: "探索进行中",
  completed: "探索完成",
  failed: "探索失败",
  canceled: "已取消",
};
const STATUS_COLOR: Record<string, string> = {
  running: "#f59f00",
  completed: "#2f9e44",
  failed: "#fa5252",
  canceled: "#868e96",
};
const CONFIDENCE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };

// ─── 样式（inline + dsw tokens，带硬编码兜底）───

const CARD: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  padding: "8px 10px",
  borderRadius: 8,
  border: "1px solid var(--dsw-alias-border-l1, #e2e2e5)",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-primary, inherit)",
};

const HEADER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontWeight: 600,
};

const DOT: CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: "50%",
  flexShrink: 0,
};

const METRICS: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "2px 12px",
  color: "var(--dsw-alias-label-secondary, #7a7a80)",
};

const METRIC_VALUE: CSSProperties = {
  color: "var(--dsw-alias-label-primary, inherit)",
  fontVariantNumeric: "tabular-nums",
  fontWeight: 600,
};

const TIMELINE: CSSProperties = {
  maxHeight: 168,
  overflowY: "auto",
  fontFamily: "var(--dsw-font-mono, ui-monospace, monospace)",
  fontSize: 11,
  lineHeight: 1.7,
  color: "var(--dsw-alias-label-secondary, #7a7a80)",
};

const BUDGET_TRACK: CSSProperties = {
  height: 4,
  borderRadius: 2,
  background: "var(--dsw-alias-surface-inset, #ececf0)",
  overflow: "hidden",
};

const FINDING_ITEM: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "baseline",
};

const CATEGORY_LABEL: Record<string, string> = {
  pattern_violation: "模式异常",
  concentration: "集中度",
  chain: "链条",
  absence: "缺失",
};

function CategoryTag({ category }: { category: string }) {
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: 10,
        padding: "0 5px",
        borderRadius: 4,
        background: "var(--dsw-alias-surface-inset, #ececf0)",
        color: "var(--dsw-alias-label-secondary, #7a7a80)",
      }}
    >
      {CATEGORY_LABEL[category] ?? category}
    </span>
  );
}

function ConfidenceTag({ confidence }: { confidence: string }) {
  const color =
    confidence === "high" ? "#2f9e44" : confidence === "medium" ? "#f59f00" : "#868e96";
  return <span style={{ flexShrink: 0, fontSize: 10, color }}>{confidence}</span>;
}

function StatusDot({ status }: { status: string }) {
  const base = STATUS_COLOR[status] ?? "#868e96";
  return (
    <span
      style={{
        ...DOT,
        background: base,
        ...(status === "running" ? { animation: "fintrace-pulse 1.6s ease-in-out infinite" } : {}),
      }}
    />
  );
}

// 全局 keyframes 只注入一次
let pulseInjected = false;
function injectPulseKeyframes(): void {
  if (pulseInjected || typeof document === "undefined") return;
  if (!document.getElementById("fintrace-pulse-keyframes")) {
    const style = document.createElement("style");
    style.id = "fintrace-pulse-keyframes";
    style.textContent = "@keyframes fintrace-pulse{0%,100%{opacity:1}50%{opacity:.35}}";
    document.head.appendChild(style);
  }
  pulseInjected = true;
}

// ─── /fintrace/task 轮询 hook ───

function useTaskPoll(taskId: string | undefined): TaskSnapshot | undefined {
  const [snap, setSnap] = useState<TaskSnapshot | undefined>(undefined);
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await fetch(`/fintrace/task?id=${encodeURIComponent(taskId)}`);
        if (!alive) return;
        if (r.ok) {
          const s = (await r.json()) as TaskSnapshot;
          setSnap(s);
          if (s.status === "running") timer = setTimeout(tick, 3000);
        } else if (r.status !== 404) {
          // 宿主异常：退避重试
          timer = setTimeout(tick, 6000);
        }
        // 404（TTL 清理/重启丢失）：定格已提交视图，不再轮询
      } catch {
        if (alive) timer = setTimeout(tick, 6000);
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);
  return snap;
}

// ─── StartCard：实时探索过程面板 ───

function taskIdOf(block: ToolCallBlock): string | undefined {
  const m = metaOf<{ task_id?: string }>(block);
  if (m?.task_id) return m.task_id;
  const hit = /task_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(
    resultText(block),
  );
  return hit?.[1];
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span>
      {label} <span style={METRIC_VALUE}>{value}</span>
    </span>
  );
}

function StartCard({ block }: ToolCallOwnerProps) {
  useEffect(injectPulseKeyframes);
  const settled = isSettled(block);
  const args = argsJson(block);
  const goal = typeof args.goal === "string" ? args.goal : "";
  const taskId = taskIdOf(block);
  const snap = useTaskPoll(settled && !block.isError ? taskId : undefined);

  // 未结算（提交瞬间）或无 taskId（异常路径）：静态提交视图
  const status = snap?.status;
  const p = snap?.progress;
  const s = snap?.summary;

  return (
    <div style={CARD} data-tool="fintrace_explore_start" data-state={status ?? (settled ? "settled" : "running")}>
      <div style={HEADER}>
        <StatusDot status={status ?? (settled ? "canceled" : "running")} />
        <span>{status ? STATUS_LABEL[status] : "已提交探索任务"}</span>
        {status === "running" && snap ? <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums", fontWeight: 400 }}>{fmtElapsed(snap.elapsed_ms)}</span> : null}
      </div>
      {goal ? <div>{truncate(goal, 120)}</div> : null}

      {status === "running" && p ? (
        <>
          <div style={METRICS}>
            <Metric label="step" value={String(p.step)} />
            <Metric label="实体" value={String(p.total_entities)} />
            <Metric label="findings" value={String(p.total_findings)} />
            <Metric label="事件" value={String(p.total_events)} />
          </div>
          {p.budget_limit > 0 ? (
            <div style={BUDGET_TRACK} title={`token 预算 ${fmtTokens(p.budget_used)} / ${fmtTokens(p.budget_limit)}`}>
              <div
                style={{
                  height: "100%",
                  width: `${Math.min(100, Math.round((p.budget_used / p.budget_limit) * 100))}%`,
                  background: STATUS_COLOR.running,
                  transition: "width .6s ease",
                }}
              />
            </div>
          ) : null}
          {p.decision ? <div style={{ color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>当前决策：{p.decision}</div> : null}
          {snap?.recent_steps?.length ? (
            <div style={TIMELINE}>
              {snap.recent_steps.map((st, i) => (
                <div key={`${st.step}-${st.type}-${i}`}>
                  [{String(st.step).padStart(2, " ")}] {st.decision ?? st.detail ?? st.type}
                  {st.error ? ` — ${st.error}` : ""}
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : null}

      {status === "completed" && s ? (
        <>
          <div style={METRICS}>
            <Metric label="findings" value={String(s.counts.findings)} />
            <Metric label="threads" value={String(s.counts.threads)} />
            <Metric label="实体" value={String(s.counts.entities)} />
            <Metric label="tokens" value={fmtTokens(s.counts.tokens)} />
          </div>
          {s.top_findings.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {s.top_findings
                .slice()
                .sort((a, b) => (CONFIDENCE_ORDER[a.confidence] ?? 9) - (CONFIDENCE_ORDER[b.confidence] ?? 9))
                .map((f, i) => (
                  <div style={FINDING_ITEM} key={i}>
                    <CategoryTag category={f.category} />
                    <ConfidenceTag confidence={f.confidence} />
                    <span>{truncate(f.statement, 110)}</span>
                  </div>
                ))}
            </div>
          ) : null}
          {s.completion_reason ? (
            <div style={{ color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>完成原因：{s.completion_reason}</div>
          ) : null}
        </>
      ) : null}

      {status === "failed" ? <div style={{ color: STATUS_COLOR.failed }}>{snap?.error ?? "任务失败"}</div> : null}
      {status === "canceled" ? (
        <div style={{ color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>
          已取消；已产出的 findings 保留在结果中
          {s?.counts.findings ? `（${s.counts.findings} 条）` : ""}
        </div>
      ) : null}

      {/* 提交完成但端点无数据（宿主重启/降级/headless 提交的历史会话回放）：回退静态视图 */}
      {settled && !snap ? (
        <div style={{ color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>
          {block.isError
            ? "任务提交失败"
            : `任务已提交${taskId ? `（task_id: ${truncate(taskId, 13)}…）` : ""}，实时进度不可用`}
        </div>
      ) : null}
    </div>
  );
}

// ─── StatusCard：四态快照（数据源为结果侧 presentationMeta）───

function StatusCard({ block }: ToolCallOwnerProps) {
  useEffect(injectPulseKeyframes);
  if (!isSettled(block)) {
    return (
      <div style={CARD} data-tool="fintrace_explore_status" data-state="running">
        <div style={HEADER}>
          <StatusDot status="running" />
          <span>查询探索进度…</span>
        </div>
      </div>
    );
  }
  if (block.isError) {
    return (
      <div style={CARD} data-tool="fintrace_explore_status" data-state="error">
        <div style={HEADER}>
          <StatusDot status="failed" />
          <span>探索进度查询失败</span>
        </div>
        {resultText(block) ? <div style={TIMELINE}>{truncate(resultText(block), 300)}</div> : null}
      </div>
    );
  }
  const m = metaOf<StatusCardMeta>(block);
  if (!m) {
    // 旧会话无投影：文本兜底
    return (
      <div style={CARD} data-tool="fintrace_explore_status" data-state="unknown">
        <div style={HEADER}>探索进度</div>
        <div style={TIMELINE}>{truncate(resultText(block), 400)}</div>
      </div>
    );
  }
  const status = m.status ?? "unknown";
  return (
    <div style={CARD} data-tool="fintrace_explore_status" data-state={status}>
      <div style={HEADER}>
        <StatusDot status={status} />
        <span>{STATUS_LABEL[status] ?? `任务状态：${status}`}</span>
        {status === "running" ? (
          <span style={{ marginLeft: "auto", fontWeight: 400, color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>
            快照（卡片不自动刷新）
          </span>
        ) : null}
      </div>

      {status === "running" && m.progress ? (
        <>
          <div style={METRICS}>
            <Metric label="step" value={String(m.progress.step)} />
            <Metric label="实体" value={String(m.progress.entities)} />
            <Metric label="findings" value={String(m.progress.findings)} />
            <Metric label="事件" value={String(m.progress.events)} />
          </div>
          {m.progress.decision ? (
            <div style={{ color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>当前决策：{m.progress.decision}</div>
          ) : null}
        </>
      ) : null}

      {m.recent_steps?.length ? (
        <div style={TIMELINE}>
          {m.recent_steps.map((st, i) => (
            <div key={i}>
              [{String(st.step).padStart(2, " ")}] {st.decision ?? st.detail ?? st.type}
            </div>
          ))}
        </div>
      ) : null}

      {status === "completed" && m.counts ? (
        <>
          <div style={METRICS}>
            <Metric label="findings" value={String(m.counts.findings)} />
            <Metric label="threads" value={String(m.counts.threads)} />
            <Metric label="tokens" value={fmtTokens(m.counts.tokens)} />
          </div>
          {m.top_findings?.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {m.top_findings.map((f, i) => (
                <div style={FINDING_ITEM} key={i}>
                  <CategoryTag category={f.category} />
                  <ConfidenceTag confidence={f.confidence} />
                  <span>{truncate(f.statement, 110)}</span>
                </div>
              ))}
            </div>
          ) : null}
          {m.completion_reason ? (
            <div style={{ color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>完成原因：{m.completion_reason}</div>
          ) : null}
        </>
      ) : null}

      {status === "failed" ? <div style={{ color: STATUS_COLOR.failed }}>{m.error ?? "任务失败"}</div> : null}
      {status === "canceled" ? (
        <div style={{ color: "var(--dsw-alias-label-secondary, #7a7a80)" }}>已取消；已产出的 findings 保留在结果中</div>
      ) : null}
    </div>
  );
}

// ─── CancelCard ───

function CancelCard({ block }: ToolCallOwnerProps) {
  if (!isSettled(block)) {
    return (
      <div style={CARD} data-tool="fintrace_explore_cancel" data-state="running">
        <div style={HEADER}>
          <StatusDot status="running" />
          <span>取消探索任务…</span>
        </div>
      </div>
    );
  }
  const m = metaOf<{ status?: string; message?: string | null }>(block);
  const canceled = m?.status === "canceled";
  return (
    <div style={CARD} data-tool="fintrace_explore_cancel" data-state={block.isError ? "error" : m?.status ?? "unknown"}>
      <div style={HEADER}>
        <StatusDot status={block.isError ? "failed" : canceled ? "canceled" : "completed"} />
        <span>{block.isError ? "取消请求失败" : canceled ? "已发送取消信号" : `任务状态：${m?.status ?? "—"}`}</span>
      </div>
      {block.isError
        ? truncate(resultText(block), 200)
        : canceled
          ? "探索循环将优雅收尾（保留已产出的 findings），结果仍可用 fintrace_explore_status 读取"
          : m?.message ?? ""}
    </div>
  );
}

// ─── 插件体 ───

export function apply(ctx: SlotCtx) {
  ctx.slots.inject("tool.call.toolview", () => [
    ctx.slots.register({ name: "tool.call.toolview", key: "fintrace_explore_start" }, StartCard),
    ctx.slots.register({ name: "tool.call.toolview", key: "fintrace_explore_status" }, StatusCard),
    ctx.slots.register({ name: "tool.call.toolview", key: "fintrace_explore_cancel" }, CancelCard),
  ]);
}
