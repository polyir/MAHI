import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Provider } from "./providers";
import { t, dir as uiDir, useLang } from "./i18n";

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

  function update(i: number, patch: Partial<Provider>) {
    setLocal((cur) => cur.map((p, j) => (j === i ? { ...p, ...patch } : p)));
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
            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end" }}>
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
