import { useState } from "react";
import type { SessionSummary } from "../types";
import { updateSession } from "../api";

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  sidebarOpen?: boolean;
}

export function SessionList({ sessions, activeId, onSelect, onCreate, onDelete, onRename, sidebarOpen = true }: Props) {
  return (
    <aside className={`fixed md:relative z-40 inset-y-0 left-0 w-64 border-r border-gray-200 bg-white flex flex-col shrink-0 transition-transform duration-300 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
      <div className="p-3 border-b border-gray-200 flex items-center justify-between">
        <span className="font-medium text-sm text-gray-700">会话</span>
        <button
          onClick={onCreate}
          className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
        >
          + 新会话
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sessions.length === 0 ? (
          <div className="p-4 text-sm text-gray-400 text-center">暂无会话</div>
        ) : (
          sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              isActive={s.id === activeId}
              onSelect={onSelect}
              onDelete={onDelete}
              onRename={onRename}
            />
          ))
        )}
      </div>
    </aside>
  );
}

function SessionItem({
  session,
  isActive,
  onSelect,
  onDelete,
  onRename,
}: {
  session: SessionSummary;
  isActive: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(session.title);

  const hasRunning = session.explorations.some((e) => e.status === "running");

  const handleRename = async () => {
    if (title.trim() && title !== session.title) {
      await updateSession(session.id, { title: title.trim() });
      onRename(session.id, title.trim());
    }
    setEditing(false);
  };

  return (
    <div
      className={`px-3 py-2.5 cursor-pointer border-b border-gray-100 group ${
        isActive ? "bg-blue-50 border-l-2 border-l-blue-600" : "hover:bg-gray-50"
      }`}
      onClick={() => { if (!editing) onSelect(session.id); }}
    >
      <div className="flex items-start justify-between gap-1">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleRename(); if (e.key === "Escape") setEditing(false); }}
              onBlur={handleRename}
              onClick={(e) => e.stopPropagation()}
              className="w-full text-sm border border-blue-300 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
              autoFocus
            />
          ) : (
            <p
              className="text-sm text-gray-800 truncate"
              onDoubleClick={(e) => { e.stopPropagation(); setTitle(session.title); setEditing(true); }}
            >
              {hasRunning && <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5 animate-pulse" />}
              {session.title}
            </p>
          )}
          <p className="text-xs text-gray-400 mt-0.5">
            {formatTime(session.updated_at)}
          </p>
        </div>
        <div className="flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); setTitle(session.title); setEditing(true); }}
            className="text-gray-400 hover:text-blue-500 p-1 rounded hover:bg-gray-100"
            title="重命名"
            aria-label="重命名"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); if (confirm("确定删除？")) onDelete(session.id); }}
            className="text-gray-400 hover:text-red-500 p-1 rounded hover:bg-gray-100"
            title="删除"
            aria-label="删除"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
  return d.toLocaleDateString("zh-CN");
}
