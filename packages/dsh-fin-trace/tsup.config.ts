import { defineConfig } from "tsup";

// 两个入口、两种形态：
//  - host（dist/index.js）：Node ESM。core(src/agent + src/llm) 构建时打进 dist;SDK 与 pino 保持 external。
//    ⚠️ @deepseek-ai/* 与 schemastery 必须打包进 dist、且不得出现在 dependencies:
//    dsh profile 内若存在第二份这些模块实例,会把 tools 服务/symbol 解析分裂到
//    不同实例上,宿主 agent loop 的 ctx.tools[Symbol].prepare 随之崩溃
//    (npm 安装时 pnpm 会把 dependencies 落进 profile 根,link 安装则不会——
//    这就是 headless link 验证通过而 npm 安装崩溃的原因)。
//  - client（dist/client.js）：浏览器 classic script,window.__ModuleLoader__.load 工厂包装
//    （复刻 @deepseek-ai/dsh-client-ui-* 的产物形态）。react/react/jsx-runtime 属平台基线
//    (dsh-client-web PLATFORM_MODULES),external 由运行时 require 解析。
export default [
  defineConfig({
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
  }),
  defineConfig({
    entry: { client: "src/client/index.tsx" },
    format: ["cjs"],
    dts: false,
    sourcemap: true,
    target: "es2022",
    platform: "browser",
    external: ["react", "react/jsx-runtime"],
    // type:module 包下 tsup 默认给 cjs 命名 .cjs；loader 只认 exports["./client"] 指到的文件名
    outExtension: () => ({ js: ".js" }),
    banner: {
      js: 'window.__ModuleLoader__.load({\n\tid: "@lihangcz/dsh-fin-trace",\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;',
    },
    footer: {
      js: "\t\treturn module.exports;\n\t}\n});",
    },
  }),
];
