import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import {
  listWindowVisionSessions,
  presentWindowVisionPicker,
  requestWindowVisionPermission,
  stopAllWindowObservations,
  waitForWindowVisionPicker,
  windowVisionCapabilities,
  type WindowVisionCapabilities,
} from "./windowVision";

export default function WindowVisionSettings() {
  const [capabilities, setCapabilities] = useState<WindowVisionCapabilities | null>(null);
  const [activeSessions, setActiveSessions] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  async function refresh() {
    const caps = await windowVisionCapabilities();
    setCapabilities(caps);
    if (!caps.supported) return;
    const sessions = await listWindowVisionSessions().catch(() => []);
    setActiveSessions(sessions.filter((session) => ["active", "stale", "starting"].includes(session.status)).length);
  }

  useEffect(() => {
    refresh().catch((error) => setMessage(String(error)));
    return () => abortRef.current?.abort();
  }, []);

  if (!capabilities?.supported) return null;

  async function chooseDisplay() {
    setBusy(true);
    setMessage("");
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      const request = await presentWindowVisionPicker("display");
      if (request.status === "failed") throw new Error(request.error ?? "Unable to open picker");
      const result = await waitForWindowVisionPicker(request.sessionId, abortRef.current.signal);
      if (result.status === "cancelled") setMessage(t("windowVisionCancelled"));
      else if (result.status === "failed") throw new Error(result.error ?? "Window capture failed");
      else setMessage(t("windowVisionReady"));
      await refresh();
    } catch (error) {
      if ((error as Error).name !== "AbortError") setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={{ borderTop: "1px solid var(--border)", paddingTop: 14, marginTop: 2, marginBottom: 16 }}>
      <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>{t("windowVisionTitle")}</div>
      <div style={{ fontSize: 11, opacity: 0.6, lineHeight: 1.5, marginBottom: 10 }}>
        {t("windowVisionHelp")}
      </div>

      {!capabilities.permissionGranted && (
        <button
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await requestWindowVisionPermission();
              setMessage(result.granted ? t("windowVisionReady") : t("windowVisionRestart"));
              await refresh();
            } finally {
              setBusy(false);
            }
          }}
          style={{ marginInlineEnd: 8, marginBottom: 8 }}
        >
          {t("windowVisionPermission")}
        </button>
      )}
      {capabilities.permissionGranted && (
        <div style={{ fontSize: 11, color: "var(--accent)", marginBottom: 8 }}>
          {t("windowVisionAutomatic")}
        </div>
      )}
      {capabilities.permissionGranted && capabilities.pickerSupported && (
        <button disabled={busy} onClick={chooseDisplay} style={{ marginBottom: 8 }}>
          {t("windowVisionChooseDisplay")}
        </button>
      )}
      <div style={{ fontSize: 10, opacity: 0.5, marginTop: 7 }}>
        {t("windowVisionSessions")}: {activeSessions}
        {activeSessions > 0 && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await stopAllWindowObservations();
                await refresh();
              } finally {
                setBusy(false);
              }
            }}
            style={{ marginInlineStart: 8 }}
          >
            {t("windowVisionStopAll")}
          </button>
        )}
      </div>
      {message && <div style={{ fontSize: 11, marginTop: 7, color: "var(--accent)" }}>{message}</div>}
    </section>
  );
}
