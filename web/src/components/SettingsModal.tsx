import { useState, useEffect, useCallback } from "react";
import { getSettings, updateSettings, validateKGEndpoint } from "../api";
import type { SettingsResponse } from "../api";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  // ─── 只读展示（来自 config.json）───
  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [maxTokens, setMaxTokens] = useState<number | null>(null);
  const [kgUrl, setKgUrl] = useState("");
  const [transport, setTransport] = useState<"streamable-http" | "sse">("streamable-http");

  // ─── 凭据编辑（写入 settings.json）───
  const [apiKey, setApiKey] = useState("");
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  const [kgApiKey, setKgApiKey] = useState("");
  const [kgApiKeyConfigured, setKgApiKeyConfigured] = useState(false);
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
        // 基础设施（只读，来自 config.json）
        if (s.llm.provider) setProvider(s.llm.provider);
        if (s.llm.base_url) setBaseUrl(s.llm.base_url);
        if (s.llm.model) setModel(s.llm.model);
        setMaxTokens(s.llm.max_tokens);
        if (s.mcp.knowledge_graph_url) setKgUrl(s.mcp.knowledge_graph_url);
        if (s.mcp.transport) setTransport(s.mcp.transport);
        // 凭据状态（来自 settings.json）
        setApiKeyConfigured(s.llm.api_key_configured);
        setKgApiKeyConfigured(s.mcp.api_key_configured);
        setAdminTokenConfigured(s.web.admin_token_configured);
      })
      .catch(() => {});
  }, [open]);

  // ─── 保存凭据 ───
  const handleSave = useCallback(async () => {
    setSaving(true);
    setMessage(null);
    try {
      await updateSettings({
        llm: {
          ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}),
        },
        mcp: {
          ...(kgApiKey.trim() ? { api_key: kgApiKey.trim() } : {}),
        },
        web: {
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
      setMessage({ type: "success", text: "凭据已保存" });
    } catch (err) {
      setMessage({ type: "error", text: `保存失败：${(err as Error).message}` });
    } finally {
      setSaving(false);
    }
  }, [apiKey, kgApiKey, adminToken]);

  // ─── 测试连通性（直接从 config.json 读取 KG URL，如需 api_key 则先保存）───
  const handleValidate = useCallback(async () => {
    setValidating(true);
    setValidateResult(null);
    try {
      // 如果有新的 KG API key，先保存（validate 端点从 config 读取，其中 api_key 来自 settings.json）
      if (kgApiKey.trim()) {
        await updateSettings({
          mcp: { api_key: kgApiKey.trim() },
        });
        setKgApiKeyConfigured(true);
        setKgApiKey("");
      }
      const result = await validateKGEndpoint();
      setValidateResult(result);
    } catch (err) {
      setValidateResult({ ok: false, error: String((err as Error).message) });
    } finally {
      setValidating(false);
    }
  }, [kgApiKey]);

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

          {/* Provider — 只读 */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              Provider
              <span className="ml-1 text-xs text-gray-400">（config.json）</span>
            </label>
            <input
              type="text"
              value={provider}
              readOnly
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
            />
          </div>

          {/* Base URL — 只读 */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              Base URL
              <span className="ml-1 text-xs text-gray-400">（config.json）</span>
            </label>
            <input
              type="text"
              value={baseUrl}
              readOnly
              className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
            />
          </div>

          {/* Model + Max Tokens — 只读 */}
          <div className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <label className="block text-sm font-medium text-gray-600">
                Model
                <span className="ml-1 text-xs text-gray-400">（config.json）</span>
              </label>
              <input
                type="text"
                value={model}
                readOnly
                className="w-full px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
              />
            </div>
            {maxTokens !== null && (
              <div className="w-24 space-y-1.5">
                <label className="block text-sm font-medium text-gray-600">
                  Tokens
                </label>
                <input
                  type="text"
                  value={maxTokens.toLocaleString()}
                  readOnly
                  className="w-full px-2 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed text-center"
                />
              </div>
            )}
          </div>

          {/* API Key — 可编辑 */}
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

          {/* Transport — 只读 */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              MCP 协议
              <span className="ml-1 text-xs text-gray-400">（config.json）</span>
            </label>
            <div className="flex gap-2">
              <span className={`flex-1 flex items-center justify-center px-3 py-2 border rounded-lg text-sm ${transport === "streamable-http" ? "border-blue-200 bg-blue-50/50 text-blue-600" : "border-gray-200 bg-gray-50 text-gray-400"}`}>
                Streamable HTTP
              </span>
              <span className={`flex-1 flex items-center justify-center px-3 py-2 border rounded-lg text-sm ${transport === "sse" ? "border-blue-200 bg-blue-50/50 text-blue-600" : "border-gray-200 bg-gray-50 text-gray-400"}`}>
                SSE
              </span>
            </div>
          </div>

          {/* Endpoint URL — 只读 */}
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-gray-600">
              Endpoint URL
              <span className="ml-1 text-xs text-gray-400">（config.json）</span>
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={kgUrl}
                readOnly
                className="flex-1 px-3 py-2 border border-gray-200 rounded-lg text-sm bg-gray-50 text-gray-500 cursor-not-allowed"
              />
              <button
                type="button"
                onClick={handleValidate}
                disabled={validating || !kgUrl}
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

          {/* KG API Key — 可编辑 */}
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

          {/* Admin Token — 可编辑 */}
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
            <p className="text-xs text-gray-400">首次启动自动生成；公网部署建议设置</p>
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
            Provider / Model / KG Endpoint 等基础设施配置在 <code className="text-gray-700 bg-gray-100 px-1 rounded">config.json</code>，
            API Key 和 Admin Token 存储于 <code className="text-gray-700 bg-gray-100 px-1 rounded">data/settings.json</code>。
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
            {saving ? "保存中..." : "保存凭据"}
          </button>
        </div>
      </div>
    </div>
  );
}
