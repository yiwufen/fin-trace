// 客户端 bundle 单测：模拟 window.__ModuleLoader__ 注册 → materialize → apply 注册 + 组件渲染
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const factories = new Map();
global.window = { __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) } };
(0, eval)(readFileSync(new URL("./dist/client.js", import.meta.url), "utf8"));

const req = createRequire(new URL("./package.json", import.meta.url));
const stubRequire = (spec) => {
  if (spec === "react" || spec === "react/jsx-runtime") return req(spec);
  throw new Error(`unexpected require: ${spec}`);
};
const factory = factories.get("@lihangcz/dsh-fin-trace");
if (!factory) throw new Error("factory 未注册");
const mod = factory(stubRequire);

const { renderToString } = await import("react-dom/server");
const R = await import("react");

let failed = 0;
const t = (name, cond, extra = "") => {
  if (cond) console.log(`PASS ${name}`);
  else { console.log(`FAIL ${name} ${extra}`); failed = 1; }
};

t("exports.inject", JSON.stringify(mod.inject) === JSON.stringify(["slots"]), JSON.stringify(mod.inject));
t("exports.apply", typeof mod.apply === "function");

const regs = [];
mod.apply({
  slots: {
    inject: (name, cb) => cb(),
    register: (opts, C) => { regs.push({ ...opts, C }); return () => {}; },
  },
});
t("toolview 注册 3 条", regs.length === 3, String(regs.length));
t("keys 正确", ["fintrace_explore_start", "fintrace_explore_status", "fintrace_explore_cancel"].every((k) => regs.some((r) => r.key === k)));
t("slot 名正确", regs.every((r) => r.name === "tool.call.toolview"));

const StartCard = regs.find((r) => r.key === "fintrace_explore_start").C;
const StatusCard = regs.find((r) => r.key === "fintrace_explore_status").C;
const CancelCard = regs.find((r) => r.key === "fintrace_explore_cancel").C;

const settled = (meta, isError = false) => ({
  kind: "tool-result", callId: "c1", isError, meta,
  content: [{ type: "text", text: "dummy" }], call: null,
});
const render = (C, props) => renderToString(R.createElement(C, props));

let html = render(StartCard, { block: settled({ task_id: "bcb211bc-27a9-4dbf-a30d-d0f36a74baca", job_id: "fintrace-1" }) });
t("StartCard 回放含 task_id", html.includes("bcb211bc"), html.slice(0, 200));
html = render(StartCard, { block: { callId: "c1", name: "fintrace_explore_start", argsRaw: JSON.stringify({ goal: "宁德时代的供应链上游关系", seed_entities: ["宁德时代"] }) } });
t("StartCard 运行中含 goal", html.includes("宁德时代的供应链上游关系"), html.slice(0, 200));

html = render(StatusCard, { block: settled({ status: "running", progress: { step: 7, decision: "expand 动力电池", findings: 3, entities: 12, events: 40 } }) });
t("StatusCard running", html.includes("探索进行中") && html.includes("expand"), html.slice(0, 300));
html = render(StatusCard, { block: settled({ status: "completed", counts: { findings: 2, entities: 15, threads: 1, tokens: 51000 }, completion_reason: "sufficient", top_findings: [{ category: "chain", statement: "宁德时代通过参股上游锂矿锁定原料供应", confidence: "high" }] }) });
t("StatusCard completed", html.includes("探索完成") && html.includes("51.0k") && html.includes("锂矿"));
html = render(StatusCard, { block: settled({ status: "failed", error: "MCP 连接失败" }) });
t("StatusCard failed", html.includes("探索失败") && html.includes("MCP"));
html = render(StatusCard, { block: settled({ status: "canceled" }) });
t("StatusCard canceled", html.includes("已取消"));
html = render(StatusCard, { block: settled(undefined) });
t("StatusCard 无 meta 兜底", html.includes("探索进度"));
html = render(StatusCard, { block: settled(undefined, true) });
t("StatusCard 错误结果", html.includes("查询失败"));

html = render(CancelCard, { block: settled({ status: "canceled", message: "已发送取消信号" }) });
t("CancelCard canceled", html.includes("已发送取消信号"));
html = render(CancelCard, { block: { callId: "c1", name: "fintrace_explore_cancel", argsRaw: "{}" } });
t("CancelCard running", html.includes("取消探索任务"));

process.exit(failed);
