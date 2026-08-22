import { defineConfig } from "tsup";

// core(src/agent + src/llm)构建时打进 dist;SDK 与 pino 保持 external。
// ⚠️ @deepseek-ai/* 与 schemastery 必须打包进 dist、且不得出现在 dependencies:
// dsh profile 内若存在第二份这些模块实例,会把 tools 服务/symbol 解析分裂到
// 不同实例上,宿主 agent loop 的 ctx.tools[Symbol].prepare 随之崩溃
// (npm 安装时 pnpm 会把 dependencies 落进 profile 根,link 安装则不会——
// 这就是 headless link 验证通过而 npm 安装崩溃的原因)。
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node22",
  platform: "node",
  external: [
    "@modelcontextprotocol/sdk",
    "@anthropic-ai/sdk",
    "openai",
    "pino",
  ],
});
