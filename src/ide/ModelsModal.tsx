import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Download, Trash2, Check, RefreshCw } from "lucide-react";
import { t, dir as uiDir, useLang } from "./i18n";
import {
  ModelStatus,
  TtsBackend,
  formatBytes,
  isElevenLabsAsrEnabled,
  loadActiveAsrModel,
  loadElevenLabsApiKey,
  loadElevenLabsModel,
  loadElevenLabsVoiceId,
  loadTtsBackend,
  saveActiveAsrModel,
  saveElevenLabsApiKey,
  saveElevenLabsModel,
  saveElevenLabsVoiceId,
  saveTtsBackend,
  saveVoiceForLang,
  setElevenLabsAsrEnabled,
} from "./models";
import { ElevenLabsModel, fetchElevenLabsModels } from "./elevenlabs";
import {
  LLAMA_RUNTIME,
  MAX_LOCAL_CTX,
  MIN_LOCAL_CTX,
  isDictationCleanupEnabled,
  isSuggestionsEnabled,
  loadLocalCtxOverride,
  localCtxDefault,
  saveLocalCtxOverride,
  setDictationCleanupEnabled,
  setSuggestionsEnabled,
} from "./localLlm";

const TTS_LANGS = ["fa", "tr", "en", "ru", "zh", "ja"];
const LANG_LABEL_KEY: Record<string, string> = {
  fa: "زبان فارسی",
  tr: "Türkçe",
  en: "English",
  ru: "Русский",
  zh: "中文",
  ja: "日本語",
};

type DownloadProgress = { downloaded: number; total: number };

// Hoisted to module scope rather than defined inside ModelsModal: a
// component declared inline in a parent's render body gets a fresh function
// identity on every parent re-render, which React treats as a brand-new
// component type — remounting it and losing whatever local state (here,
// `ctx`) it was holding. `Row` below has the same inline-definition pattern
// but holds no state of its own, so it doesn't have this problem.
function LocalCtxControl({ modelId }: { modelId: string }) {
  const [ctx, setCtx] = useState(loadLocalCtxOverride(modelId) ?? localCtxDefault(modelId));
  return (
    <div style={{ padding: "0 10px 10px", fontSize: 11.5, opacity: 0.8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span>{t("localCtxLabel")}</span>
        <input
          type="number"
          min={MIN_LOCAL_CTX}
          max={MAX_LOCAL_CTX}
          step={1024}
          value={ctx}
          dir="ltr"
          style={{ width: 90 }}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (!Number.isFinite(n)) return;
            setCtx(n);
            saveLocalCtxOverride(modelId, n);
          }}
        />
      </div>
      <div style={{ opacity: 0.65, marginTop: 2 }}>{t("localCtxHelp")}</div>
    </div>
  );
}

