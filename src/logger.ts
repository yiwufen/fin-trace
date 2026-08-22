import pino from "pino";
import { createRequire } from "node:module";

// pino-pretty 是服务器根目录依赖；嵌入式宿主（dsh 插件等）未必安装。
// transport 目标在 worker 线程中解析，缺失会让 pino() 直接抛错、拖垮宿主启动，
// 因此先探测可解析性，不可用则退回纯 JSON 输出。
const require = createRequire(import.meta.url);

let prettyTransport: { target: string; options: { colorize: boolean } } | undefined;
if (process.env.NODE_ENV !== "production") {
  try {
    require.resolve("pino-pretty");
    prettyTransport = { target: "pino-pretty", options: { colorize: true } };
  } catch {
    // pino-pretty 不可用（嵌入式宿主）→ 纯 JSON
  }
}

const root = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(prettyTransport ? { transport: prettyTransport } : {}),
});

export function createLogger(component: string, ctx?: Record<string, unknown>) {
  return root.child({ component, ...ctx });
}

export { root as logger };
