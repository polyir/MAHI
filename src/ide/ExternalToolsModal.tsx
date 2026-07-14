import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ExternalLink, RefreshCw } from "lucide-react";
import { t, dir as uiDir, useLang } from "./i18n";
import { ExternalTool, checkExternalToolInstalled, installExternalTool, listExternalTools } from "./externalTools";

type Status = "checking" | "installed" | "not-installed" | "installing" | "install-error";

export default function ExternalToolsModal({ onClose }: { onClose: () => void }) {
  useLang();
  const [tools, setTools] = useState<ExternalTool[]>([]);
  const [status, setStatus] = useState<Record<string, Status>>({});
  const [error, setError] = useState<Record<string, string>>({});

  useEffect(() => {
    listExternalTools().then(async (list) => {
      setTools(list);
      setStatus(Object.fromEntries(list.map((tool) => [tool.id, "checking" as Status])));
      for (const tool of list) {
        const installed = await checkExternalToolInstalled(tool.id).catch(() => false);
        setStatus((cur) => ({ ...cur, [tool.id]: installed ? "installed" : "not-installed" }));
      }
    });
  }, []);

  async function install(id: string) {
    setStatus((cur) => ({ ...cur, [id]: "installing" }));
    setError((cur) => ({ ...cur, [id]: "" }));
    try {
      await installExternalTool(id);
      setStatus((cur) => ({ ...cur, [id]: "installed" }));
    } catch (e) {
      setStatus((cur) => ({ ...cur, [id]: "install-error" }));
      setError((cur) => ({ ...cur, [id]: String(e) }));
    }
  }

  function openDocs(url: string, name: string) {
    invoke("open_console_window", { url, title: name }).catch(() => {});
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" dir={uiDir()} style={{ width: 520, maxHeight: "80vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t("externalToolsTitle")}</h3>
        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 14, lineHeight: 1.7 }}>{t("externalToolsNote")}</div>

        {tools.map((tool) => {
          const st = status[tool.id] ?? "checking";
          return (
            <div
              key={tool.id}
              style={{
                padding: 10,
                border: "1px solid var(--border-soft)",
                borderRadius: 10,
                marginBottom: 8,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{tool.name}</div>
                {st === "installed" && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11.5, color: "var(--green)" }}>
                    <Check size={13} /> {t("installed")}
                  </span>
                )}
                {st === "not-installed" && <span style={{ fontSize: 11.5, opacity: 0.6 }}>{t("notInstalled")}</span>}
                {st === "checking" && <RefreshCw size={13} className="typing" />}
              </div>
              <div style={{ fontSize: 11.5, opacity: 0.65, marginTop: 4, lineHeight: 1.6 }}>{tool.description}</div>
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button className="ghost" onClick={() => openDocs(tool.docsUrl, tool.name)}>
                  <ExternalLink size={13} /> {t("docsButton")}
                </button>
                {st !== "installed" && (
                  <button
                    className="primary"
                    disabled={st === "installing" || st === "checking"}
                    onClick={() => install(tool.id)}
                  >
                    {st === "installing" ? t("installing") : t("installButton")}
                  </button>
                )}
              </div>
              {st === "install-error" && (
                <div style={{ fontSize: 11, color: "var(--red)", marginTop: 6 }}>{error[tool.id]}</div>
              )}
            </div>
          );
        })}

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
          <button onClick={onClose}>{t("cancel")}</button>
        </div>
      </div>
    </div>
  );
}
