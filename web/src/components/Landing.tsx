import { useState, useEffect } from "react";
import type { Session } from "../types";
import { getAccountConfig, getPublicDemo, type AccountConfig } from "../api";
import { MessageBubble } from "./MessageBubble";

/**
 * 公开落地页（未登录访客的首屏）。
 * 目的：先传递价值，再引导注册/登录——替代过去"一进 / 就撞登录表单"的体验。
 *
 * 区块：顶部导航 + Hero + 能力卡片 + 真实案例 Demo + dsh 插件 + 底部 CTA。
 * - 已登录用户访问 / 时，App.tsx 的 RootRedirect 会先 replace 到 /app，不会看到本页。
 * - Demo 区块依赖管理员配置 demo_session_id；未配置时降级为静态示例卡片。
 * - dsh 插件区块为静态内容（安装命令 + 工具三件套），无接口依赖。
 */
export function Landing() {
  const [config, setConfig] = useState<AccountConfig | null>(null);
  const [demo, setDemo] = useState<Session | null>(null);
  const [demoLoading, setDemoLoading] = useState(true);
  const [demoExpanded, setDemoExpanded] = useState(false);

  // 加载账号配置（决定 CTA 文案）+ 公开 demo（只读，不计次）
  useEffect(() => {
    getAccountConfig()
      .then(setConfig)
      .catch(() => setConfig({ registration_enabled: true, invite_code_required: false }));
    getPublicDemo()
      .then(setDemo)
      .catch(() => setDemo(null))
      .finally(() => setDemoLoading(false));
  }, []);

  const canRegister = config?.registration_enabled ?? true;
  // 主 CTA：开放注册 → "免费注册" 跳 /register；否则 → "登录" 跳 /login
  const primaryHref = canRegister ? "/register" : "/login";
  const primaryLabel = canRegister ? "免费注册" : "登录";

  return (
    <div className="min-h-dvh bg-gray-50">
      {/* ─── 顶部导航 ─── */}
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-gray-200">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BrandLogo className="w-7 h-7" />
            <span className="font-semibold text-gray-800">Graph Explorer</span>
          </div>
          <a
            href="/login"
            className="text-sm text-gray-600 hover:text-gray-900 px-3 py-1.5 rounded-lg hover:bg-gray-100"
          >
            登录
          </a>
        </div>
      </header>

      {/* ─── Hero ─── */}
      <section className="max-w-3xl mx-auto px-4 pt-16 pb-12 text-center">
        <div className="flex justify-center mb-5">
          <BrandLogo className="w-16 h-16" />
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold text-gray-900 tracking-tight">
          在金融知识图谱上做多跳关系推理
        </h1>
        <p className="mt-4 text-base sm:text-lg text-gray-600 leading-relaxed">
          用一句自然语言提问，Agent 自动探索实体关系、提炼风险信号，
          <br className="hidden sm:block" />
          每一步推理都有证据可追溯，最终给出带可信度评级的结论。
        </p>
        <div className="mt-8 flex items-center justify-center">
          <a
            href={primaryHref}
            className="px-6 py-3 text-sm sm:text-base bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-medium shadow-sm"
          >
            {primaryLabel}
          </a>
        </div>
        <p className="mt-3 text-xs text-gray-400">一次探索通常 3–10 分钟，结果可分享、可追溯</p>
      </section>

      {/* ─── 能力卡片 ─── */}
      <section className="max-w-5xl mx-auto px-4 pb-12">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {CAPABILITIES.map((cap) => (
            <div
              key={cap.title}
              className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm"
            >
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center text-blue-600 mb-3">
                {cap.icon}
              </div>
              <h3 className="text-sm font-semibold text-gray-800 mb-1.5">{cap.title}</h3>
              <p className="text-xs text-gray-500 leading-relaxed">{cap.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ─── 真实案例 Demo ─── */}
      <section className="max-w-3xl mx-auto px-4 pb-12">
        <DemoSection
          demo={demo}
          loading={demoLoading}
          expanded={demoExpanded}
          onToggle={() => setDemoExpanded((v) => !v)}
        />
      </section>

      {/* ─── dsh 插件（终端形态）─── */}
      <section className="max-w-3xl mx-auto px-4 pb-12">
        <PluginSection />
      </section>

      {/* ─── 底部 CTA ─── */}
      <section className="max-w-3xl mx-auto px-4 py-12 text-center">
        <h2 className="text-xl font-semibold text-gray-800 mb-2">准备好开始探索了吗？</h2>
        <p className="text-sm text-gray-500 mb-6">注册后即可在知识图谱上提出你自己的问题</p>
        <a
          href={primaryHref}
          className="inline-block px-6 py-3 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 font-medium shadow-sm"
        >
          {primaryLabel}
        </a>
      </section>

      <footer className="border-t border-gray-200 py-6 text-center">
        <p className="text-xs text-gray-400">Graph Explorer · 金融知识图谱关系推理</p>
      </footer>
    </div>
  );
}

// ─── Demo 区块：有真实会话就展示，否则降级为静态示例 ───

function DemoSection({
  demo,
  loading,
  expanded,
  onToggle,
}: {
  demo: Session | null;
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (loading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 text-center text-sm text-gray-400">
        正在加载案例…
      </div>
    );
  }

  // 管理员未配置 demo_session_id → 降级为静态示例问题
  if (!demo) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-800 mb-1">可以这样提问</h2>
        <p className="text-xs text-gray-500 mb-4">这些都是 Agent 擅长的多跳关系问题</p>
        <ul className="space-y-2">
          {SAMPLE_QUESTIONS.map((q) => (
            <li
              key={q}
              className="text-sm text-gray-700 bg-gray-50 rounded-lg px-3 py-2 border border-gray-100"
            >
              “{q}”
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const messages = demo.messages ?? [];
  const findingsCount = demo.explorations.reduce(
    (sum, e) => sum + (e.output?.findings.length ?? 0),
    0
  );
  const goal = demo.explorations[0]?.goal ?? demo.title;

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      {/* 案例头部 */}
      <div className="p-5 border-b border-gray-100">
        <div className="flex items-center gap-2 text-xs text-blue-600 mb-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
          <span>真实案例</span>
        </div>
        <h2 className="text-base font-semibold text-gray-800 line-clamp-2">{demo.title || goal}</h2>
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-400">
          <span>问题：{goal}</span>
          {findingsCount > 0 && <span>· 发现 {findingsCount} 条线索</span>}
          <span>· {messages.length} 条对话</span>
        </div>
      </div>

      {/* 展开/折叠控制 */}
      <div className="px-5 py-3">
        <button
          onClick={onToggle}
          className="text-sm text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1"
        >
          {expanded ? "收起推理过程" : "展开推理过程"}
          <svg
            className={`w-4 h-4 transition-transform ${expanded ? "rotate-180" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {/* 推理对话流（只读，复用 MessageBubble） */}
      {expanded && (
        <div className="px-5 pb-5 max-h-[60vh] overflow-y-auto border-t border-gray-100">
          {messages.length > 0 ? (
            <div className="pt-4 space-y-4">
              {messages.map((msg, i) => (
                <MessageBubble key={i} message={msg} />
              ))}
            </div>
          ) : (
            <div className="py-6 text-center text-sm text-gray-400">
              该案例暂无可展示的对话内容
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── dsh 插件区块：终端 Agent 形态的安装引导（静态内容）───

const DSH_INSTALL_CMD = "dsh plugin --profile web add @lihangcz/dsh-fin-trace";

const DSH_TOOLS = [
  { name: "fintrace_explore_start", desc: "提交探索任务，立即返回 task_id，后台运行不阻塞会话" },
  { name: "fintrace_explore_status", desc: "查询进度 / 读取终态结果（findings · event_threads）" },
  { name: "fintrace_explore_cancel", desc: "取消任务，优雅收尾并保留已产出的发现" },
];

function PluginSection() {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(DSH_INSTALL_CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 剪贴板不可用（非安全上下文等）时静默降级为手动选中复制
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
      <div className="p-5 border-b border-gray-100">
        <div className="flex items-center gap-2 text-xs text-blue-600 mb-1.5">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M8 9l3 3-3 3m5 0h3M4 5h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1z"
            />
          </svg>
          <span>dsh 插件</span>
        </div>
        <h2 className="text-base font-semibold text-gray-800">也可以在终端 Agent 里直接用</h2>
        <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
          推理内核已发布为 npm 插件 <code className="font-mono text-gray-700">@lihangcz/dsh-fin-trace</code>，
          嵌入 DeepSeek Harness（dsh）宿主运行——同一套探索循环，任务后台执行、完成自动唤醒，
          web profile 自带实时探索面板。
        </p>
      </div>

      <div className="p-5 space-y-3">
        {/* 安装命令（终端样式代码块 + 复制） */}
        <div className="flex items-center gap-2 bg-gray-800 rounded-lg pl-3 pr-2 py-2.5">
          <code className="flex-1 min-w-0 text-xs font-mono text-gray-100 overflow-x-auto whitespace-nowrap">
            <span className="select-none text-gray-500">$&nbsp;</span>
            {DSH_INSTALL_CMD}
          </code>
          <button
            onClick={handleCopy}
            className="shrink-0 text-xs text-gray-300 hover:text-white bg-white/10 hover:bg-white/20 rounded-md px-2 py-1 transition-colors"
          >
            {copied ? "已复制" : "复制"}
          </button>
        </div>
        <p className="text-xs text-gray-400">
          安装后重启 dsh 生效；在插件配置里填入知识图谱与 LLM 的 API key 即可开始探索。
        </p>

        {/* 工具三件套 */}
        <ul className="space-y-1.5 pt-1">
          {DSH_TOOLS.map((t) => (
            <li
              key={t.name}
              className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-2 text-xs"
            >
              <code className="font-mono text-blue-600 shrink-0">{t.name}</code>
              <span className="text-gray-500">{t.desc}</span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-4 pt-1 text-xs">
          <a
            href="https://www.npmjs.com/package/@lihangcz/dsh-fin-trace"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            npm 包主页 ↗
          </a>
          <a
            href="https://github.com/yiwufen/fin-trace/tree/main/packages/dsh-fin-trace"
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:text-blue-700 font-medium"
          >
            安装与配置文档 ↗
          </a>
        </div>
      </div>
    </div>
  );
}

// ─── 品牌标志（与 UserAuthPage / ChatView 一致的 rounded-square + bolt）───

function BrandLogo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect width="48" height="48" rx="10" fill="#863bff" />
      <path d="M27 10L14 27h7l-2 11 13-17h-7l2-11z" fill="#fff" />
    </svg>
  );
}

// ─── 静态内容 ───

const CAPABILITIES = [
  {
    title: "多跳关系推理",
    desc: "单跳工具组合出多跳结论——从实体出发，逐步追踪上下游、股权、供应链链条。",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.8}
          d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
        />
      </svg>
    ),
  },
  {
    title: "证据可追溯",
    desc: "每条发现都带有 KU ID 背书的证据链，结论不靠模型凭空生成，可逐条核验。",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.8}
          d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
        />
      </svg>
    ),
  },
  {
    title: "事件脉络 + 可信度",
    desc: "自动将散落的事件编织成因果脉络，并给出高/中/低可信度评级与可靠性备注。",
    icon: (
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.8}
          d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"
        />
      </svg>
    ),
  },
];

const SAMPLE_QUESTIONS = [
  "分析宁德时代的欧洲布局和台积电的关系",
  "芯片管制对英伟达供应链的影响",
  "某某公司的上下游集中度风险",
];
