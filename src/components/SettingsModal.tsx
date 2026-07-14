import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { t, dir, useLang, getLang, setLang, LANGS, Lang } from "../ide/i18n";
import { useModalOpen } from "../ide/modalTracker";
import WindowVisionSettings from "../ide/WindowVisionSettings";

export type SessionSettings = {
  systemPrompt: string;
  autoApprove: boolean;
  contextBudget: number;
};

export default function SettingsModal({
  settings,
  onSave,
  onClose,
  lowPowerMode,
  onLowPowerModeChange,
}: {
  settings: SessionSettings;
  onSave: (s: SessionSettings) => void;
  onClose: () => void;
  lowPowerMode: boolean;
  onLowPowerModeChange: (enabled: boolean) => void;
}) {
  useLang();
  useModalOpen(true);
  const [local, setLocal] = useState<SessionSettings>(settings);
  const [localLowPower, setLocalLowPower] = useState(lowPowerMode);
  // Read at runtime rather than imported from package.json/tauri.conf.json
  // directly — this reflects whatever build is ACTUALLY running right now,
  // which is exactly the point: it's the one place to confirm an update
  // really took effect (a self-update swaps the binary but there's
  // otherwise no visible difference to check against).
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => setAppVersion(""));
  }, []);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" dir={dir()} style={{ width: 480, maxHeight: "85vh", overflowY: "auto" }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{t("chatSettings")}</h3>

        <label style={{ fontSize: 13, opacity: 0.8 }}>{t("language")}</label>
        <select
          value={getLang()}
          onChange={(e) => setLang(e.target.value as Lang)}
          style={{ display: "block", marginTop: 4, marginBottom: 12, width: "100%" }}
        >
          {(Object.keys(LANGS) as Lang[]).map((l) => (
            <option key={l} value={l}>
              {LANGS[l]}
            </option>
          ))}
        </select>

        <label style={{ fontSize: 13, opacity: 0.8 }}>System prompt</label>
        <textarea
          value={local.systemPrompt}
          onChange={(e) => setLocal({ ...local, systemPrompt: e.target.value })}
          rows={5}
          dir="ltr"
          style={{ width: "100%", marginTop: 4, marginBottom: 12, fontFamily: "inherit", fontSize: 13 }}
        />

        <label style={{ fontSize: 13, opacity: 0.8 }}>{t("ctxBudget")}</label>
        <select
          value={String(local.contextBudget)}
          onChange={(e) => setLocal({ ...local, contextBudget: Number(e.target.value) })}
          style={{ display: "block", marginTop: 4, marginBottom: 4, width: "100%" }}
        >
          <option value="100000">100k — {t("budgetCheap")}</option>
          <option value="200000">200k — {t("budgetDefault")}</option>
          <option value="250000">250k — {t("budgetMaxCheap")}</option>
          <option value="500000">500k — {t("budget2x")}</option>
          <option value="1000000">1M — {t("budget1m")}</option>
        </select>
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 12 }}>{t("budgetNote")}</div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={local.autoApprove}
            onChange={(e) => setLocal({ ...local, autoApprove: e.target.checked })}
          />
          {t("autoApprove")}
        </label>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, marginBottom: 16 }}>
          <input
            type="checkbox"
            checked={localLowPower}
            onChange={(e) => setLocalLowPower(e.target.checked)}
          />
          <span>
            <span style={{ display: "block" }}>{t("lowPowerMode")}</span>
            <span style={{ display: "block", fontSize: 11, opacity: 0.55, marginTop: 2 }}>{t("lowPowerModeHelp")}</span>
          </span>
        </label>

        <WindowVisionSettings />

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", alignItems: "center" }}>
          {appVersion && (
            <span style={{ fontSize: 11, opacity: 0.5, marginInlineEnd: "auto" }} dir="ltr">
              MAHI v{appVersion}
            </span>
          )}
          <button onClick={onClose}>{t("cancel")}</button>
          <button
            className="primary"
            onClick={() => {
              onSave(local);
              onLowPowerModeChange(localLowPower);
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
