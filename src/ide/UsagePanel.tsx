import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe } from "lucide-react";
import { parseUsage } from "./usage";
import { getWindows, formatCountdown, WindowStat } from "./limits";
import { t, dir as uiDir, useLang } from "./i18n";

function WindowBar({ label, stat }: { label: string; stat: WindowStat }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, alignItems: "baseline" }}>
        <b>{label}</b>
        <span style={{ opacity: 0.75 }}>{stat.usedTokens.toLocaleString()} {t("tokensLogged")}</span>
      </div>
      <div style={{ fontSize: 11, opacity: 0.65, marginTop: 4 }}>
        {t("resetLabel")}: {stat.resetAt ? stat.resetAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"}{" "}
        ({formatCountdown(stat.resetAt)} {t("remaining")} · {stat.exact ? t("exactFromApi") : t("estimated")})
      </div>
    </div>
  );
}

export default function UsagePanel({
  headers,
  consoleURL,
  providerName,
  onClose,
}: {
  headers: Record<string, string> | null;
  consoleURL?: string;
  providerName: string;
  onClose: () => void;
}) {
  useLang();
  const parsed = headers ? parseUsage(headers) : null;
  const hasRateHeaders = parsed && Object.keys(parsed.raw).length > 0;
  const [windows] = useState(() => getWindows());

  async function openConsole() {
    if (!consoleURL) return;
    try {
      await invoke("open_console_window", { url: consoleURL, title: `${providerName} — Usage` });
    } catch {
      // window creation failed; nothing actionable for the user here
    }
  }

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        dir={uiDir()}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1e1e1e",
          borderRadius: 10,
          padding: 20,
          width: 520,
          maxHeight: "80vh",
          overflowY: "auto",
          border: "1px solid #333",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h3 style={{ margin: 0 }}>{t("usageLimit")}</h3>
          <span onClick={onClose} style={{ cursor: "pointer", opacity: 0.6 }}>✕</span>
        </div>

        <div style={{ marginTop: 16 }}>
          {consoleURL && (
            <button className="primary" onClick={openConsole} style={{ width: "100%", justifyContent: "center", marginBottom: 14 }}>
              <Globe size={14} /> {t("openConsoleBtn")} ({providerName})
            </button>
          )}
          <WindowBar label={t("window5h")} stat={windows.fiveHour} />
          <WindowBar label={t("weekly")} stat={windows.weekly} />
          <div style={{ fontSize: 11, opacity: 0.55, lineHeight: 1.7 }}>{t("usageNote")}</div>
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--border-soft)", margin: "16px 0" }} />

        {!headers && (
          <p style={{ fontSize: 13, opacity: 0.75, marginTop: 16 }}>{t("noRequestsYet")}</p>
        )}

        {headers && !hasRateHeaders && (
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 16, lineHeight: 1.7 }}>{t("noHeadersInfo")}</div>
        )}

        {hasRateHeaders && (
          <>
            {parsed!.windows.length > 0 && (
              <div style={{ marginTop: 16 }}>
                {parsed!.windows.map((w) => (
                  <div key={w.label} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <b>{w.label}</b>
                      <span style={{ opacity: 0.7 }}>
                        {w.usedPct !== undefined
                          ? `${w.usedPct}%`
                          : w.remaining !== undefined
                          ? `${w.remaining} ${t("remaining")}`
                          : ""}
                      </span>
                    </div>
                    {w.usedPct !== undefined && (
                      <div style={{ height: 8, background: "#333", borderRadius: 4, marginTop: 6, overflow: "hidden" }}>
                        <div style={{ width: `${w.usedPct}%`, height: "100%", background: "#2b5cab" }} />
                      </div>
                    )}
                    <div style={{ fontSize: 11, opacity: 0.6, marginTop: 4 }}>
                      {w.limit !== undefined && `max: ${w.limit} · `}
                      {w.reset && `${t("resetLabel")}: ${w.reset}`}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", fontSize: 12, opacity: 0.7 }}>
                {t("rawHeaders")}
              </summary>
              <pre style={{ fontSize: 11, background: "#141414", padding: 10, borderRadius: 6, overflowX: "auto" }}>
                {Object.entries(parsed!.raw)
                  .map(([k, v]) => `${k}: ${v}`)
                  .join("\n")}
              </pre>
            </details>
          </>
        )}
      </div>
    </div>
  );
}
