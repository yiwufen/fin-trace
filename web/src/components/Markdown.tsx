import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  children: string;
}

/**
 * Markdown 渲染组件 —— 把 LLM 返回的 markdown 渲染为带样式的 React 元素。
 *
 * 使用 react-markdown + remark-gfm(GFM:表格/任务列表/删除线/自动链接)。
 * 样式通过 components 映射用 Tailwind utility class 内联,不依赖额外 CSS。
 * 直接渲染为 React 元素(非 dangerouslySetInnerHTML),天然避免 XSS。
 *
 * 流式场景下由调用方(StreamingText)每次传入最新的完整字符串,
 * react-markdown 每帧重新 parse 整段,容错好(未闭合标记按普通文本处理,下一帧修正)。
 */
function MarkdownImpl({ children }: Props) {
  return (
    <div className="markdown-body break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);

// ─── 元素 → 带 Tailwind class 的映射 ───
// 首尾元素的外边距用 first:/last: 归零,避免气泡内出现多余空白。

const COMPONENTS: Components = {
  h1: ({ node: _n, ...p }) => <h1 className="text-base font-bold mt-3 mb-2 first:mt-0" {...p} />,
  h2: ({ node: _n, ...p }) => <h2 className="text-sm font-bold mt-3 mb-1.5 first:mt-0" {...p} />,
  h3: ({ node: _n, ...p }) => <h3 className="text-sm font-semibold mt-2 mb-1 first:mt-0" {...p} />,
  h4: ({ node: _n, ...p }) => <h4 className="text-sm font-semibold mt-2 mb-1 first:mt-0" {...p} />,
  h5: ({ node: _n, ...p }) => <h5 className="text-xs font-semibold mt-2 mb-1 first:mt-0" {...p} />,
  h6: ({ node: _n, ...p }) => <h6 className="text-xs font-semibold mt-2 mb-1 first:mt-0" {...p} />,

  p: ({ node: _n, ...p }) => <p className="my-1.5 first:mt-0 last:mb-0 leading-relaxed" {...p} />,

  ul: ({ node: _n, ...p }) => <ul className="list-disc pl-5 my-1.5 space-y-0.5 first:mt-0 last:mb-0" {...p} />,
  ol: ({ node: _n, ...p }) => <ol className="list-decimal pl-5 my-1.5 space-y-0.5 first:mt-0 last:mb-0" {...p} />,
  li: ({ node: _n, ...p }) => <li className="leading-relaxed marker:text-gray-400" {...p} />,

  a: ({ node: _n, ...p }) => (
    <a target="_blank" rel="noreferrer" className="text-blue-600 underline hover:text-blue-700" {...p} />
  ),

  strong: ({ node: _n, ...p }) => <strong className="font-semibold" {...p} />,
  em: ({ node: _n, ...p }) => <em className="italic" {...p} />,
  del: ({ node: _n, ...p }) => <del className="text-gray-500 line-through" {...p} />,

  blockquote: ({ node: _n, ...p }) => (
    <blockquote className="border-l-2 border-gray-300 pl-3 my-2 text-gray-600 first:mt-0 last:mb-0" {...p} />
  ),

  hr: ({ node: _n, ...p }) => <hr className="my-3 border-gray-200" {...p} />,

  // 行内 code:`code` → 灰底圆角小字
  // 代码块内的 code 由 <pre> 包裹,不加额外样式(避免双重背景)
  code: ({ node: _n, className, children, ...p }) => {
    const isBlock = typeof className === "string" && className.startsWith("language-");
    if (isBlock) {
      return <code className="font-mono text-xs" {...p}>{children}</code>;
    }
    return <code className="bg-gray-200 text-gray-800 px-1 py-0.5 rounded text-xs font-mono" {...p}>{children}</code>;
  },

  pre: ({ node: _n, ...p }) => (
    <pre className="bg-gray-800 text-gray-100 rounded-lg p-3 my-2 overflow-x-auto text-xs font-mono first:mt-0 last:mb-0" {...p} />
  ),

  // 表格:外层包一层可横向滚动的容器
  table: ({ node: _n, ...p }) => (
    <div className="overflow-x-auto my-2 first:mt-0 last:mb-0">
      <table className="min-w-full text-xs border-collapse" {...p} />
    </div>
  ),
  thead: ({ node: _n, ...p }) => <thead className="bg-gray-50" {...p} />,
  th: ({ node: _n, ...p }) => (
    <th className="border border-gray-200 px-2 py-1 text-left font-semibold text-gray-700" {...p} />
  ),
  td: ({ node: _n, ...p }) => <td className="border border-gray-200 px-2 py-1 text-gray-700" {...p} />,

  // GFM 任务列表复选框:去掉原生 appearance,渲染为小方块
  input: ({ node: _n, ...p }) => (
    <input
      className="mr-1.5 align-middle accent-blue-600"
      disabled
      {...p}
    />
  ),
};
