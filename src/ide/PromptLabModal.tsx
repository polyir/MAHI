import { useState } from "react";
import { Check, Wand2 } from "lucide-react";
import { t, dir as uiDir, useLang, getLang } from "./i18n";
import type { Provider } from "./providers";
import { LOCAL_PROVIDER_ID } from "./providers";
import { improvePromptSystem, loadImproveModel, loadImproveProviderId, localCompleteMulti } from "./localLlm";
import { makeClient } from "../agent";

type LabMsg = { role: "system" | "user" | "assistant"; content: string };

// A throwaway conversation for iterating on a prompt, entirely separate
// from the main chat's session/history — messages live only in this
// component's own state and are discarded the moment it unmounts. Nothing
// here is sent to the main conversation; only the "insert" button transfers
// the final textarea content into it, via onInsert.
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
  const [draft, setDraft] = useState(initialText);
  const [messages, setMessages] = useState<LabMsg[]>([
    { role: "system", content: improvePromptSystem(getLang()) },
  ]);
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);

  const improveProviderId = loadImproveProviderId();
  const improveModel = loadImproveModel();
  const improveProviderName =
    improveProviderId === LOCAL_PROVIDER_ID
      ? providers.find((p) => p.id === LOCAL_PROVIDER_ID)?.name ?? "Local"
      : providers.find((p) => p.id === improveProviderId)?.name ?? improveProviderId;

  async function cloudMulti(p: Provider, model: string, msgs: LabMsg[]): Promise<string | null> {
    try {
      const client = makeClient(p.apiKey, p.baseURL);
      const resp = await client.chat.completions.create({
        model: model || p.models[0],
        messages: msgs,
        stream: false,
        max_tokens: 1200,
        temperature: 0.3,
      });
      return resp.choices[0]?.message?.content?.trim() || null;
    } catch {
      return null;
    }
  }

  async function iterate() {
    if (!instruction.trim() || busy) return;
    setBusy(true);
    const userMsg: LabMsg = { role: "user", content: `Current draft:\n${draft}\n\nInstruction: ${instruction}` };
    const nextMessages = [...messages, userMsg];
    try {
      const providerId = loadImproveProviderId();
      const model = loadImproveModel();
      const reply =
        providerId === LOCAL_PROVIDER_ID
          ? await localCompleteMulti({ modelId: model, messages: nextMessages, maxTokens: 1200, timeoutMs: 45_000 })
          : await (async () => {
              const provider = providers.find((p) => p.id === providerId);
              return provider ? cloudMulti(provider, model, nextMessages) : null;
            })();
      if (reply) {
        setMessages([...nextMessages, { role: "assistant", content: reply }]);
        setDraft(reply);
        setInstruction("");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        dir={uiDir()}
        style={{ width: 760, maxHeight: "85vh", overflowY: "auto" }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0 }}>{t("promptLabTitle")}</h3>
        <div style={{ fontSize: 11.5, opacity: 0.65, marginBottom: 8 }}>
          {t("promptLabModelLabel")}: {improveProviderName} · {improveModel}
        </div>
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
