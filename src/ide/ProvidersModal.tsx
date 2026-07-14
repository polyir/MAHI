import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw, Cpu, Puzzle, Settings2, Braces, Sparkles, CheckCircle2, AlertTriangle, Download } from "lucide-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  Provider,
  ProviderRole,
  MediaKind,
  MediaAdapterConfig,
  ModelReasoningConfig,
  OPENAI_MODELS,
  GEMINI_MODELS,
  PROVIDER_PRESETS,
  newCustomAdapter,
  PROVIDER_ROLES,
  LOCAL_PROVIDER_ID,
  modelReasoningConfig,
  isRoleRoutingEnabled,
  setRoleRoutingEnabled,
  isBrowserToolsEnabled,
  setBrowserToolsEnabled,
} from "./providers";
import {
  AdapterImportResult,
  importCurlAdapter,
  mediaCapabilities,
  resolveMediaAdapter,
  validateMediaAdapter,
} from "./mediaAdapters";
import {
  McpServer,
  McpTransport,
  newMcpServer,
  listMcpTools,
  invalidateMcpToolCache,
  mergeStudioMcpServers,
  STUDIO_MCP_DIR_KEY,
} from "./mcp";
import { checkStudioMcpStatus, installStudioMcp, StudioMcpStatus, StudioMcpProgress } from "./studioMcp";
import {
  loadDictationModel,
  loadDictationProviderId,
  loadImproveModel,
  loadImproveProviderId,
  saveDictationModel,
  saveDictationProviderId,
  saveImproveModel,
  saveImproveProviderId,
} from "./localLlm";
import { t, dir as uiDir, useLang, StrKey } from "./i18n";
import { useModalOpen } from "./modalTracker";
import sakanaLogo from "../assets/provider-logos/sakana.svg";
import zaiLogo from "../assets/provider-logos/zai.svg";
import openaiLogo from "../assets/provider-logos/openai.svg";
import geminiLogo from "../assets/provider-logos/gemini.svg";
import minimaxLogo from "../assets/provider-logos/minimax.svg";
import deepseekLogo from "../assets/provider-logos/deepseek.svg";
import qwenLogo from "../assets/provider-logos/qwen.svg";
import openrouterLogo from "../assets/provider-logos/openrouter.svg";
import groqLogo from "../assets/provider-logos/groq.svg";
import nvidiaLogo from "../assets/provider-logos/nvidia.svg";

const PROVIDER_LOGOS: Record<string, string> = {
  sakana: sakanaLogo,
  zai: zaiLogo,
  openai: openaiLogo,
  gemini: geminiLogo,
  minimax: minimaxLogo,
  deepseek: deepseekLogo,
  qwen: qwenLogo,
  openrouter: openrouterLogo,
  groq: groqLogo,
  nvidia: nvidiaLogo,
};

const ROLE_LABEL_KEY: Record<ProviderRole, StrKey> = {
  chat: "roleChat",
  image: "roleImage",
  audio: "roleAudio",
  video: "roleVideo",
};

type AssistantState = {
  kind: MediaKind;
  input: string;
  loading?: boolean;
  result?: AdapterImportResult;
};

