import { useMemo } from "react";

interface Props {
  text: string;
  streaming?: boolean;
}

export function StreamingText({ text, streaming }: Props) {
  const html = useMemo(() => renderMarkdown(text), [text]);

  return (
    <span className="streaming-text">
      <span dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && <span className="inline-block w-2 h-4 bg-blue-600 ml-0.5 animate-pulse align-middle" />}
    </span>
  );
}

// 简单 Markdown 渲染：加粗、斜体、列表、换行
function renderMarkdown(text: string): string {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // 加粗 **text**
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

  // 斜体 *text*
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

  // 行内代码 `text`
  html = html.replace(/`(.+?)`/g, "<code class='bg-gray-200 px-1 rounded text-xs'>$1</code>");

  // 换行
  html = html.replace(/\n/g, "<br/>");

  return html;
}
