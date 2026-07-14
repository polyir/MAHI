import { useState } from "react";
import { Check, Info, Plus, Play, Send, Sparkles, Wand2 } from "lucide-react";
import { t, dir as uiDir, useLang, getLang } from "./i18n";
import type { StrKey } from "./i18n";
import { useModalOpen } from "./modalTracker";
import type { Provider } from "./providers";
import { LOCAL_PROVIDER_ID } from "./providers";
import { improvePromptSystem, loadImproveModel, loadImproveProviderId, localCompleteMulti } from "./localLlm";
import { loadSavedPrompts, saveSavedPrompts } from "./promptLab";
import type { SavedPrompt } from "./promptLab";
import { FINAL_PROMPT_END, FINAL_PROMPT_START, PROMPT_TEMPLATES } from "./templates";
import { providerComplete } from "../agent";

type LabMsg = { role: "system" | "user" | "assistant"; content: string };
type Version = { id: string; label: string; content: string };

// Template names/descriptions are user-facing i18n entries keyed by the
// template's id (see i18n.ts's template_<id>_name/_desc), while PROMPT_TEMPLATES
// itself only carries the LLM-facing system prompt — this bridges the two.
function templateName(id: string): string {
  return t(`template_${id}_name` as StrKey);
}
function templateDesc(id: string): string {
  return t(`template_${id}_desc` as StrKey);
}
function templateInfo(id: string): string {
  return t(`template_${id}_info` as StrKey);
}

