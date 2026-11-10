// LLM API 错误归因 — 将 SDK 原始报错映射为结构化、人类可读的原因
//
// 服务端链路（chat 外层 / agent 内层 / api.ts SSE broadcast）统一使用：
//   - 原始错误只进服务端日志（log.error / sl.error）
//   - 前端只收到 { error: "当前模型不可用：{原因}", kind } 的 SSE error payload

// ─── 错误类别 ───

export type LlmErrorKind =
  | "auth_invalid"
  | "quota_exhausted"
  | "rate_limited"
  | "model_not_found"
  | "network_unreachable"
  | "timeout"
  | "unknown";

/** 各类别对应的稳定中文短语（面向最终用户） */
export const LLM_USER_MESSAGES: Record<LlmErrorKind, string> = {
  auth_invalid: "API 密钥无效或未授权",
  quota_exhausted: "API 额度不足或已耗尽",
  rate_limited: "API 请求过于频繁（限流）",
  model_not_found: "配置的模型不存在",
  network_unreachable: "无法连接模型服务（网络不可达）",
  timeout: "连接模型服务超时",
  unknown: "模型服务异常",
};

/** SSE / 用户提示统一前缀 */
export const MODEL_UNAVAILABLE_PREFIX = "当前模型不可用";

/** 确定性故障：重试必然失败，探索循环应立即终止（不进入重试/降级） */
export const DETERMINISTIC_LLM_FAILURES: readonly LlmErrorKind[] = [
  "auth_invalid",
  "quota_exhausted",
  "model_not_found",
  "network_unreachable",
];

export function isDeterministicLlmFailure(kind: LlmErrorKind): boolean {
  return DETERMINISTIC_LLM_FAILURES.includes(kind);
}

// ─── 结构化错误（跨层传递 kind + userMessage）───

export class LlmApiError extends Error {
  readonly kind: LlmErrorKind;
  readonly userMessage: string;
  readonly rawError?: unknown;

  constructor(kind: LlmErrorKind, userMessage: string, rawError?: unknown) {
    super(`${MODEL_UNAVAILABLE_PREFIX}：${userMessage}`);
    this.name = "LlmApiError";
    this.kind = kind;
    this.userMessage = userMessage;
    this.rawError = rawError;
  }
}

// ─── 分类（纯函数）───

interface ErrorLike {
  message?: unknown;
  status?: unknown;
  code?: unknown;
  name?: unknown;
  error?: { code?: unknown; message?: unknown; type?: unknown };
}

/** 从 err 的 status / code / message 中提取可判定的特征文本 */
function errorSignature(err: unknown): { status: number | undefined; text: string } {
  const e = (err ?? {}) as ErrorLike;
  const status = typeof e.status === "number" ? e.status : undefined;
  const parts: string[] = [
    typeof e.message === "string" ? e.message : String(err ?? ""),
    typeof e.name === "string" ? e.name : "",
    typeof e.code === "string" ? e.code : "",
    typeof e.error?.code === "string" ? e.error.code : "",
    typeof e.error?.message === "string" ? e.error.message : "",
    typeof e.error?.type === "string" ? e.error.type : "",
  ];
  return { status, text: parts.join(" \n ").toLowerCase() };
}

export function classifyLlmError(err: unknown): { kind: LlmErrorKind; userMessage: string } {
  const { status, text } = errorSignature(err);
  let kind: LlmErrorKind = "unknown";

  // 超时 / 中止（先于网络不可达：ETIMEDOUT 与 ECONNREFUSED 语义不同）
  if (
    status === 408 ||
    status === 504 ||
    text.includes("abort") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("etimedout")
  ) {
    kind = "timeout";
  }
  // 认证失败 / 密钥无效
  else if (
    status === 401 ||
    status === 403 ||
    text.includes("invalid api key") ||
    text.includes("incorrect api key") ||
    text.includes("authentication") ||
    text.includes("unauthorized") ||
    text.includes("invalid_api_key") ||
    text.includes("api key not valid")
  ) {
    kind = "auth_invalid";
  }
  // 额度耗尽
  else if (
    status === 402 ||
    text.includes("insufficient") ||
    text.includes("balance") ||
    text.includes("quota") ||
    text.includes("额度") ||
    text.includes("arrear")
  ) {
    kind = "quota_exhausted";
  }
  // 限流
  else if (status === 429 || text.includes("rate limit") || text.includes("rate_limit") || text.includes("too many requests")) {
    kind = "rate_limited";
  }
  // 模型不存在
  else if (
    status === 404 ||
    text.includes("model not found") ||
    text.includes("model_not_found") ||
    text.includes("does not exist") ||
    text.includes("no such model")
  ) {
    kind = "model_not_found";
  }
  // 网络不可达
  else if (
    text.includes("econnrefused") ||
    text.includes("enotfound") ||
    text.includes("eai_again") ||
    text.includes("getaddrinfo") ||
    text.includes("econnreset") ||
    text.includes("econnaborted") ||
    text.includes("ehostunreach") ||
    text.includes("enetunreach") ||
    text.includes("fetch failed") ||
    text.includes("connection error") ||
    text.includes("connect econnrefused")
  ) {
    kind = "network_unreachable";
  }

  return { kind, userMessage: LLM_USER_MESSAGES[kind] };
}

/** 包装为 LlmApiError（已是 LlmApiError 则原样返回），保留原始错误引用 */
export function toLlmApiError(err: unknown): LlmApiError {
  if (err instanceof LlmApiError) return err;
  const { kind, userMessage } = classifyLlmError(err);
  return new LlmApiError(kind, userMessage, err);
}

// ─── SSE payload 构造 ───

export interface LlmErrorSSEPayload {
  error: string;
  kind: LlmErrorKind;
}

/**
 * 将任意错误转为 SSE error payload。
 * 仅当错误可归因为 LLM 故障（LlmApiError 或分类命中明确类别）时返回结构化 payload；
 * 其余（非 LLM 错误）返回 null，由调用方走原有 String(message) 兜底。
 */
export function llmErrorSSEPayload(err: unknown): LlmErrorSSEPayload | null {
  if (err instanceof LlmApiError) {
    return { error: err.message, kind: err.kind };
  }
  const { kind } = classifyLlmError(err);
  if (kind === "unknown") return null;
  const { userMessage } = classifyLlmError(err);
  return { error: `${MODEL_UNAVAILABLE_PREFIX}：${userMessage}`, kind };
}