export default function ProvidersModal({
  providers,
  onSave,
  onClose,
  mcpServers,
  onSaveMcp,
  onOpenLocalModels,
}: {
  providers: Provider[];
  onSave: (p: Provider[]) => void;
  onClose: () => void;
  mcpServers: McpServer[];
  onSaveMcp: (s: McpServer[]) => void;
  onOpenLocalModels: () => void;
}) {
  useLang();
  useModalOpen(true);
  // The built-in local-LLM provider is virtual/auto-managed — nothing to
  // edit here (no baseURL/apiKey/models to configure), so it never appears
  // in this editable list at all.
  const [local, setLocal] = useState<Provider[]>(() =>
    providers.filter((p) => p.id !== LOCAL_PROVIDER_ID).map((p) => ({ ...p }))
  );
  const [selectedSection, setSelectedSection] = useState("openai");
  const presetIds = new Set(PROVIDER_PRESETS.map((preset) => preset.id));
  const [routingEnabled, setRoutingEnabled] = useState(isRoleRoutingEnabled());
  const [browserToolsEnabled, setBrowserToolsEnabledState] = useState(isBrowserToolsEnabled());
  const [adapterAssistant, setAdapterAssistant] = useState<Record<string, AssistantState>>({});
  // Independent of the main chat provider/model — which provider/model
  // rewrites the draft when the chat header's Wand2 toggle is on. `providers`
  // (unlike `local` above) still includes the virtual Local (Qwen3) entry,
  // which is exactly what should be selectable here.
  const [improveProviderId, setImproveProviderId] = useState(loadImproveProviderId());
  const [improveModel, setImproveModel] = useState(loadImproveModel());
  const improveProvider = providers.find((p) => p.id === improveProviderId) ?? providers[0];
  // The stored model might not belong to the currently-selected provider
  // (e.g. switched away and back, or the provider's own model list changed
  // since it was picked) — fall back to that provider's first model rather
  // than rendering a <select> with no matching <option>.
  const improveModelSafe = improveProvider?.models.includes(improveModel)
    ? improveModel
    : improveProvider?.models[0] ?? "";
  // Independent of the improve-prompt picker above — which provider/model
  // cleans up the Whisper transcript when dictation cleanup is on (see
  // Settings → Local AI Models).
  const [dictationProviderId, setDictationProviderId] = useState(loadDictationProviderId());
  const [dictationModel, setDictationModel] = useState(loadDictationModel());
  const dictationProvider = providers.find((p) => p.id === dictationProviderId) ?? providers[0];
  const dictationModelSafe = dictationProvider?.models.includes(dictationModel)
    ? dictationModel
    : dictationProvider?.models[0] ?? "";

  useEffect(() => {
    if (improveModel !== improveModelSafe) {
      setImproveModel(improveModelSafe);
      saveImproveModel(improveModelSafe);
    }
  }, [improveModel, improveModelSafe]);

  useEffect(() => {
    if (dictationModel !== dictationModelSafe) {
      setDictationModel(dictationModelSafe);
      saveDictationModel(dictationModelSafe);
    }
  }, [dictationModel, dictationModelSafe]);

  function update(i: number, patch: Partial<Provider>) {
    setLocal((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  function updateAdapter(i: number, patch: Partial<NonNullable<Provider["customAdapter"]>>) {
    const current = local[i].customAdapter ?? newCustomAdapter();
    update(i, { customAdapter: { ...current, ...patch } });
  }

  function updateMediaAdapter(i: number, kind: MediaKind, adapter: MediaAdapterConfig) {
    update(i, { mediaAdapters: { ...local[i].mediaAdapters, [kind]: adapter } });
  }

  function assistantFor(provider: Provider): AssistantState {
    return adapterAssistant[provider.id] ?? { kind: "image", input: "" };
  }

  function patchAssistant(providerId: string, patch: Partial<AssistantState>) {
    setAdapterAssistant((current) => ({
      ...current,
      [providerId]: { ...(current[providerId] ?? { kind: "image", input: "" }), ...patch },
    }));
  }

  function decodeDocCode(value: string): string {
    const node = document.createElement("textarea");
    node.innerHTML = value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
    return node.value.replace(/\u00a0/g, " ").trim();
  }

  function curlFromDocument(html: string): string | undefined {
    const blocks = Array.from(html.matchAll(/<(?:code|pre)[^>]*>([\s\S]*?)<\/(?:code|pre)>/gi));
    for (const block of blocks) {
      const decoded = decodeDocCode(block[1]);
      const start = decoded.search(/(?:^|\s)curl\s/i);
      if (start >= 0) return decoded.slice(start).trim();
    }
    return undefined;
  }

  async function runAdapterAssistant(i: number) {
    const provider = local[i];
    const state = assistantFor(provider);
    const input = state.input.trim();
    patchAssistant(provider.id, { loading: true, result: undefined });
    try {
      let curl = input;
      let docsURL: string | undefined;
      if (/^https:\/\//i.test(input)) {
        const requested = new URL(input);
        const allowedHosts = new Set<string>();
        try { allowedHosts.add(new URL(provider.baseURL).hostname); } catch { /* invalid form URL is handled elsewhere */ }
        for (const kind of ["image", "audio", "video"] as MediaKind[]) {
          const known = resolveMediaAdapter(provider, kind)?.docsURL;
          if (known) allowedHosts.add(new URL(known).hostname);
        }
        if (!allowedHosts.has(requested.hostname)) throw new Error("Only this provider's API and official documentation domains are allowed.");
        const response = await tauriFetch(input);
        if (!response.ok) throw new Error(`Official documentation returned HTTP ${response.status}.`);
        const finalHost = new URL(response.url || input).hostname;
        if (!allowedHosts.has(finalHost)) throw new Error("The documentation redirected outside the provider's official domains.");
        curl = curlFromDocument(await response.text()) ?? "";
        docsURL = input;
        if (!curl) throw new Error("No curl example was found on that page. Paste the example directly.");
      } else if (!/^(?:\S*\/)?curl\s/i.test(input)) {
        const known = resolveMediaAdapter(provider, state.kind);
        if (!known) throw new Error("No official built-in adapter exists for this request. Paste a curl example or an official documentation URL.");
        const result: AdapterImportResult = {
          adapter: { ...known }, errors: [],
          warnings: ["Loaded the official built-in preset. Review the generated request before applying it."],
          summary: `${provider.name}: ${state.kind} — ${known.protocol}`,
        };
        patchAssistant(provider.id, { loading: false, result });
        return;
      }
      const result = importCurlAdapter(curl, state.kind, resolveMediaAdapter(provider, state.kind)?.model ?? "");
      if (result.adapter && docsURL) result.adapter.docsURL = docsURL;
      patchAssistant(provider.id, { loading: false, result });
    } catch (error) {
      patchAssistant(provider.id, { loading: false, result: { errors: [String(error)], warnings: [], summary: "Assistant could not build the adapter" } });
    }
  }

  function applyAssistantResult(i: number) {
    const provider = local[i];
    const state = assistantFor(provider);
    const adapter = state.result?.adapter;
    if (!adapter) return;
    const errors = validateMediaAdapter(adapter);
    if (errors.length) {
      patchAssistant(provider.id, { result: { ...state.result!, errors: [...state.result!.errors, ...errors] } });
      return;
    }
    updateMediaAdapter(i, state.kind, adapter);
    const role = state.kind as ProviderRole;
    const roles = provider.roles ?? ["chat"];
    if (!roles.includes(role)) update(i, { mediaAdapters: { ...provider.mediaAdapters, [state.kind]: adapter }, roles: [...roles, role] });
    patchAssistant(provider.id, { result: { ...state.result!, summary: `${state.result!.summary} — applied locally` } });
  }

  function toggleRole(i: number, role: ProviderRole) {
    const cur = local[i].roles ?? ["chat"];
    const has = cur.includes(role);
    const next = has ? cur.filter((r) => r !== role) : [...cur, role];
    update(i, { roles: next });
  }

  function updateModelReasoning(i: number, model: string, config: ModelReasoningConfig | null) {
    setLocal((cur) =>
      cur.map((provider, j) =>
        j === i
          ? { ...provider, modelReasoning: { ...provider.modelReasoning, [model]: config } }
          : provider
      )
    );
  }

  function parseReasoningOptions(raw: string) {
    return raw.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
      const separator = item.indexOf("=");
      return separator < 0
        ? { label: item, value: item }
        : { label: item.slice(0, separator).trim(), value: item.slice(separator + 1).trim() };
    }).filter((option) => option.label && option.value);
  }

  function addProvider() {
    const id = `custom-${Date.now()}`;
    setLocal((cur) => [
      ...cur,
      {
        id,
        name: t("newProvider"),
        baseURL: "https://",
        apiKey: "",
        models: ["model-name"],
        protocol: "custom-json",
        customAdapter: newCustomAdapter(),
      },
    ]);
    setSelectedSection("other");
  }

  function remove(i: number) {
    setLocal((cur) => cur.filter((_, j) => j !== i));
  }

  const [fetching, setFetching] = useState<number | null>(null);
  const [fetchErr, setFetchErr] = useState<number | null>(null);

  // Pull the provider's real model list from its /models endpoint, using the
  // key stored in the form (the key never leaves the machine).
  async function fetchModels(i: number) {
    const p = local[i];
    setFetching(i);
    setFetchErr(null);
    try {
      const res = await tauriFetch(`${p.baseURL.replace(/\/+$/, "")}/models`, {
        headers: { Authorization: `Bearer ${p.apiKey}` },
      });
      if (!res.ok) throw new Error(String(res.status));
      const j: any = await res.json();
      const ids = (Array.isArray(j?.data) ? j.data : [])
        .map((m: any) => m?.id)
        .filter((x: any) => typeof x === "string");
      if (!ids.length) throw new Error("empty");
      const curated = p.id === "openai"
        ? OPENAI_MODELS.filter((model) => ids.includes(model) || (model === "gpt-5.5-pro" && ids.includes("gpt-5.5-pro-2026-04-23")))
        : p.id === "gemini"
          ? GEMINI_MODELS.filter((model) => ids.includes(model))
          : ids;
      update(i, { models: curated.length ? curated : ids });
    } catch {
      setFetchErr(i);
    } finally {
      setFetching(null);
    }
  }

  // ---- MCP servers ----
  const [mcpLocal, setMcpLocal] = useState<McpServer[]>(() => mcpServers.map((s) => ({ ...s })));
  const [mcpTest, setMcpTest] = useState<Record<string, { loading: boolean; tools?: string[]; error?: string }>>({});

  function updateMcp(i: number, patch: Partial<McpServer>) {
    setMcpLocal((cur) => cur.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  }

  function addMcp() {
    setMcpLocal((cur) => [...cur, newMcpServer()]);
  }

  // ---- Studio MCP presets (local Photoshop/After Effects/Premiere/OBS
  // servers). Primary path: MAHI downloads them itself into a hidden folder
  // under Documents (see studioMcp.ts / src-tauri/src/mcp_servers.rs).
  // A manual path field remains as a fallback for development, where the
  // folder is the repo's own gitignored mcp-servers/ rather than a download. ----
  const [studioDir, setStudioDir] = useState(() => localStorage.getItem(STUDIO_MCP_DIR_KEY) ?? "");
  const [studioStatus, setStudioStatus] = useState<StudioMcpStatus | null>(null);
  const [studioBusy, setStudioBusy] = useState(false);
  const [studioProgress, setStudioProgress] = useState<StudioMcpProgress | null>(null);
  const [studioError, setStudioError] = useState<string | null>(null);
  const [showStudioManual, setShowStudioManual] = useState(false);

  useEffect(() => {
    checkStudioMcpStatus()
      .then(setStudioStatus)
      .catch(() => {});
  }, []);

  function addStudioPresets(dirOverride?: string) {
    const dir = (dirOverride ?? studioDir).trim().replace(/\/+$/, "");
    if (!dir) return;
    localStorage.setItem(STUDIO_MCP_DIR_KEY, dir);
    setStudioDir(dir);
    const next = mergeStudioMcpServers(mcpLocal, dir);
    setMcpLocal(next);
    // Installing/updating a managed bundle is an explicit action, so make
    // the four servers available to chat immediately; the modal's main Save
    // button remains for ordinary form edits.
    onSaveMcp(next);
  }

  async function downloadStudioMcp() {
    setStudioBusy(true);
    setStudioError(null);
    setStudioProgress(null);
    try {
      const status = await installStudioMcp(setStudioProgress);
      setStudioStatus(status);
      addStudioPresets(status.dir);
    } catch (e) {
      setStudioError(String(e));
    } finally {
      setStudioBusy(false);
      setStudioProgress(null);
    }
  }

  function removeMcp(i: number) {
    setMcpLocal((cur) => cur.filter((_, j) => j !== i));
  }

  function envToText(env?: Record<string, string>): string {
    return Object.entries(env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  function textToEnv(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (key) out[key] = line.slice(eq + 1).trim();
    }
    return out;
  }

  // Connects to the server right now (fresh handshake, see mcp.rs) and lists
  // its tools — both a "does this actually work" check and what refreshes
  // the cached tool list a running chat turn will use next.
  async function testMcp(i: number) {
    const s = mcpLocal[i];
    setMcpTest((cur) => ({ ...cur, [s.id]: { loading: true } }));
    invalidateMcpToolCache(s.id);
    try {
      const tools = await listMcpTools(s);
      setMcpTest((cur) => ({ ...cur, [s.id]: { loading: false, tools: tools.map((t) => t.name) } }));
    } catch (e) {
      setMcpTest((cur) => ({ ...cur, [s.id]: { loading: false, error: String(e) } }));
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        dir={uiDir()}
        style={{ width: 760, maxHeight: "86vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("providersTitle")}</h3>
        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 14, lineHeight: 1.7 }}>
          {t("providersNote")}
        </div>

        <div className="service-menu">
          {PROVIDER_PRESETS.map((preset) => {
            const configured = local.find((provider) => provider.id === preset.id)?.apiKey;
            return (
              <button
                key={preset.id}
                className={`service-button${selectedSection === preset.id ? " active" : ""}`}
                onClick={() => setSelectedSection(preset.id)}
                title={preset.name}
              >
                <span className="service-mark provider-logo" style={{ "--service-color": preset.accent } as React.CSSProperties}>
                  <img src={PROVIDER_LOGOS[preset.id]} alt="" />
                </span>
                <span>{preset.name}</span>
                <span className={`service-state${configured ? " ready" : ""}`} />
              </button>
            );
          })}
          <button className={`service-button${selectedSection === "local" ? " active" : ""}`} onClick={() => setSelectedSection("local")}>
            <span className="service-mark local"><Cpu size={17} /></span><span>Local Model</span>
          </button>
          <button className={`service-button${selectedSection === "mcp" ? " active" : ""}`} onClick={() => setSelectedSection("mcp")}>
            <span className="service-mark mcp"><Puzzle size={17} /></span><span>MCP</span>
          </button>
          <button className={`service-button${selectedSection === "other" ? " active" : ""}`} onClick={() => setSelectedSection("other")}>
            <span className="service-mark other"><Braces size={17} /></span><span>Other</span>
          </button>
          <button className={`service-button${selectedSection === "general" ? " active" : ""}`} onClick={() => setSelectedSection("general")}>
            <span className="service-mark general"><Settings2 size={17} /></span><span>{t("settings")}</span>
          </button>
        </div>

        {selectedSection === "general" && <>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            marginBottom: 16,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
          }}
        >
          <input
            type="checkbox"
            checked={routingEnabled}
            onChange={(e) => {
              setRoutingEnabled(e.target.checked);
              setRoleRoutingEnabled(e.target.checked);
            }}
          />
          <div>
            <div>{t("roleRoutingLabel")}</div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{t("roleRoutingHelp")}</div>
          </div>
        </label>

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            marginBottom: 16,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
          }}
        >
          <input
            type="checkbox"
            checked={browserToolsEnabled}
            onChange={(e) => {
              setBrowserToolsEnabledState(e.target.checked);
              setBrowserToolsEnabled(e.target.checked);
            }}
          />
          <div>
            <div>{t("browserToolsLabel")}</div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{t("browserToolsHelp")}</div>
          </div>
        </label>

        </>}

        {selectedSection === "mcp" && (
        <div
          style={{
            marginBottom: 16,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 13, marginBottom: 4 }}>{t("mcpServersTitle")}</div>
          <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 10, lineHeight: 1.6 }}>{t("mcpServersNote")}</div>

          {mcpLocal.map((s, i) => {
            const test = mcpTest[s.id];
            return (
              <div
                key={s.id}
                style={{
                  border: "1px solid var(--border-soft)",
                  borderRadius: 8,
                  padding: 10,
                  marginBottom: 8,
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                }}
              >
                <label style={{ fontSize: 11, opacity: 0.7 }}>
                  {t("name")}
                  <input
                    style={{ width: "100%", marginTop: 3 }}
                    value={s.name}
                    onChange={(e) => updateMcp(i, { name: e.target.value })}
                  />
                </label>
                <label style={{ fontSize: 11, opacity: 0.7 }}>
                  {t("mcpTransport")}
                  <select
                    style={{ width: "100%", marginTop: 3 }}
                    value={s.transport}
                    onChange={(e) => updateMcp(i, { transport: e.target.value as McpTransport })}
                  >
                    <option value="http">HTTP</option>
                    <option value="stdio">stdio</option>
                  </select>
                </label>

                {s.transport === "http" ? (
                  <>
                    <label style={{ fontSize: 11, opacity: 0.7, gridColumn: "1 / -1" }}>
                      {t("mcpUrl")}
                      <input
                        dir="ltr"
                        style={{ width: "100%", marginTop: 3 }}
                        value={s.url ?? ""}
                        onChange={(e) => updateMcp(i, { url: e.target.value })}
                      />
                    </label>
                    <label style={{ fontSize: 11, opacity: 0.7, gridColumn: "1 / -1" }}>
                      {t("mcpApiKey")}
                      <input
                        dir="ltr"
                        type="password"
                        style={{ width: "100%", marginTop: 3 }}
                        value={s.apiKey ?? ""}
                        onChange={(e) => updateMcp(i, { apiKey: e.target.value })}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label style={{ fontSize: 11, opacity: 0.7 }}>
                      {t("mcpCommand")}
                      <input
                        dir="ltr"
                        style={{ width: "100%", marginTop: 3 }}
                        value={s.command ?? ""}
                        onChange={(e) => updateMcp(i, { command: e.target.value })}
                      />
                    </label>
                    <label style={{ fontSize: 11, opacity: 0.7 }}>
                      {t("mcpArgs")}
                      <input
                        dir="ltr"
                        style={{ width: "100%", marginTop: 3 }}
                        value={(s.args ?? []).join(" ")}
                        onChange={(e) => updateMcp(i, { args: e.target.value.split(/\s+/).filter(Boolean) })}
                      />
                    </label>
                    {s.id === "studio-obs" && (
                      <label style={{ fontSize: 11, opacity: 0.85, gridColumn: "1 / -1" }}>
                        {t("mcpObsPassword")}
                        <input
                          dir="ltr"
                          type="password"
                          autoComplete="off"
                          style={{ width: "100%", marginTop: 3 }}
                          value={s.env?.OBS_WS_PASSWORD ?? ""}
                          onChange={(e) =>
                            updateMcp(i, { env: { ...(s.env ?? {}), OBS_WS_PASSWORD: e.target.value } })
                          }
                        />
                        <span style={{ display: "block", marginTop: 3, opacity: 0.65 }}>
                          {t("mcpObsPasswordHelp")}
                        </span>
                      </label>
                    )}
                    <label style={{ fontSize: 11, opacity: 0.7, gridColumn: "1 / -1" }}>
                      {t("mcpEnvVars")}
                      <textarea
                        dir="ltr"
                        rows={2}
                        style={{ width: "100%", marginTop: 3, fontFamily: "inherit", fontSize: 12 }}
                        value={envToText(
                          s.id === "studio-obs"
                            ? Object.fromEntries(Object.entries(s.env ?? {}).filter(([key]) => key !== "OBS_WS_PASSWORD"))
                            : s.env
                        )}
                        onChange={(e) => {
                          const parsed = textToEnv(e.target.value);
                          updateMcp(i, {
                            env: s.id === "studio-obs"
                              ? { ...parsed, OBS_WS_PASSWORD: s.env?.OBS_WS_PASSWORD ?? "" }
                              : parsed,
                          });
                        }}
                      />
                    </label>
                  </>
                )}

                <label
                  style={{
                    gridColumn: "1 / -1",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 11.5,
                  }}
                >
                  <input type="checkbox" checked={s.enabled} onChange={(e) => updateMcp(i, { enabled: e.target.checked })} />
                  {t("mcpEnabled")}
                </label>

                <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
                  <button className="ghost" disabled={test?.loading} onClick={() => testMcp(i)}>
                    <RefreshCw size={13} className={test?.loading ? "typing" : undefined} /> {t("mcpListTools")}
                  </button>
                  <button className="ghost" style={{ color: "var(--red)" }} onClick={() => removeMcp(i)}>
                    <Trash2 size={13} /> {t("del")}
                  </button>
                  {test?.tools && (
                    <span style={{ fontSize: 11, opacity: 0.7 }} dir="ltr">
                      {t("mcpToolsFound")}: {test.tools.join(", ")}
                    </span>
                  )}
                  {test?.error && (
                    <span style={{ fontSize: 11, color: "var(--red)" }} dir="ltr">
                      {test.error}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          <button onClick={addMcp}>
            <Plus size={14} /> {t("mcpAddServer")}
          </button>

          <div
            style={{
              border: "1px solid var(--border-soft)",
              borderRadius: 8,
              padding: 10,
              marginTop: 10,
            }}
          >
            <div style={{ fontSize: 12, marginBottom: 4 }}>{t("mcpStudioTitle")}</div>
            <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 8, lineHeight: 1.6 }}>{t("mcpStudioNote")}</div>

            {studioStatus?.installed && (
              <div style={{ fontSize: 11, opacity: 0.75, marginBottom: 8 }} dir="ltr">
                <CheckCircle2 size={12} style={{ verticalAlign: -1, marginInlineEnd: 4 }} />
                {t("mcpStudioInstalled")} — v{studioStatus.version} ({studioStatus.dir})
              </div>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={downloadStudioMcp} disabled={studioBusy}>
                {studioBusy ? <RefreshCw size={14} className="typing" /> : <Download size={14} />}
                {studioStatus?.installed ? t("mcpStudioUpdate") : t("mcpStudioDownload")}
              </button>
              <button onClick={() => setShowStudioManual((v) => !v)} style={{ fontSize: 11, opacity: 0.7 }}>
                {t("mcpStudioManualToggle")}
              </button>
            </div>

            {studioBusy && studioProgress && (
              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 8 }}>
                {studioProgress.message}
                {studioProgress.percent !== null && ` — ${studioProgress.percent}%`}
              </div>
            )}
            {studioError && (
              <div style={{ fontSize: 11, color: "var(--red)", marginTop: 8 }} dir="ltr">
                {studioError}
              </div>
            )}

            {showStudioManual && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10 }}>
                <input
                  style={{ flex: 1 }}
                  dir="ltr"
                  placeholder={t("mcpStudioDir")}
                  value={studioDir}
                  onChange={(e) => setStudioDir(e.target.value)}
                />
                <button onClick={() => addStudioPresets()} disabled={!studioDir.trim()}>
                  <Plus size={14} /> {t("mcpStudioAdd")}
                </button>
              </div>
            )}
          </div>
        </div>

        )}

        {selectedSection === "general" && <>
        <div
          style={{
            marginBottom: 16,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 12.5, marginBottom: 8 }}>{t("improveModelLabel")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={improveProviderId}
              onChange={(e) => {
                const nextId = e.target.value;
                const nextProvider = providers.find((p) => p.id === nextId);
                const nextModel = nextProvider?.models[0] ?? "";
                setImproveProviderId(nextId);
                saveImproveProviderId(nextId);
                setImproveModel(nextModel);
                saveImproveModel(nextModel);
              }}
              style={{ flex: 1 }}
            >
              {providers.filter((p) => p.apiKey).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={improveModelSafe}
              onChange={(e) => {
                setImproveModel(e.target.value);
                saveImproveModel(e.target.value);
              }}
              style={{ flex: 1 }}
            >
              {(improveProvider?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          style={{
            marginBottom: 16,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 12.5, marginBottom: 8 }}>{t("dictationCleanupModelLabel")}</div>
          <div style={{ display: "flex", gap: 8 }}>
            <select
              value={dictationProviderId}
              onChange={(e) => {
                const nextId = e.target.value;
                const nextProvider = providers.find((p) => p.id === nextId);
                const nextModel = nextProvider?.models[0] ?? "";
                setDictationProviderId(nextId);
                saveDictationProviderId(nextId);
                setDictationModel(nextModel);
                saveDictationModel(nextModel);
              }}
              style={{ flex: 1 }}
            >
              {providers.filter((p) => p.apiKey).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              value={dictationModelSafe}
              onChange={(e) => {
                setDictationModel(e.target.value);
                saveDictationModel(e.target.value);
              }}
              style={{ flex: 1 }}
            >
              {(dictationProvider?.models ?? []).map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </div>
        </div>

        </>}

        {selectedSection === "local" && (
          <div className="service-page-empty">
            <Cpu size={28} />
            <strong>Local Model</strong>
            <span>{t("manageModels")}</span>
            <button className="primary" onClick={onOpenLocalModels}>{t("manageModels")}</button>
          </div>
        )}

        {local.map((p, i) => ({ p, i })).filter(({ p }) =>
          selectedSection === "other" ? !presetIds.has(p.id) : p.id === selectedSection
        ).map(({ p, i }) => (
          <div
            key={p.id}
            style={{
              border: "1px solid var(--border-soft)",
              borderRadius: 10,
              padding: 12,
              marginBottom: 10,
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 8,
            }}
          >
            <label style={{ fontSize: 11, opacity: 0.7 }}>
              {t("name")}
              <input
                style={{ width: "100%", marginTop: 3 }}
                value={p.name}
                onChange={(e) => update(i, { name: e.target.value })}
              />
            </label>
            <label style={{ fontSize: 11, opacity: 0.7 }}>
              Base URL
              <input
                dir="ltr"
                style={{ width: "100%", marginTop: 3 }}
                value={p.baseURL}
                onChange={(e) => update(i, { baseURL: e.target.value })}
              />
            </label>
            <label style={{ fontSize: 11, opacity: 0.7 }}>
              API protocol
              <select
                dir="ltr"
                style={{ width: "100%", marginTop: 3 }}
                value={p.protocol ?? "auto"}
                onChange={(e) => {
                  const protocol = e.target.value as Provider["protocol"];
                  update(i, { protocol, ...(protocol === "custom-json" && !p.customAdapter ? { customAdapter: newCustomAdapter() } : {}) });
                }}
              >
                <option value="auto">Auto detect</option>
                <option value="chat-completions">OpenAI-compatible Chat</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="gemini-chat">Gemini OpenAI-compatible</option>
                <option value="custom-json">Custom JSON adapter</option>
              </select>
            </label>
            <label style={{ fontSize: 11, opacity: 0.7 }}>
              API key
              <input
                dir="ltr"
                type="password"
                style={{ width: "100%", marginTop: 3 }}
                value={p.apiKey}
                onChange={(e) => update(i, { apiKey: e.target.value })}
              />
            </label>
            <label style={{ fontSize: 11, opacity: 0.7 }}>
              {t("modelsCsv")}
              <input
                dir="ltr"
                style={{ width: "100%", marginTop: 3 }}
                value={p.models.join(", ")}
                onChange={(e) =>
                  update(i, { models: e.target.value.split(",").map((m) => m.trim()).filter(Boolean) })
                }
              />
            </label>

            <label
              style={{
                gridColumn: "1 / -1",
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontSize: 11.5,
              }}
            >
              <input
                type="checkbox"
                checked={p.supportsVision !== false}
                onChange={(e) => update(i, { supportsVision: e.target.checked })}
              />
              {t("providerSupportsVision")}
            </label>

            {(() => {
              const assistant = assistantFor(p);
              const capabilities = mediaCapabilities(p);
              return (
                <details className="adapter-studio" style={{ gridColumn: "1 / -1" }}>
                  <summary>
                    <span><Sparkles size={14} /> Adapter Studio</span>
                    <span className="adapter-capabilities">
                      {capabilities.length ? capabilities.join(" · ") : "curl / official docs"}
                    </span>
                  </summary>
                  <div className="adapter-studio-body">
                    <div className="adapter-kind-row">
                      {(["image", "audio", "video"] as MediaKind[]).map((kind) => {
                        const configured = resolveMediaAdapter(p, kind);
                        return (
                          <button
                            key={kind}
                            className={`role-pill ${assistant.kind === kind ? "on" : ""}`}
                            onClick={() => patchAssistant(p.id, { kind, result: undefined })}
                          >
                            {configured ? <CheckCircle2 size={12} /> : <AlertTriangle size={12} />}
                            {kind}
                          </button>
                        );
                      })}
                    </div>
                    <textarea
                      dir="ltr"
                      rows={6}
                      value={assistant.input}
                      onChange={(event) => patchAssistant(p.id, { input: event.target.value, result: undefined })}
                      placeholder="Paste curl, paste an official docs URL, or ask to load the official image/audio/video preset…"
                    />
                    <div className="adapter-assistant-actions">
                      <button className="ghost" disabled={assistant.loading} onClick={() => runAdapterAssistant(i)}>
                        <Sparkles size={13} className={assistant.loading ? "typing" : undefined} />
                        {assistant.loading ? "Inspecting…" : "Analyze safely"}
                      </button>
                      {assistant.result?.adapter && !assistant.result.errors.length && (
                        <button className="primary" onClick={() => applyAssistantResult(i)}>Apply adapter</button>
                      )}
                    </div>
                    {assistant.result && (
                      <div className={`adapter-assistant-result${assistant.result.errors.length ? " error" : ""}`}>
                        <strong>{assistant.result.summary}</strong>
                        {assistant.result.errors.map((error) => <span key={error}>{error}</span>)}
                        {assistant.result.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                        {assistant.result.adapter && (
                          <pre dir="ltr">{JSON.stringify({
                            protocol: assistant.result.adapter.protocol,
                            endpoint: assistant.result.adapter.endpoint,
                            model: assistant.result.adapter.model,
                            headers: assistant.result.adapter.headers,
                            body: assistant.result.adapter.body,
                            response: assistant.result.adapter.response,
                            job: assistant.result.adapter.job,
                          }, null, 2)}</pre>
                        )}
                      </div>
                    )}
                  </div>
                </details>
              );
            })()}

            {p.protocol === "custom-json" && (() => {
              const adapter = p.customAdapter ?? newCustomAdapter();
              const field = (label: string, key: keyof typeof adapter) => (
                <label style={{ fontSize: 11, opacity: 0.75 }}>
                  {label}
                  <input dir="ltr" style={{ width: "100%", marginTop: 3 }} value={String(adapter[key] ?? "")}
                    onChange={(e) => updateAdapter(i, { [key]: e.target.value })} />
                </label>
              );
              return (
                <details open style={{ gridColumn: "1 / -1", border: "1px solid var(--accent-soft)", borderRadius: 8, padding: 9 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Custom request / response mapping</summary>
                  <div className="adapter-grid">
                    {field("POST endpoint path", "endpointPath")}
                    <label style={{ fontSize: 11, opacity: 0.75 }}>Response mode
                      <select dir="ltr" style={{ width: "100%", marginTop: 3 }} value={adapter.streamMode}
                        onChange={(e) => updateAdapter(i, { streamMode: e.target.value as "sse" | "json" })}>
                        <option value="sse">SSE stream</option><option value="json">Single JSON</option>
                      </select>
                    </label>
                    {field("Auth header", "authHeader")}{field("Auth scheme", "authScheme")}
                    {field("Model field path", "modelPath")}{field("Messages field path", "messagesPath")}
                    {field("Tools field path", "toolsPath")}{field("Stream field path", "streamPath")}
                    {field("Temperature field path", "temperaturePath")}{field("Max tokens field path", "maxTokensPath")}
                    {field("Reasoning field path", "reasoningPath")}
                    {field("Final text response path", "responseTextPath")}{field("Stream delta text path", "streamTextPath")}
                    {field("Tool calls path", "toolCallsPath")}{field("Usage path", "usagePath")}
                    {field("Error message path", "errorPath")}
                    <label style={{ gridColumn: "1 / -1", fontSize: 11, opacity: 0.75 }}>Custom headers (JSON; use {"{{apiKey}}"})
                      <textarea dir="ltr" rows={4} defaultValue={JSON.stringify(adapter.headers, null, 2)}
                        onBlur={(e) => { try { updateAdapter(i, { headers: JSON.parse(e.target.value) }); } catch { e.target.value = JSON.stringify(adapter.headers, null, 2); } }} />
                    </label>
                    <label style={{ gridColumn: "1 / -1", fontSize: 11, opacity: 0.75 }}>Raw body defaults / overrides (JSON)
                      <textarea dir="ltr" rows={6} defaultValue={JSON.stringify(adapter.body, null, 2)}
                        onBlur={(e) => { try { updateAdapter(i, { body: JSON.parse(e.target.value) }); } catch { e.target.value = JSON.stringify(adapter.body, null, 2); } }} />
                    </label>
                  </div>
                </details>
              );
            })()}

            <details style={{ gridColumn: "1 / -1", border: "1px solid var(--border-soft)", borderRadius: 7, padding: "6px 8px" }}>
              <summary style={{ cursor: "pointer", fontSize: 11.5 }}>Reasoning configuration</summary>
              <div style={{ display: "grid", gap: 7, marginTop: 8 }}>
                {p.models.map((model) => {
                  const config = modelReasoningConfig(p, model);
                  const optionText = config?.options
                    .map((option) => option.label === option.value ? option.value : `${option.label}=${option.value}`)
                    .join(", ") ?? "";
                  return (
                    <div key={model} style={{ display: "grid", gridTemplateColumns: "minmax(110px, 1fr) 130px 1.5fr 110px", gap: 6, alignItems: "center" }}>
                      <label dir="ltr" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11 }}>
                        <input
                          type="checkbox"
                          checked={!!config}
                          onChange={(e) => updateModelReasoning(i, model, e.target.checked ? {
                            parameter: "reasoning_effort",
                            options: ["low", "medium", "high"].map((value) => ({ label: value, value })),
                            defaultValue: "medium",
                          } : null)}
                        />
                        {model}
                      </label>
                      <select
                        dir="ltr"
                        disabled={!config}
                        value={config?.parameter ?? "reasoning_effort"}
                        onChange={(e) => config && updateModelReasoning(i, model, { ...config, parameter: e.target.value as ModelReasoningConfig["parameter"] })}
                        title="API payload format"
                      >
                        <option value="reasoning_effort">reasoning_effort</option>
                        <option value="responses_reasoning">responses reasoning</option>
                        <option value="thinking">thinking</option>
                        <option value="budget_tokens">budget_tokens</option>
                      </select>
                      <input
                        key={`${model}:${optionText}`}
                        dir="ltr"
                        disabled={!config}
                        defaultValue={optionText}
                        placeholder="low, medium, high"
                        title="Choices: value or Label=value, comma-separated"
                        onBlur={(e) => {
                          if (!config) return;
                          const options = parseReasoningOptions(e.target.value);
                          updateModelReasoning(i, model, {
                            ...config,
                            options,
                            defaultValue: options.some((option) => option.value === config.defaultValue)
                              ? config.defaultValue
                              : options[0]?.value ?? "",
                          });
                        }}
                      />
                      <select
                        dir="ltr"
                        disabled={!config || !config.options.length}
                        value={config?.defaultValue ?? ""}
                        title="Default value"
                        onChange={(e) => config && updateModelReasoning(i, model, { ...config, defaultValue: e.target.value })}
                      >
                        {(config?.options ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </div>
                  );
                })}
              </div>
            </details>

            <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 6 }}>
              {PROVIDER_ROLES.map((role) => {
                const checked = (p.roles ?? ["chat"]).includes(role);
                return (
                  <label
                    key={role}
                    className={`role-pill ${checked ? "on" : ""}`}
                    style={{ cursor: "pointer", userSelect: "none" }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRole(i, role)}
                      style={{ marginInlineEnd: 4 }}
                    />
                    {t(ROLE_LABEL_KEY[role])}
                  </label>
                );
              })}
            </div>

            {(["image", "audio", "video"] as MediaKind[]).filter((kind) =>
              (p.roles ?? []).includes(kind) || !!resolveMediaAdapter(p, kind)
            ).map((kind) => {
              const adapter = resolveMediaAdapter(p, kind);
              if (!adapter) return null;
              const roleEnabled = (p.roles ?? []).includes(kind);
              return (
                <div key={kind} className="media-adapter-card" style={{ gridColumn: "1 / -1" }}>
                  <div className="media-adapter-card-head">
                    <strong>{kind}</strong>
                    <span>{adapter.protocol}</span>
                    <span>{adapter.source === "assistant" ? "assistant" : adapter.source === "custom" ? "custom" : "official preset"}</span>
                  </div>
                  <label>
                    Model
                    <input
                      dir="ltr"
                      list={`media-models-${i}-${kind}`}
                      value={adapter.model}
                      onChange={(event) => {
                        const next = { ...adapter, model: event.target.value, source: "custom" as const };
                        updateMediaAdapter(i, kind, next);
                        const legacy = kind === "image" ? { imageModel: event.target.value } : kind === "audio" ? { audioModel: event.target.value } : { videoModel: event.target.value };
                        update(i, { mediaAdapters: { ...p.mediaAdapters, [kind]: next }, ...legacy });
                      }}
                    />
                    <datalist id={`media-models-${i}-${kind}`}>
                      {(adapter.models ?? []).map((model) => <option key={model} value={model} />)}
                    </datalist>
                  </label>
                  <label>
                    Endpoint
                    <input dir="ltr" value={adapter.endpoint} onChange={(event) => updateMediaAdapter(i, kind, { ...adapter, endpoint: event.target.value, source: "custom" })} />
                  </label>
                  <details className="media-adapter-advanced">
                    <summary>Advanced request / response mapping</summary>
                    <div className="adapter-grid">
                      <label>Auth header
                        <input dir="ltr" value={adapter.authHeader ?? ""} onChange={(event) => updateMediaAdapter(i, kind, { ...adapter, authHeader: event.target.value, source: "custom" })} />
                      </label>
                      <label>Auth scheme
                        <input dir="ltr" value={adapter.authScheme ?? ""} onChange={(event) => updateMediaAdapter(i, kind, { ...adapter, authScheme: event.target.value, source: "custom" })} />
                      </label>
                      <label>Headers JSON
                        <textarea key={`headers:${JSON.stringify(adapter.headers)}`} dir="ltr" rows={4} defaultValue={JSON.stringify(adapter.headers ?? {}, null, 2)} onBlur={(event) => {
                          try { updateMediaAdapter(i, kind, { ...adapter, headers: JSON.parse(event.target.value), source: "custom" }); }
                          catch { event.target.value = JSON.stringify(adapter.headers ?? {}, null, 2); }
                        }} />
                      </label>
                      <label>Body template JSON
                        <textarea key={`body:${JSON.stringify(adapter.body)}`} dir="ltr" rows={6} defaultValue={JSON.stringify(adapter.body, null, 2)} onBlur={(event) => {
                          try { updateMediaAdapter(i, kind, { ...adapter, body: JSON.parse(event.target.value), source: "custom" }); }
                          catch { event.target.value = JSON.stringify(adapter.body, null, 2); }
                        }} />
                      </label>
                      <label>Response mapping JSON
                        <textarea key={`response:${JSON.stringify(adapter.response)}`} dir="ltr" rows={5} defaultValue={JSON.stringify(adapter.response, null, 2)} onBlur={(event) => {
                          try { updateMediaAdapter(i, kind, { ...adapter, response: JSON.parse(event.target.value), source: "custom" }); }
                          catch { event.target.value = JSON.stringify(adapter.response, null, 2); }
                        }} />
                      </label>
                      <label>Async job mapping JSON
                        <textarea key={`job:${JSON.stringify(adapter.job)}`} dir="ltr" rows={7} placeholder="Optional" defaultValue={adapter.job ? JSON.stringify(adapter.job, null, 2) : ""} onBlur={(event) => {
                          try { updateMediaAdapter(i, kind, { ...adapter, job: event.target.value.trim() ? JSON.parse(event.target.value) : undefined, protocol: event.target.value.trim() ? "custom-async" : adapter.protocol, source: "custom" }); }
                          catch { event.target.value = adapter.job ? JSON.stringify(adapter.job, null, 2) : ""; }
                        }} />
                      </label>
                    </div>
                  </details>
                  {!roleEnabled && <span className="media-adapter-note">Available but not assigned to this role.</span>}
                  {adapter.docsURL && <a href={adapter.docsURL} target="_blank" rel="noreferrer">Official docs</a>}
                </div>
              );
            })}
            {((p.roles ?? []).includes("image") || (p.roles ?? []).includes("audio") || (p.roles ?? []).includes("video")) && (
              // Native <datalist>: gives a real dropdown of the provider's
              // already-fetched model list (see fetchModels/"دریافت مدل‌ها از
              // سرویس" above) while still allowing free typing — some
              // providers' image/audio/video model ids aren't part of the
              // same /models listing used for the chat model field.
              <datalist id={`role-models-${i}`}>
                {Array.from(new Set([...p.models, ...(p.imageModels ?? [])])).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            )}

            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8 }}>
              {fetchErr === i && (
                <span style={{ fontSize: 11, color: "var(--red)", flex: 1 }}>{t("fetchModelsFailed")}</span>
              )}
              <button className="ghost" disabled={fetching === i || !p.apiKey} onClick={() => fetchModels(i)}>
                <RefreshCw size={13} className={fetching === i ? "typing" : undefined} /> {t("fetchModels")}
              </button>
              {!presetIds.has(p.id) && (
                <button className="ghost" style={{ color: "var(--red)" }} onClick={() => remove(i)}>
                  <Trash2 size={13} /> {t("del")}
                </button>
              )}
            </div>
          </div>
        ))}

        {selectedSection === "other" && (
          <button onClick={addProvider} style={{ marginBottom: 16 }}>
            <Plus size={14} /> {t("addProvider")}
          </button>
        )}

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose}>{t("cancel")}</button>
          <button
            className="primary"
            onClick={() => {
              onSave(local.filter((p) => p.baseURL.startsWith("https://") && p.models.length));
              onSaveMcp(mcpLocal);
              onClose();
            }}
          >
            {t("save")}
          </button>
        </div>
      </div>
    </div>
  );
}