// A throwaway conversation for iterating on a prompt, entirely separate
// from the main chat's session/history — messages live only in this
// component's own state and are discarded the moment it unmounts. Nothing
// here is sent to the main conversation; only the "insert" button transfers
// the final textarea content into it, via onInsert. The version history
// below is the same story (resets on reopen) — only the saved-prompts
// library (promptLab.ts) is persisted across sessions.
export default function PromptLabModal({
  initialText,
  providers,
  onClose,
  onInsert,
}: {
  initialText: string;
  providers: Provider[];
  onClose: () => void;
  onInsert: (text: string) => void;
}) {
  useLang();
  useModalOpen(true);
  const [draft, setDraft] = useState(initialText);
  const [messages, setMessages] = useState<LabMsg[]>([
    { role: "system", content: improvePromptSystem(getLang()) },
  ]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const [versions, setVersions] = useState<Version[]>(() => [
    { id: "v0", label: t("promptLabInitialVersion"), content: initialText },
  ]);
  const [activeVersionId, setActiveVersionId] = useState("v0");

  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>(loadSavedPrompts);
  const [savingName, setSavingName] = useState<string | null>(null);

  const [tab, setTab] = useState<"edit" | "template" | "test">("edit");
  const [testReply, setTestReply] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);

  const [templateId, setTemplateId] = useState(PROMPT_TEMPLATES[0].id);
  const [templateMessages, setTemplateMessages] = useState<LabMsg[]>([]);
  const [templateAnswer, setTemplateAnswer] = useState("");
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateStarted, setTemplateStarted] = useState(false);
  const [templateDone, setTemplateDone] = useState(false);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [showTemplateInfo, setShowTemplateInfo] = useState(false);

  const improveProviderId = loadImproveProviderId();
  const improveModel = loadImproveModel();
  const improveProviderName =
    improveProviderId === LOCAL_PROVIDER_ID
      ? providers.find((p) => p.id === LOCAL_PROVIDER_ID)?.name ?? "Local"
      : providers.find((p) => p.id === improveProviderId)?.name ?? improveProviderId;

  async function cloudMulti(p: Provider, model: string, msgs: LabMsg[]): Promise<string | null> {
    try {
      return await providerComplete(p, model || p.models[0], msgs, { maxTokens: 1200, temperature: 0.3 });
    } catch {
      return null;
    }
  }

  async function runMulti(msgs: LabMsg[], maxTokens: number, timeoutMs: number): Promise<string | null> {
    const providerId = loadImproveProviderId();
    const model = loadImproveModel();
    if (providerId === LOCAL_PROVIDER_ID) {
      return localCompleteMulti({ modelId: model, messages: msgs, maxTokens, timeoutMs });
    }
    const provider = providers.find((p) => p.id === providerId);
    return provider ? cloudMulti(provider, model, msgs) : null;
  }

  async function iterate() {
    if (!instruction.trim() || busy) return;
    setBusy(true);
    const userMsg: LabMsg = { role: "user", content: `Current draft:\n${draft}\n\nInstruction: ${instruction}` };
    const nextMessages = [...messages, userMsg];
    try {
      const reply = await runMulti(nextMessages, 1200, 45_000);
      if (reply) {
        setMessages([...nextMessages, { role: "assistant", content: reply }]);
        setDraft(reply);
        const id = `v${Date.now()}`;
        setVersions((cur) => [...cur, { id, label: instruction.trim(), content: reply }]);
        setActiveVersionId(id);
        setInstruction("");
      }
    } finally {
      setBusy(false);
    }
  }

  function revertToVersion(v: Version) {
    setDraft(v.content);
    setActiveVersionId(v.id);
  }

  function startSaving() {
    setSavingName("");
  }

  function confirmSave() {
    if (!savingName?.trim()) return;
    const entry: SavedPrompt = { id: `p${Date.now()}`, name: savingName.trim(), content: draft, createdAt: Date.now() };
    const next = [entry, ...savedPrompts];
    setSavedPrompts(next);
    saveSavedPrompts(next);
    setSavingName(null);
  }

  function loadSaved(p: SavedPrompt) {
    setDraft(p.content);
    const id = `v${Date.now()}`;
    setVersions((cur) => [...cur, { id, label: `${t("promptLabLoadedFrom")}: ${p.name}`, content: p.content }]);
    setActiveVersionId(id);
  }

  function deleteSaved(id: string) {
    const next = savedPrompts.filter((p) => p.id !== id);
    setSavedPrompts(next);
    saveSavedPrompts(next);
  }

  async function runTest() {
    if (!draft.trim() || testBusy) return;
    setTestBusy(true);
    setTestError(null);
    setTestReply(null);
    try {
      const reply = await runMulti([{ role: "user", content: draft }], 1200, 45_000);
      if (reply) setTestReply(reply);
      else setTestError(t("promptLabTestFailed"));
    } catch (e) {
      setTestError(String(e));
    } finally {
      setTestBusy(false);
    }
  }

  async function runTemplateTurn(nextMessages: LabMsg[]) {
    setTemplateBusy(true);
    setTemplateError(null);
    try {
      const reply = await runMulti(nextMessages, 2500, 60_000);
      if (!reply) {
        setTemplateError(t("promptLabTemplateFailed"));
        return;
      }
      setTemplateMessages([...nextMessages, { role: "assistant", content: reply }]);
      const start = reply.indexOf(FINAL_PROMPT_START);
      const end = reply.indexOf(FINAL_PROMPT_END);
      if (start !== -1 && end !== -1 && end > start) {
        const finalText = reply.slice(start + FINAL_PROMPT_START.length, end).trim();
        setDraft(finalText);
        const id = `v${Date.now()}`;
        const tpl = PROMPT_TEMPLATES.find((tp) => tp.id === templateId);
        setVersions((cur) => [
          ...cur,
          { id, label: `${t("promptLabTemplateVersionLabel")}: ${templateName(tpl?.id ?? templateId)}`, content: finalText },
        ]);
        setActiveVersionId(id);
        setTemplateDone(true);
      }
    } finally {
      setTemplateBusy(false);
    }
  }

  function startTemplate() {
    if (!draft.trim() || templateBusy) return;
    const tpl = PROMPT_TEMPLATES.find((tp) => tp.id === templateId)!;
    const initial: LabMsg[] = [
      { role: "system", content: tpl.systemPrompt },
      { role: "user", content: draft },
    ];
    setTemplateStarted(true);
    setTemplateDone(false);
    runTemplateTurn(initial);
  }

  function sendTemplateAnswer() {
    if (!templateAnswer.trim() || templateBusy) return;
    const userMsg: LabMsg = { role: "user", content: templateAnswer };
    runTemplateTurn([...templateMessages, userMsg]);
    setTemplateAnswer("");
  }

  function resetTemplate() {
    setTemplateMessages([]);
    setTemplateAnswer("");
    setTemplateStarted(false);
    setTemplateDone(false);
    setTemplateError(null);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        dir={uiDir()}
        style={{ width: 920, maxHeight: "85vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("promptLabTitle")}</h3>
        <div style={{ fontSize: 11.5, opacity: 0.65, marginBottom: 8 }}>
          {t("promptLabModelLabel")}: {improveProviderName} · {improveModel}
        </div>

        <div style={{ display: "flex", gap: 14 }}>
          <div
            style={{
              width: 210,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              paddingInlineEnd: 10,
              borderInlineEnd: "1px solid var(--border-soft)",
            }}
          >
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7, marginBottom: 6 }}>
                {t("promptLabVersionsTitle")}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 180, overflowY: "auto" }}>
                {versions
                  .slice()
                  .reverse()
                  .map((v) => (
                    <div
                      key={v.id}
                      className="tree-node"
                      onClick={() => revertToVersion(v)}
                      title={v.content}
                      style={{
                        background: v.id === activeVersionId ? "var(--accent-soft)" : undefined,
                        whiteSpace: "normal",
                        lineHeight: 1.4,
                        display: "block",
                      }}
                    >
                      <span
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                        }}
                      >
                        {v.label}
                      </span>
                    </div>
                  ))}
              </div>
            </div>

            <div>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <div style={{ fontSize: 11, fontWeight: 600, opacity: 0.7 }}>{t("promptLabSavedTitle")}</div>
                <button className="ghost" style={{ padding: 2 }} title={t("promptLabSaveCurrent")} onClick={startSaving}>
                  <Plus size={13} />
                </button>
              </div>
              {savingName !== null && (
                <div style={{ display: "flex", gap: 4, marginBottom: 6 }}>
                  <input
                    autoFocus
                    dir="auto"
                    value={savingName}
                    onChange={(e) => setSavingName(e.target.value)}
                    placeholder={t("name")}
                    style={{ flex: 1, fontSize: 11.5, minWidth: 0 }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmSave();
                      if (e.key === "Escape") setSavingName(null);
                    }}
                  />
                  <button className="ghost" style={{ padding: "2px 6px" }} onClick={confirmSave}>
                    <Check size={12} />
                  </button>
                </div>
              )}
              {savedPrompts.length === 0 && savingName === null && (
                <div style={{ fontSize: 11, opacity: 0.5 }}>{t("promptLabNoSaved")}</div>
              )}
              <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 180, overflowY: "auto" }}>
                {savedPrompts.map((p) => (
                  <div key={p.id} className="tree-node" style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span
                      onClick={() => loadSaved(p)}
                      title={p.content}
                      style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", cursor: "pointer" }}
                    >
                      {p.name}
                    </span>
                    <span
                      onClick={() => deleteSaved(p.id)}
                      style={{ opacity: 0.6, cursor: "pointer", flexShrink: 0 }}
                    >
                      ✕
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <button className={tab === "edit" ? "primary" : "ghost"} onClick={() => setTab("edit")}>
                {t("promptLabEditTab")}
              </button>
              <button className={tab === "template" ? "primary" : "ghost"} onClick={() => setTab("template")}>
                {t("promptLabTemplateTab")}
              </button>
              <button className={tab === "test" ? "primary" : "ghost"} onClick={() => setTab("test")}>
                {t("promptLabTestTab")}
              </button>
            </div>

            {tab === "edit" ? (
              <>
                <textarea
                  rows={15}
                  dir="auto"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={t("promptLabPlaceholder")}
                  style={{ width: "100%", fontFamily: "inherit" }}
                />
                <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                  <input
                    dir="auto"
                    style={{ flex: 1 }}
                    value={instruction}
                    onChange={(e) => setInstruction(e.target.value)}
                    placeholder={t("promptLabInstructionPlaceholder")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") iterate();
                    }}
                  />
                  <button className="ghost" disabled={busy || !instruction.trim()} onClick={iterate}>
                    <Wand2 size={14} className={busy ? "typing" : undefined} />
                  </button>
                </div>
              </>
            ) : tab === "template" ? (
              <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {!templateStarted ? (
                  <>
                    <div style={{ fontSize: 11.5, opacity: 0.6 }}>{t("promptLabTemplateNote")}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <select
                        value={templateId}
                        onChange={(e) => setTemplateId(e.target.value)}
                        style={{ fontSize: 12.5, flex: 1 }}
                      >
                        {PROMPT_TEMPLATES.map((tpl) => (
                          <option key={tpl.id} value={tpl.id}>
                            {templateName(tpl.id)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="ghost"
                        style={{ padding: 4, color: showTemplateInfo ? "var(--accent)" : undefined }}
                        title={t("promptLabTemplateInfoTitle")}
                        onClick={() => setShowTemplateInfo((v) => !v)}
                      >
                        <Info size={15} />
                      </button>
                    </div>
                    <div style={{ fontSize: 11, opacity: 0.55 }}>{templateDesc(templateId)}</div>
                    {showTemplateInfo && (
                      <div
                        dir="auto"
                        style={{
                          fontSize: 12,
                          lineHeight: 1.8,
                          whiteSpace: "pre-wrap",
                          background: "var(--bg-2)",
                          border: "1px solid var(--border-soft)",
                          borderRadius: 8,
                          padding: 10,
                          maxHeight: 220,
                          overflowY: "auto",
                        }}
                      >
                        {templateInfo(templateId)}
                      </div>
                    )}
                    <textarea
                      rows={9}
                      dir="auto"
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      placeholder={t("promptLabPlaceholder")}
                      style={{ width: "100%", fontFamily: "inherit" }}
                    />
                    <button
                      className="primary"
                      disabled={!draft.trim() || templateBusy}
                      onClick={startTemplate}
                      style={{ alignSelf: "flex-start" }}
                    >
                      <Sparkles size={13} className={templateBusy ? "typing" : undefined} /> {t("promptLabTemplateStart")}
                    </button>
                  </>
                ) : (
                  <>
                    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                      {templateMessages
                        .filter((m) => m.role !== "system")
                        .map((m, i) => (
                          <div
                            key={i}
                            dir="auto"
                            style={{
                              fontSize: 12.5,
                              padding: "6px 8px",
                              borderRadius: 6,
                              whiteSpace: "pre-wrap",
                              background: m.role === "user" ? "var(--accent-soft)" : "var(--bg-2)",
                              alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                              maxWidth: "85%",
                            }}
                          >
                            {templateDone && m.role === "assistant" && i === templateMessages.filter((x) => x.role !== "system").length - 1
                              ? t("promptLabTemplateReady")
                              : m.content}
                          </div>
                        ))}
                      {templateBusy && <div style={{ fontSize: 11.5, opacity: 0.6 }}>{t("promptLabTemplateThinking")}</div>}
                    </div>
                    {templateError && <div style={{ color: "var(--red)", fontSize: 11.5 }}>{templateError}</div>}
                    {!templateDone &&
                      !templateBusy &&
                      !templateError &&
                      templateMessages.length > 0 &&
                      templateMessages[templateMessages.length - 1].role === "assistant" && (
                        <div style={{ display: "flex", gap: 6 }}>
                          <input
                            dir="auto"
                            autoFocus
                            style={{ flex: 1 }}
                            value={templateAnswer}
                            onChange={(e) => setTemplateAnswer(e.target.value)}
                            placeholder={t("promptLabTemplateAnswerPlaceholder")}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") sendTemplateAnswer();
                            }}
                          />
                          <button className="ghost" disabled={templateBusy || !templateAnswer.trim()} onClick={sendTemplateAnswer}>
                            <Send size={14} />
                          </button>
                        </div>
                      )}
                    <button className="ghost" style={{ alignSelf: "flex-start" }} onClick={resetTemplate}>
                      {t("promptLabTemplateRestart")}
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 11.5, opacity: 0.6 }}>{t("promptLabTestNote")}</div>
                <div
                  dir="auto"
                  style={{
                    padding: 8,
                    border: "1px solid var(--border-soft)",
                    borderRadius: 8,
                    fontSize: 12.5,
                    whiteSpace: "pre-wrap",
                    maxHeight: 140,
                    overflowY: "auto",
                  }}
                >
                  {draft || <em style={{ opacity: 0.5 }}>{t("promptLabPlaceholder")}</em>}
                </div>
                <button
                  className="ghost"
                  disabled={testBusy || !draft.trim()}
                  onClick={runTest}
                  style={{ alignSelf: "flex-start" }}
                >
                  <Play size={13} className={testBusy ? "typing" : undefined} /> {t("promptLabRunTest")}
                </button>
                {testError && <div style={{ color: "var(--red)", fontSize: 11.5 }}>{testError}</div>}
                {testReply && (
                  <div
                    dir="auto"
                    style={{
                      flex: 1,
                      overflowY: "auto",
                      padding: 8,
                      border: "1px solid var(--border-soft)",
                      borderRadius: 8,
                      fontSize: 12.5,
                      whiteSpace: "pre-wrap",
                      minHeight: 120,
                    }}
                  >
                    {testReply}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
          <button onClick={onClose}>{t("cancel")}</button>
          <button
            className="primary"
            onClick={() => {
              onInsert(draft);
              onClose();
            }}
          >
            <Check size={14} /> {t("promptLabInsert")}
          </button>
        </div>
      </div>
    </div>
  );
}
