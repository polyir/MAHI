import { useState } from "react";
import { ReasoningEffort } from "../agent";
import { t, dir, useLang, getLang, setLang, LANGS, Lang } from "../ide/i18n";

export type SessionSettings = {
  systemPrompt: string;
  reasoningEffort: ReasoningEffort;
  temperature: number;
  autoApprove: boolean;
  contextBudget: number;
};

export default function SettingsModal({
  settings,
  onSave,
  onClose,
}: {
  settings: SessionSettings;
  onSave: (s: SessionSettings) => void;
  onClose: () => void;
}) {
  useLang();
  const [local, setLocal] = useState<SessionSettings>(settings);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" dir={dir()} style={{ width: 480 }} onClick={(e) => e.stopPropagation()}>
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

        <label style={{ fontSize: 13, opacity: 0.8 }}>Reasoning effort</label>
        <select
          value={local.reasoningEffort}
          onChange={(e) => setLocal({ ...local, reasoningEffort: e.target.value as ReasoningEffort })}
          style={{ display: "block", marginTop: 4, marginBottom: 12, width: "100%" }}
        >
          <option value="high">high</option>
          <option value="xhigh">xhigh</option>
          <option value="max">max</option>
        </select>

        <label style={{ fontSize: 13, opacity: 0.8 }}>
          Temperature: {local.temperature.toFixed(1)}
        </label>
        <input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={local.temperature}
          onChange={(e) => setLocal({ ...local, temperature: parseFloat(e.target.value) })}
          style={{ width: "100%", marginTop: 4, marginBottom: 12 }}
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

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose}>{t("cancel")}</button>
          <button
            className="primary"
            onClick={() => {
              onSave(local);
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
