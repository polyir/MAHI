import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { Volume2 } from "lucide-react";
import { Msg } from "../agent";
import ToolCallView from "./ToolCallView";
import CodeBlock from "./CodeBlock";
import { t, getLang } from "../ide/i18n";
import { loadTtsBackend, loadVoiceForLang } from "../ide/models";
import { absolutePath } from "../ide/fileKind";
import { ttsNormalize } from "../ide/localLlm";
import { synthesizeElevenLabs } from "../ide/elevenlabs";

export default function Message({
  msg,
  workspace,
  getScreenshot,
}: {
  msg: Msg;
  workspace: string;
  getScreenshot?: (toolCallId?: string) => string | undefined;
}) {
  const [speaking, setSpeaking] = useState(false);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [speakError, setSpeakError] = useState<string | null>(null);

  async function speak() {
    if (speaking) return;
    const backend = loadTtsBackend();
    // ElevenLabs uses its own single configured voice, not a per-language
    // one, so the "no voice installed" pre-check only applies to local.
    const voiceId = loadVoiceForLang(getLang());
    if (backend === "local" && !voiceId) {
      setSpeakError(t("noTtsVoice"));
      return;
    }
    setSpeaking(true);
    setSpeakError(null);
    // A previous ElevenLabs playback's blob: URL is never needed again once
    // we're about to replace it — release it so the underlying data isn't
    // held onto for the rest of the session.
    if (audioSrc?.startsWith("blob:")) URL.revokeObjectURL(audioSrc);
    try {
      // Best-effort: reads far more naturally aloud with markdown/URLs/code
      // stripped and numbers spelled out. Silently falls back to the raw
      // text on any failure (no local model, timeout, text too long).
      const spoken = (await ttsNormalize(msg.content, getLang())) ?? msg.content;
      const outPath = `.mahi-speech/${Date.now()}.${backend === "elevenlabs" ? "mp3" : "wav"}`;
      if (backend === "elevenlabs") {
        // Played from an in-memory Blob rather than convertFileSrc's
        // asset:// protocol: Tauri picks that protocol's Content-Type via
        // content-sniffing, which reliably recognizes WAV's unambiguous
        // RIFF/WAVE header but can miss MP3 (no universal magic bytes),
        // serving it with no/wrong Content-Type — WebKit's <audio> then
        // refuses to play a file that's otherwise perfectly valid. The
        // Blob's explicit MIME type sidesteps that entirely. The file is
        // still written to disk by synthesizeElevenLabs for persistence.
        const blob = await synthesizeElevenLabs(workspace, spoken, outPath);
        setAudioSrc(URL.createObjectURL(blob));
      } else {
        await invoke("synthesize_speech", { workspace, text: spoken, voiceId, outPath });
        setAudioSrc(convertFileSrc(absolutePath(workspace, outPath)));
      }
    } catch (e) {
      setSpeakError(String(e));
    } finally {
      setSpeaking(false);
    }
  }
  if (msg.role === "tool") {
    return <ToolCallView msg={msg} workspace={workspace} screenshot={getScreenshot?.(msg.tool_call_id)} />;
  }

  if (msg.role === "user") {
    return (
      <div className="msg msg-user" dir="auto">
        {msg.images && msg.images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 6 }}>
            {msg.images.map((img, i) => (
              <img
                key={i}
                src={img}
                alt="pasted"
                style={{ maxWidth: 160, maxHeight: 160, borderRadius: 8, display: "block" }}
              />
            ))}
          </div>
        )}
        {msg.content.split("\n\n[Attached file:")[0]}
        {msg.content.includes("[Attached file:") && (
          <div style={{ fontSize: 11, opacity: 0.75, marginTop: 4 }}>{t("withAttachment")}</div>
        )}
      </div>
    );
  }

  // assistant
  if (!msg.content && msg.tool_calls?.length) return null; // tool-only step; cards follow

  return (
    <div className="msg msg-assistant" dir="auto">
      <div className="markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            code: ({ className, children }) => <CodeBlock className={className}>{children}</CodeBlock>,
          }}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
      <div style={{ marginTop: 4 }}>
        <button className="ghost" onClick={speak} disabled={speaking} title={t("speakButton")} style={{ padding: "2px 6px" }}>
          <Volume2 size={12} className={speaking ? "typing" : undefined} />
        </button>
      </div>
      {speakError && <div style={{ fontSize: 11, color: "var(--red)", marginTop: 4 }}>{speakError}</div>}
      {audioSrc && (
        <audio
          key={audioSrc}
          controls
          autoPlay
          src={audioSrc}
          style={{ width: "100%", marginTop: 4, height: 32 }}
        />
      )}
    </div>
  );
}
