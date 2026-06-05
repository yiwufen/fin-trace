import { useState, useRef, useCallback } from "react";

interface Props {
  onSend: (text: string) => void;
  isProcessing?: boolean;
  onStop?: () => void;
}

export function ChatInput({ onSend, isProcessing, onStop }: Props) {
  const [text, setText] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isProcessing) return;
    onSend(trimmed);
    setText("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  }, [text, isProcessing, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (isProcessing) return;
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  return (
    <div className="border-t border-gray-200 bg-white p-4">
      <div className="max-w-3xl mx-auto flex gap-2 items-end">
        <textarea
          ref={textareaRef}
          value={isProcessing ? "" : text}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder={isProcessing ? "思考中..." : "输入消息，如：分析宁德时代供应链风险"}
          disabled={isProcessing}
          rows={1}
          className="flex-1 px-4 py-2.5 border border-gray-300 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:bg-gray-50 disabled:text-gray-400 resize-none"
        />
        {isProcessing ? (
          <button
            onClick={onStop}
            className="px-5 py-2.5 bg-red-600 text-white text-sm rounded-xl hover:bg-red-700 transition-colors font-medium shrink-0"
          >
            停止
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!text.trim()}
            className="px-5 py-2.5 bg-blue-600 text-white text-sm rounded-xl hover:bg-blue-700 disabled:bg-gray-300 transition-colors font-medium shrink-0"
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
