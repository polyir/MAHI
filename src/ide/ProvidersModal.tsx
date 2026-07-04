import { useState } from "react";
import { Plus, Trash2, RefreshCw } from "lucide-react";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  Provider,
  ProviderRole,
  PROVIDER_ROLES,
  isRoleRoutingEnabled,
  setRoleRoutingEnabled,
  isBrowserToolsEnabled,
  setBrowserToolsEnabled,
} from "./providers";
import { t, dir as uiDir, useLang, StrKey } from "./i18n";

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
}: {
  providers: Provider[];
  onSave: (p: Provider[]) => void;
  onClose: () => void;
}) {
  useLang();
  const [local, setLocal] = useState<Provider[]>(() => providers.map((p) => ({ ...p })));
  const [routingEnabled, setRoutingEnabled] = useState(isRoleRoutingEnabled());
  const [browserToolsEnabled, setBrowserToolsEnabledState] = useState(isBrowserToolsEnabled());

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
                  style={{ width: "100%", marginTop: 3 }}
                  placeholder={p.models[0] ?? ""}
                  value={p.videoModel ?? ""}
                  onChange={(e) => update(i, { videoModel: e.target.value })}
                />
              </label>
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
