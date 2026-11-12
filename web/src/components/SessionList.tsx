import { useState } from "react";
import type { SessionSummary } from "../types";
import { updateSession, archiveSession, restoreSession, listArchivedSessions, type ArchivedSessionSummary } from "../api";

interface Props {
  sessions: SessionSummary[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  /** 归档会话（替代破坏性操作） */
  onArchive: (id: string) => void;
  /** 归档列表中恢复会话后刷新会话列表 */
  onRestored: (id: string) => void;
  onRename: (id: string, title: string) => void;
  sidebarOpen?: boolean;
}

export function SessionList({ sessions, activeId, onSelect, onCreate, onArchive, onRestored, onRename, sidebarOpen = true }: Props) {
  const [showArchived, setShowArchived] = useState(false);

  return (
    <aside className={`fixed md:relative z-40 inset-y-0 left-0 w-64 border-r border-gray-200 bg-white flex flex-col shrink-0 transition-transform duration-300 ease-in-out ${sidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
      <div className="p-3 border-b border-gray-200 flex items-center justify-between">
        <span className="font-medium text-sm text-gray-700">会话</span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setShowArchived(true)}
            className="text-xs px-2 py-1 rounded text-gray-500 hover:text-blue-600 hover:bg-blue-50 transition-colors"
            title="归档列表"
            aria-label="查看归档"
          >
            归档
          </button>
          <button
            onClick={onCreate}
            className="text-xs px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            + 新会话
          </button>
        </div>
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
              onArchive={onArchive}
              onRename={onRename}
            />
          ))
        )}
      </div>
      {showArchived && (
        <ArchivedPanel
          onClose={() => setShowArchived(false)}
          onRestore={async (id) => {
            await restoreSession(id);
            onRestored(id);
          }}
        />
      )}
    </aside>
  );
}

// ─── 归档列表面板 ───

function ArchivedPanel({
  onClose,
  onRestore,
}: {
  onClose: () => void;
  onRestore: (id: string) => Promise<void>;
}) {
  const [archived, setArchived] = useState<ArchivedSessionSummary[] | null>(null);
  const [visibleCount, setVisibleCount] = useState(5);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  if (archived === null) {
    listArchivedSessions().then(setArchived).catch(() => setArchived([]));
  }

  const handleRestore = async (id: string) => {
    setRestoringId(id);
    try {
      // 恢复后该会话移出归档列表（回到会话列表，由 onRestored 刷新主列表）
      setArchived((prev) => (prev ?? []).filter((s) => s.id !== id));
      await onRestore(id);
    } finally {
      setRestoringId(null);
    }
  };

  return (
    <div className="absolute inset-0 z-50 bg-white flex flex-col">
      <div className="p-3 border-b border-gray-200 flex items-center justify-between">
        <span className="font-medium text-sm text-gray-700">归档列表</span>
        <button
          onClick={onClose}
          className="text-xs px-2 py-1 rounded text-gray-500 hover:bg-gray-100 transition-colors"
          aria-label="关闭归档列表"
        >
          关闭
        </button>
      </div>
      <div className="flex-1 overflow-y-auto">
        {archived === null ? (
          <div className="p-4 text-sm text-gray-400 text-center">加载中...</div>
        ) : archived.length === 0 ? (
          <div className="p-4 text-sm text-gray-400 text-center">暂无归档会话</div>
        ) : (
          <>
            {archived.slice(0, visibleCount).map((s) => (
              <div key={s.id} className="px-3 py-2.5 border-b border-gray-100 group">
                <div className="flex items-start justify-between gap-1">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-800 truncate">{s.title}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {formatTime(s.archived_at ?? s.updated_at)}
                    </p>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); void handleRestore(s.id); }}
                    disabled={restoringId === s.id}
                    className="text-gray-400 hover:text-blue-500 p-1 rounded hover:bg-gray-100 disabled:opacity-50"
                    title="恢复"
                    aria-label="恢复"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a4 4 0 110 8H9m-6-8l4-4m-4 4l4 4" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
            {visibleCount < archived.length && (
              <div className="p-3 text-center">
                <button
                  onClick={() => setVisibleCount((c) => c + 5)}
                  className="text-xs px-3 py-1.5 rounded border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  显示更多（{archived.length - visibleCount}）
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SessionItem({
  session,
  isActive,
  onSelect,
  onArchive,
  onRename,
}: {
  session: SessionSummary;
  isActive: boolean;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
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
            onClick={(e) => { e.stopPropagation(); if (confirm("确定归档该会话？归档后可在归档列表中恢复。")) onArchive(session.id); }}
            className="text-gray-400 hover:text-amber-500 p-1 rounded hover:bg-gray-100"
            title="归档"
            aria-label="归档"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
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
