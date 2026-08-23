import pino from "pino";
import { createRequire } from "node:module";

// 出口设计：root logger 始终写 proxy stream，运行期可在「默认 stdout」与「外部 sink」之间改道。
// 服务器独立进程走默认出口（开发环境内联 pino-pretty，输出与原 worker transport 等价）；
// 嵌入式宿主（dsh 插件等）调用 setLoggerSink 把日志行转发进宿主日志服务，不碰宿主进程 stdout。
// 不再用 pino transport——transport 与自定义 stream 互斥，且无法运行期改道。

const require = createRequire(import.meta.url);

/** 一条已序列化日志行解析出的记录；level 为 pino 数值级别（20 debug / 30 info / 40 warn / 50 error） */
export interface LogRecord {
  level: number;
  msg?: string;
  [key: string]: unknown;
}

/** 改道目的地：收到原始 JSON 行与解析后的记录 */
export type LoggerSink = (line: string, record: LogRecord) => void;

let activeSink: LoggerSink | undefined;

// 默认出口：pino-pretty 可解析且非生产环境时内联 pretty 流（惰性加载），否则直接写 stdout JSON 行。
// pino-pretty 是服务器根目录依赖；嵌入式宿主多半没有，探测失败即走纯 JSON。
let defaultWrite: (line: string) => void = (line) => process.stdout.write(line);
if (process.env.NODE_ENV !== "production") {
  try {
    require.resolve("pino-pretty");
    const pretty = require("pino-pretty") as (opts: { colorize: boolean }) => NodeJS.WritableStream;
    const prettyStream = pretty({ colorize: true });
    defaultWrite = (line) => prettyStream.write(line);
  } catch {
    // pino-pretty 不可用（嵌入式宿主）→ 纯 JSON
  }
}

const swappableStream = {
  write(chunk: string | Buffer) {
    const line = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (!activeSink) {
      defaultWrite(line);
      return;
    }
    let record: LogRecord;
    try {
      record = JSON.parse(line) as LogRecord;
    } catch {
      record = { level: 30, msg: line.trimEnd() };
    }
    activeSink(line, record);
  },
};

const root = pino({ level: process.env.LOG_LEVEL ?? "info" }, swappableStream);

/** 嵌入式宿主改道：此后所有日志行转发给 sink，不再写 stdout。级别调整直接设 root.level */
export function setLoggerSink(sink: LoggerSink): void {
  activeSink = sink;
}

/** 还原默认 stdout 出口（宿主插件卸载 / HMR 重载时调用） */
export function resetLoggerSink(): void {
  activeSink = undefined;
}

export function createLogger(component: string, ctx?: Record<string, unknown>) {
  return root.child({ component, ...ctx });
}

export { root as logger };
