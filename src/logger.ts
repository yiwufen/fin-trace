import pino from "pino";

const root = pino({
  level: process.env.LOG_LEVEL ?? "info",
  ...(process.env.NODE_ENV !== "production"
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

export function createLogger(component: string, ctx?: Record<string, unknown>) {
  return root.child({ component, ...ctx });
}

export { root as logger };
