import { useState, useEffect, useCallback } from "react";
import { getSettings, updateSettings, validateKGEndpoint, listSessions } from "../api";
import type { SettingsResponse, SessionSummary } from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ProviderPreset {
  id: string;
  value: "openai" | "anthropic";
  label: string;
  defaultBaseUrl: string;
  defaultModel: string;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "deepseek", value: "openai", label: "DeepSeek / OpenAI 兼容", defaultBaseUrl: "https://api.deepseek.com", defaultModel: "deepseek-v4-pro" },
  { id: "openai", value: "openai", label: "OpenAI", defaultBaseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o" },
  { id: "anthropic", value: "anthropic", label: "Anthropic", defaultBaseUrl: "https://api.anthropic.com", defaultModel: "claude-sonnet-4-6" },
];

export function SettingsModal({ open, onClose }: Props) {
  // ─── 表单状态 ───
  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [kgUrl, setKgUrl] = useState("");
  const [transport, setTransport] = useState<"streamable-http" | "sse">("streamable-http");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [kgApiKey, setKgApiKey] = useState("");
  const [kgApiKeyConfigured, setKgApiKeyConfigured] = useState(false);

  // Web 公开访问
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [demoSessionId, setDemoSessionId] = useState("");
  const [adminTokenConfigured, setAdminTokenConfigured] = useState(false);
  const [adminToken, setAdminToken] = useState("");

  // ─── UI 状态 ───
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validateResult, setValidateResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  // ─── 加载已有配置 ───
  useEffect(() => {
    if (!open) return;
    setMessage(null);
    setValidateResult(null);

    getSettings()
      .then((s: SettingsResponse) => {
        if (s.llm.provider) setProvider(s.llm.provider);
        if (s.llm.base_url) setBaseUrl(s.llm.base_url);
        if (s.llm.model) setModel(s.llm.model);
        setApiKeyConfigured(s.llm.api_key_configured);
        if (s.mcp.knowledge_graph_url) setKgUrl(s.mcp.knowledge_graph_url);
        if (s.mcp.transport) setTransport(s.mcp.transport);
        setKgApiKeyConfigured(s.mcp.api_key_configured);
        setDemoSessionId(s.web.demo_session_id ?? "");
        setAdminTokenConfigured(s.web.admin_token_configured);
      })
      .catch(() => {});
    // 加载会话列表供 demo 选择
    listSessions().then(setSessions).catch(() => setSessions([]));
  }, [open]);

  // ─── 保存 ───
  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      await updateSettings({
        llm: {
          provider: provider as "openai" | "anthropic",
          base_url: baseUrl.trim() || undefined,
          model: model.trim() || undefined,
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        },
        mcp: {
          knowledge_graph_url: kgUrl.trim() || undefined,
          transport,
          ...(kgApiKey.trim() ? { api_key: kgApiKey.trim() } : {}),
        },
        web: {
          demo_session_id: demoSessionId || null,
          ...(adminToken.trim() ? { admin_token: adminToken.trim() } : {}),
        },
      });
      if (apiKey.trim()) {
        setApiKeyConfigured(true);
        setApiKey("");
      }
      if (kgApiKey.trim()) {
        setKgApiKeyConfigured(true);
        setKgApiKey("");
      }
      if (adminToken.trim()) {
        setAdminTokenConfigured(true);
        setAdminToken("");
      }
      setMessage({ type: "success", text: "配置已保存" });
    } catch (err) {
      setMessage({ type: "error", text: `保存失败：${(err as Error).message}` });
    } finally {
      setSaving(false);
    }
  }, [provider, baseUrl, model, apiKey, kgUrl, transport, kgApiKey, demoSessionId, adminToken]);

  // ─── 测试连通性 ───
  const handleValidate = useCallback(async () => {
    if (!kgUrl.trim()) {
      setValidateResult({ ok: false, error: "请先输入 KG Endpoint URL" });
      return;
    }
    setValidating(true);
    setValidateResult(null);
    try {
      // 先保存当前 MCP 配置（含 transport 和 api_key）
      await updateSettings({
        mcp: {
          knowledge_graph_url: kgUrl.trim(),
          transport,
          ...(kgApiKey.trim() ? { api_key: kgApiKey.trim() } : {}),
        },
      });
      const result = await validateKGEndpoint();
      setValidateResult(result);
    } catch (err) {
      setValidateResult({ ok: false, error: String((err as Error).message) });
    } finally {
      setValidating(false);
    }
  }, [kgUrl, transport, kgApiKey]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 my-8 p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">配置</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* ─── LLM 配置 ─── */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">LLM</legend>

          {/* Provider */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">Provider</label>
            <select
              value={provider}
              onChange={(e) => {
                const preset = PROVIDER_PRESETS[e.target.selectedIndex];
                if (preset) {
                  setProvider(preset.value);
                  setBaseUrl(preset.defaultBaseUrl);
                  setModel(preset.defaultModel);
                }
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>

          {/* Base URL */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">Base URL</label>
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.deepseek.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* Model */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">Model</label>
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-v4-pro"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* API Key */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              API Key
              {apiKeyConfigured && <span className="ml-2 text-xs text-green-600">已配置</span>}
            </label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={apiKeyConfigured ? "输入新值以更新" : "sk-..."}
                className="w-full px-3 py-2 pr-16 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
              >
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
        </fieldset>

        {/* ─── MCP 配置 ─── */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Knowledge Graph</legend>

          {/* Transport 协议选择 */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">MCP 协议</label>
            <div className="flex gap-2">
              <label className={`flex-1 flex items-center justify-center px-3 py-2 border rounded-lg text-sm cursor-pointer transition-colors ${transport === "streamable-http" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
                <input
                  type="radio"
                  name="transport"
                  value="streamable-http"
                  checked={transport === "streamable-http"}
                  onChange={() => { setTransport("streamable-http"); setValidateResult(null); }}
                  className="sr-only"
                />
                Streamable HTTP
              </label>
              <label className={`flex-1 flex items-center justify-center px-3 py-2 border rounded-lg text-sm cursor-pointer transition-colors ${transport === "sse" ? "border-blue-500 bg-blue-50 text-blue-700" : "border-gray-300 text-gray-600 hover:bg-gray-50"}`}>
                <input
                  type="radio"
                  name="transport"
                  value="sse"
                  checked={transport === "sse"}
                  onChange={() => { setTransport("sse"); setValidateResult(null); }}
                  className="sr-only"
                />
                SSE
              </label>
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              Endpoint URL
              <span className="ml-1 text-xs text-gray-400">
                {transport === "sse" ? "（SSE endpoint，如 /sse）" : "（HTTP endpoint）"}
              </span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={kgUrl}
                onChange={(e) => { setKgUrl(e.target.value); setValidateResult(null); }}
                placeholder={transport === "sse" ? "https://your-kg-host/sse" : "https://your-kg-host/mcp"}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={handleValidate}
                disabled={validating}
                className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 disabled:opacity-50 whitespace-nowrap"
              >
                {validating ? "测试中..." : "测试连接"}
              </button>
            </div>
            {validateResult && (
              <p className={`text-xs ${validateResult.ok ? "text-green-600" : "text-red-500"}`}>
                {validateResult.ok ? "连接成功" : `连接失败：${validateResult.error}`}
              </p>
            )}
          </div>

          {/* KG API Key */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              API Key
              {kgApiKeyConfigured && <span className="ml-2 text-xs text-green-600">已配置</span>}
            </label>
            <div className="relative">
              <input
                type={showKey ? "text" : "password"}
                value={kgApiKey}
                onChange={(e) => setKgApiKey(e.target.value)}
                placeholder={kgApiKeyConfigured ? "输入新值以更新" : "API Key（可选）"}
                className="w-full px-3 py-2 pr-16 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 hover:text-gray-600"
              >
                {showKey ? "隐藏" : "显示"}
              </button>
            </div>
          </div>
        </fieldset>

        {/* ─── Web 公开访问配置 ─── */}
        <fieldset className="space-y-4">
          <legend className="text-sm font-semibold text-gray-500 uppercase tracking-wide">公开访问</legend>

          {/* 展示会话 Demo */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">展示会话（Demo）</label>
            <select
              value={demoSessionId}
              onChange={(e) => setDemoSessionId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
            >
              <option value="">未选择</option>
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.title} ({new Date(s.updated_at).toLocaleDateString()})
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-400">HR 通过分享链接可只读查看此会话（不计次数）</p>
          </div>

          {/* Admin Token */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              管理令牌（Admin Token）
              {adminTokenConfigured && <span className="ml-2 text-xs text-green-600">已配置</span>}
            </label>
            <input
              type="password"
              value={adminToken}
              onChange={(e) => setAdminToken(e.target.value)}
              placeholder={adminTokenConfigured ? "输入新值以更新" : "留空则不启用门禁"}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-xs text-gray-400">配置后管理端需 X-Admin-Token 头；公网部署建议设置</p>
          </div>
        </fieldset>

        {/* 消息 */}
        {message && (
          <p className={`text-sm ${message.type === "success" ? "text-green-600" : "text-red-500"}`}>
            {message.text}
          </p>
        )}

        {/* 提示 */}
        <div className="bg-gray-50 border border-gray-200 rounded-lg p-3">
          <p className="text-xs text-gray-500 leading-relaxed">
            所有配置存储在本地 <code className="text-gray-700 bg-gray-100 px-1 rounded">data/settings.json</code>，
            不会上传到任何服务器。
          </p>
        </div>

        {/* 操作 */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg"
          >
            关闭
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
