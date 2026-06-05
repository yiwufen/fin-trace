import type { EventThread } from "../types";

interface Props {
  thread: EventThread;
}

const RELATION_COLORS: Record<string, string> = {
  causal: "bg-orange-100 text-orange-700",
  temporal: "bg-blue-100 text-blue-700",
  entity_shared: "bg-purple-100 text-purple-700",
  contradiction: "bg-red-100 text-red-700",
};

const RELATION_LABELS: Record<string, string> = {
  causal: "因果",
  temporal: "时序",
  entity_shared: "共实体",
  contradiction: "矛盾",
};

export function ThreadTimeline({ thread }: Props) {
  return (
    <div className="border border-gray-200 rounded-lg p-3 bg-white">
      {/* Title */}
      <h5 className="text-sm font-medium text-gray-800">{thread.title}</h5>
      <p className="text-xs text-gray-500 mt-1">{thread.summary}</p>

      {/* Confidence */}
      <span className={`text-xs font-mono ${
        thread.confidence === "high" ? "text-green-600" :
        thread.confidence === "medium" ? "text-amber-600" : "text-gray-400"
      }`}>
        {thread.confidence.toUpperCase()}
      </span>

      {/* Time span */}
      {thread.time_span.earliest && (
        <p className="text-xs text-gray-400 mt-1">
          {thread.time_span.earliest.slice(0, 10)} ~ {thread.time_span.latest.slice(0, 10)}
        </p>
      )}

      {/* Timeline events */}
      <div className="mt-3 space-y-2">
        {thread.thread_events.map((event, idx) => (
          <div key={idx} className="flex gap-2">
            <div className="flex flex-col items-center">
              <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 shrink-0" />
              {idx < thread.thread_events.length - 1 && (
                <div className="w-px flex-1 bg-gray-200 my-1" />
              )}
            </div>
            <div className="pb-2 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs text-gray-400 shrink-0">
                  {event.timestamp ? event.timestamp.slice(0, 10) : ""}
                </span>
                <span className="text-xs font-medium text-gray-700">{event.entity}</span>
                <span className="text-xs text-gray-400">{event.event_type}</span>
              </div>
              <p className="text-xs text-gray-600 mt-0.5">{event.description}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Relationships */}
      {thread.relationships.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-100 space-y-1">
          {thread.relationships.map((rel, idx) => (
            <div key={idx} className="flex items-center gap-1 text-xs">
              <span className="text-gray-500">#{rel.from_idx + 1}</span>
              <span className={`px-1 py-0.5 rounded ${RELATION_COLORS[rel.type] ?? "bg-gray-100"}`}>
                {RELATION_LABELS[rel.type] ?? rel.type}
              </span>
              <span className="text-gray-500">#{rel.to_idx + 1}</span>
              <span className="text-gray-400 truncate ml-1">{rel.reasoning}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
