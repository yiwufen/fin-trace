import { defineConfig } from "tsup";

// core(src/agent + src/llm)构建时打进 dist;SDK 与 dsh/cordis 运行时保持 external
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
  external: [
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-session",
    "@modelcontextprotocol/sdk",
    "@anthropic-ai/sdk",
    "openai",
    "pino",
    "schemastery",
  ],
});