export default function ModelsModal({ onClose }: { onClose: () => void }) {
  useLang();
  const [models, setModels] = useState<ModelStatus[] | null>(null);
  const [downloading, setDownloading] = useState<Record<string, DownloadProgress>>({});
  const [error, setError] = useState<string | null>(null);
  const [activeAsr, setActiveAsr] = useState<string | null>(loadActiveAsrModel());
  const [suggestionsEnabled, setSuggestionsEnabledState] = useState(isSuggestionsEnabled());
  const [dictationCleanupEnabled, setDictationCleanupEnabledState] = useState(isDictationCleanupEnabled());
  const [ttsBackend, setTtsBackend] = useState<TtsBackend>(loadTtsBackend());
  const [elevenAsrEnabled, setElevenAsrEnabledState] = useState(isElevenLabsAsrEnabled());
  const [elevenApiKey, setElevenApiKey] = useState(loadElevenLabsApiKey());
  const [elevenVoiceId, setElevenVoiceId] = useState(loadElevenLabsVoiceId());
  const [elevenModel, setElevenModel] = useState(loadElevenLabsModel());
  const [elevenModels, setElevenModels] = useState<ElevenLabsModel[]>([]);
  const [fetchingElevenModels, setFetchingElevenModels] = useState(false);
  const [elevenModelsErr, setElevenModelsErr] = useState<string | null>(null);

  async function fetchModelsFromElevenLabs() {
    setFetchingElevenModels(true);
    setElevenModelsErr(null);
    try {
      setElevenModels(await fetchElevenLabsModels());
    } catch (e) {
      setElevenModelsErr(String(e));
    } finally {
      setFetchingElevenModels(false);
    }
  }

  function refresh() {
    invoke<ModelStatus[]>("model_list_status")
      .then(setModels)
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    const unlisteners = (models ?? []).map((m) =>
      listen<DownloadProgress>(`model-download://progress/${m.id}`, (e) => {
        setDownloading((cur) => ({ ...cur, [m.id]: e.payload }));
      })
    );
    return () => {
      unlisteners.forEach((p) => p.then((un) => un()));
    };
  }, [models]);

  async function download(id: string) {
    setError(null);
    const spec = (models ?? []).find((m) => m.id === id);
    try {
      // The llama-server runtime itself isn't a user-facing choice — it
      // rides along with whichever LLM the user downloads first, so it
      // never gets its own row in the list.
      if (spec?.kind === "llm" && !(models ?? []).find((m) => m.id === LLAMA_RUNTIME)?.installed) {
        setDownloading((cur) => ({ ...cur, [LLAMA_RUNTIME]: { downloaded: 0, total: 0 } }));
        try {
          await invoke("model_download", { modelId: LLAMA_RUNTIME });
        } finally {
          setDownloading((cur) => {
            const { [LLAMA_RUNTIME]: _drop, ...rest } = cur;
            return rest;
          });
        }
      }
      setDownloading((cur) => ({ ...cur, [id]: { downloaded: 0, total: 0 } }));
      await invoke("model_download", { modelId: id });
      // Only auto-pick when nothing is selected yet — once the user has an
      // active model, downloading another size shouldn't silently switch it
      // out from under them (that's exactly what caused Persian dictation to
      // go through the English-only tiny model after it happened to be the
      // most recently downloaded one).
      if (spec?.kind === "asr" && !loadActiveAsrModel()) selectAsr(id);
      if (spec?.kind === "tts" && spec.lang) saveVoiceForLang(spec.lang, id);
    } catch (e) {
      setError(String(e));
    } finally {
      setDownloading((cur) => {
        const { [id]: _drop, ...rest } = cur;
        return rest;
      });
      refresh();
    }
  }

  function selectAsr(id: string) {
    saveActiveAsrModel(id);
    setActiveAsr(id);
  }

  async function del(id: string) {
    try {
      const spec = (models ?? []).find((m) => m.id === id);
      if (spec?.kind === "llm") {
        await invoke("local_llm_stop", { modelId: id }).catch(() => {});
      }
      await invoke("model_delete", { modelId: id });
      if (activeAsr === id) {
        saveActiveAsrModel("");
        setActiveAsr(null);
      }
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const asrModels = (models ?? []).filter((m) => m.kind === "asr");
  const ttsModels = (models ?? []).filter((m) => m.kind === "tts");
  const llmModels = (models ?? []).filter((m) => m.kind === "llm" && m.id !== LLAMA_RUNTIME);
  const runtimeProgress = downloading[LLAMA_RUNTIME];
  const totalDisk = (models ?? []).reduce((sum, m) => sum + m.size_on_disk, 0);

  function Row({ m }: { m: ModelStatus }) {
    const prog = downloading[m.id];
    const isActiveAsr = m.kind === "asr" && activeAsr === m.id;
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 10px",
          border: `1px solid ${isActiveAsr ? "var(--accent)" : "var(--border-soft)"}`,
          borderRadius: 8,
          marginBottom: 6,
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
            {m.label}
            {isActiveAsr && (
              <span style={{ fontSize: 10.5, color: "var(--accent)", display: "flex", alignItems: "center", gap: 2 }}>
                <Check size={11} /> {t("modelActive")}
              </span>
            )}
          </div>
          <div style={{ fontSize: 11, opacity: 0.6 }}>
            {m.installed ? formatBytes(m.size_on_disk) : formatBytes(m.size_bytes)}
          </div>
        </div>
        {prog ? (
          <div style={{ width: 120 }}>
            <div style={{ height: 5, borderRadius: 3, background: "var(--bg-3)", overflow: "hidden" }}>
              <div
                style={{
                  width: prog.total ? `${Math.min(100, (prog.downloaded / prog.total) * 100)}%` : "3%",
                  height: "100%",
                  background: "var(--accent)",
                }}
              />
            </div>
            <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }} dir="ltr">
              {formatBytes(prog.downloaded)} / {prog.total ? formatBytes(prog.total) : "…"}
            </div>
          </div>
        ) : m.installed ? (
          <>
            {m.kind === "asr" && !isActiveAsr && (
              <button className="ghost" onClick={() => selectAsr(m.id)}>
                {t("modelUse")}
              </button>
            )}
            <button className="ghost" style={{ color: "var(--red)" }} onClick={() => del(m.id)}>
              <Trash2 size={13} /> {t("modelDelete")}
            </button>
          </>
        ) : (
          <button className="ghost" onClick={() => download(m.id)}>
            <Download size={13} /> {t("modelDownload")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        dir={uiDir()}
        style={{ width: 520, maxHeight: "80vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("localModelsTitle")}</h3>
        <div style={{ fontSize: 12, opacity: 0.65, marginBottom: 14, lineHeight: 1.7 }}>
          {t("localModelsNote")}
        </div>

        {error && (
          <div style={{ fontSize: 12, color: "var(--red)", marginBottom: 10 }}>{error}</div>
        )}

        <div className="panel-header" style={{ padding: "4px 0" }}>
          {t("asrSectionTitle")}
        </div>
        {asrModels.map((m) => (
          <Row key={m.id} m={m} />
        ))}

        <div
          style={{
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
            marginTop: 8,
          }}
        >
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
            <input
              type="checkbox"
              checked={elevenAsrEnabled}
              onChange={(e) => {
                setElevenAsrEnabledState(e.target.checked);
                setElevenLabsAsrEnabled(e.target.checked);
              }}
            />
            <div>
              <div>{t("elevenAsrLabel")}</div>
              <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{t("elevenAsrHelp")}</div>
            </div>
          </label>
          {elevenAsrEnabled && (
            <label style={{ display: "block", fontSize: 11, opacity: 0.7, marginTop: 8 }}>
              API key
              <input
                dir="ltr"
                type="password"
                style={{ width: "100%", marginTop: 3 }}
                value={elevenApiKey}
                onChange={(e) => {
                  setElevenApiKey(e.target.value);
                  saveElevenLabsApiKey(e.target.value);
                }}
              />
            </label>
          )}
        </div>

        <div className="panel-header" style={{ padding: "4px 0", marginTop: 12 }}>
          {t("ttsSectionTitle")}
        </div>
        {TTS_LANGS.map((lang) => {
          const m = ttsModels.find((x) => x.lang === lang);
          if (!m) {
            return (
              <div
                key={lang}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 10px",
                  border: "1px solid var(--border-soft)",
                  borderRadius: 8,
                  marginBottom: 6,
                  opacity: 0.5,
                  fontSize: 12.5,
                }}
              >
                <div style={{ flex: 1 }}>{LANG_LABEL_KEY[lang]}</div>
                <div>{t("modelNotAvailable")}</div>
              </div>
            );
          }
          return <Row key={m.id} m={m} />;
        })}

        <div
          style={{
            marginTop: 8,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
          }}
        >
          <div style={{ fontSize: 12.5, marginBottom: 8 }}>{t("ttsBackendLabel")}</div>
          <select
            value={ttsBackend}
            onChange={(e) => {
              const next = e.target.value as TtsBackend;
              setTtsBackend(next);
              saveTtsBackend(next);
            }}
            style={{ width: "100%" }}
          >
            <option value="local">{t("ttsBackendLocal")}</option>
            <option value="elevenlabs">{t("ttsBackendElevenLabs")}</option>
          </select>
          {ttsBackend === "elevenlabs" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
              <label style={{ fontSize: 11, opacity: 0.7 }}>
                API key
                <input
                  dir="ltr"
                  type="password"
                  style={{ width: "100%", marginTop: 3 }}
                  value={elevenApiKey}
                  onChange={(e) => {
                    setElevenApiKey(e.target.value);
                    saveElevenLabsApiKey(e.target.value);
                  }}
                />
              </label>
              <label style={{ fontSize: 11, opacity: 0.7 }}>
                Voice ID
                <input
                  dir="ltr"
                  style={{ width: "100%", marginTop: 3 }}
                  value={elevenVoiceId}
                  onChange={(e) => {
                    setElevenVoiceId(e.target.value);
                    saveElevenLabsVoiceId(e.target.value);
                  }}
                />
              </label>
              <div>
                <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 3 }}>{t("elevenModelLabel")}</div>
                <div style={{ display: "flex", gap: 6 }}>
                  <select
                    value={elevenModel}
                    onChange={(e) => {
                      setElevenModel(e.target.value);
                      saveElevenLabsModel(e.target.value);
                    }}
                    style={{ flex: 1 }}
                  >
                    {!elevenModels.some((m) => m.model_id === elevenModel) && (
                      <option value={elevenModel}>{elevenModel}</option>
                    )}
                    {elevenModels.map((m) => (
                      <option key={m.model_id} value={m.model_id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <button className="ghost" disabled={fetchingElevenModels || !elevenApiKey} onClick={fetchModelsFromElevenLabs}>
                    <RefreshCw size={13} className={fetchingElevenModels ? "typing" : undefined} /> {t("fetchModels")}
                  </button>
                </div>
                {elevenModelsErr && (
                  <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>{elevenModelsErr}</div>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="panel-header" style={{ padding: "4px 0", marginTop: 12 }}>
          {t("llmSectionTitle")}
        </div>
        <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 6 }}>{t("localRuntimeAutoNote")}</div>
        {runtimeProgress && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "8px 10px",
              border: "1px solid var(--border-soft)",
              borderRadius: 8,
              marginBottom: 6,
              opacity: 0.75,
            }}
          >
            <div style={{ flex: 1, minWidth: 0, fontSize: 13 }}>llama-server runtime</div>
            <div style={{ width: 120 }}>
              <div style={{ height: 5, borderRadius: 3, background: "var(--bg-3)", overflow: "hidden" }}>
                <div
                  style={{
                    width: runtimeProgress.total
                      ? `${Math.min(100, (runtimeProgress.downloaded / runtimeProgress.total) * 100)}%`
                      : "3%",
                    height: "100%",
                    background: "var(--accent)",
                  }}
                />
              </div>
              <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2 }} dir="ltr">
                {formatBytes(runtimeProgress.downloaded)} / {runtimeProgress.total ? formatBytes(runtimeProgress.total) : "…"}
              </div>
            </div>
          </div>
        )}
        {llmModels.map((m) => (
          <div key={m.id}>
            <Row m={m} />
            {m.installed && <LocalCtxControl modelId={m.id} />}
          </div>
        ))}

        <div style={{ fontSize: 11.5, opacity: 0.6, marginTop: 14 }}>
          {t("modelDiskUsage")}: {formatBytes(totalDisk)}
        </div>

        <div className="panel-header" style={{ padding: "4px 0", marginTop: 16 }}>
          {t("localFeaturesTitle")}
        </div>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
          }}
        >
          <input
            type="checkbox"
            checked={suggestionsEnabled}
            onChange={(e) => {
              setSuggestionsEnabledState(e.target.checked);
              setSuggestionsEnabled(e.target.checked);
            }}
          />
          <div>
            <div>{t("suggestionsLabel")}</div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{t("suggestionsHelp")}</div>
          </div>
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            fontSize: 12.5,
            padding: 10,
            border: "1px solid var(--border-soft)",
            borderRadius: 10,
            marginTop: 8,
          }}
        >
          <input
            type="checkbox"
            checked={dictationCleanupEnabled}
            onChange={(e) => {
              setDictationCleanupEnabledState(e.target.checked);
              setDictationCleanupEnabled(e.target.checked);
            }}
          />
          <div>
            <div>{t("dictationCleanupLabel")}</div>
            <div style={{ fontSize: 11, opacity: 0.65, marginTop: 2 }}>{t("dictationCleanupHelp")}</div>
          </div>
        </label>

        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <button onClick={onClose}>{t("cancel")}</button>
        </div>
      </div>
    </div>
  );
}
