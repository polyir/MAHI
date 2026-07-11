import { useEffect, useState } from "react";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  Provider,
  ProviderRole,
  PROVIDER_ROLES,
  LOCAL_PROVIDER_ID,
  isRoleRoutingEnabled,
  setRoleRoutingEnabled,
  isBrowserToolsEnabled,
  setBrowserToolsEnabled,
} from "./providers";
import { McpServer, McpTransport, newMcpServer, listMcpTools, invalidateMcpToolCache } from "./mcp";
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

const ROLE_LABEL_KEY: Record<ProviderRole, StrKey> = {
  chat: "roleChat",
  image: "roleImage",
  audio: "roleAudio",
  video: "roleVideo",
};

export default function ProvidersModal({
  providers,
  onSave,
  onClose,
  mcpServers,
  onSaveMcp,
}: {
  providers: Provider[];
  onSave: (p: Provider[]) => void;
  onClose: () => void;
  mcpServers: McpServer[];
  onSaveMcp: (s: McpServer[]) => void;
}) {
  useLang();
  useModalOpen(true);
  // The built-in local-LLM provider is virtual/auto-managed — nothing to
  // edit here (no baseURL/apiKey/models to configure), so it never appears
  // in this editable list at all.
  const [local, setLocal] = useState<Provider[]>(() =>
    providers.filter((p) => p.id !== LOCAL_PROVIDER_ID).map((p) => ({ ...p }))
  );
  const [routingEnabled, setRoutingEnabled] = useState(isRoleRoutingEnabled());
  const [browserToolsEnabled, setBrowserToolsEnabledState] = useState(isBrowserToolsEnabled());
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

  function toggleRole(i: number, role: ProviderRole) {
    const cur = local[i].roles ?? ["chat"];
    const has = cur.includes(role);
    const next = has ? cur.filter((r) => r !== role) : [...cur, role];
    update(i, { roles: next });
  }

  function addProvider() {
    setLocal((cur) => [
      ...cur,
      {
        id: `custom-${Date.now()}`,
        name: t("newProvider"),
        baseURL: "https://",
        apiKey: "",
        models: ["model-name"],
      },
    ]);
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
      update(i, { models: ids });
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
        style={{ width: 640, maxHeight: "82vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("providersTitle")}</h3>
        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 14, lineHeight: 1.7 }}>
          {t("providersNote")}
        </div>

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
                    <label style={{ fontSize: 11, opacity: 0.7, gridColumn: "1 / -1" }}>
                      {t("mcpEnvVars")}
                      <textarea
                        dir="ltr"
                        rows={2}
                        style={{ width: "100%", marginTop: 3, fontFamily: "inherit", fontSize: 12 }}
                        value={envToText(s.env)}
                        onChange={(e) => updateMcp(i, { env: textToEnv(e.target.value) })}
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
        </div>

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
              {providers.map((p) => (
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
              {providers.map((p) => (
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

        {local.map((p, i) => (
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

            {(p.roles ?? []).includes("image") && (
              <label style={{ fontSize: 11, opacity: 0.7 }}>
                {t("roleImage")} model
                <input
                  dir="ltr"
                  list={`role-models-${i}`}
                  style={{ width: "100%", marginTop: 3 }}
                  placeholder={p.models[0] ?? ""}
                  value={p.imageModel ?? ""}
                  onChange={(e) => update(i, { imageModel: e.target.value })}
                />
              </label>
            )}
            {(p.roles ?? []).includes("audio") && (
              <label style={{ fontSize: 11, opacity: 0.7 }}>
                {t("roleAudio")} model
                <input
                  dir="ltr"
                  list={`role-models-${i}`}
                  style={{ width: "100%", marginTop: 3 }}
                  placeholder={p.models[0] ?? ""}
                  value={p.audioModel ?? ""}
                  onChange={(e) => update(i, { audioModel: e.target.value })}
                />
              </label>
            )}
            {(p.roles ?? []).includes("video") && (
              <label style={{ fontSize: 11, opacity: 0.7 }}>
                {t("roleVideo")} model
                <input
                  dir="ltr"
                  list={`role-models-${i}`}
                  style={{ width: "100%", marginTop: 3 }}
                  placeholder={p.models[0] ?? ""}
                  value={p.videoModel ?? ""}
                  onChange={(e) => update(i, { videoModel: e.target.value })}
                />
              </label>
            )}
            {((p.roles ?? []).includes("image") || (p.roles ?? []).includes("audio") || (p.roles ?? []).includes("video")) && (
              // Native <datalist>: gives a real dropdown of the provider's
              // already-fetched model list (see fetchModels/"دریافت مدل‌ها از
              // سرویس" above) while still allowing free typing — some
              // providers' image/audio/video model ids aren't part of the
              // same /models listing used for the chat model field.
              <datalist id={`role-models-${i}`}>
                {p.models.map((m) => (
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
              {local.length > 1 && (
                <button className="ghost" style={{ color: "var(--red)" }} onClick={() => remove(i)}>
                  <Trash2 size={13} /> {t("del")}
                </button>
              )}
            </div>
          </div>
        ))}

        <button onClick={addProvider} style={{ marginBottom: 16 }}>
          <Plus size={14} /> {t("addProvider")}
        </button>

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
