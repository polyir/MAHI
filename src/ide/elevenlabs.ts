// ElevenLabs TTS backend — a plain HTTPS call from the frontend (no native
// Rust engine needed, unlike the local sherpa-onnx voices in tts.rs). Reuses
// the existing write_file_binary command to land the returned audio on disk,
// the same pattern ChatPanel.tsx already uses for mic recordings.
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { loadElevenLabsApiKey, loadElevenLabsModel, loadElevenLabsVoiceId } from "./models";

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function saveAudioResponse(resp: Response, workspace: string, outPath: string): Promise<void> {
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs error ${resp.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`);
  }
  const buf = await resp.arrayBuffer();
  if (!buf.byteLength) throw new Error("ElevenLabs returned an empty audio file");
  await invoke("write_file_binary", { workspace, path: outPath, base64Content: toBase64(buf) });
}

export type ElevenLabsModel = { model_id: string; name: string };

/// Lists the TTS-capable models available to this API key (e.g.
/// eleven_multilingual_v2 for quality, eleven_turbo_v2_5/eleven_flash_v2_5
/// for speed and lower cost) — lets the picker in ModelsModal.tsx show real,
/// current options instead of a hand-maintained guess. Throws on failure;
/// the caller decides how to surface that (this is a manual "Fetch" button,
/// not something called on every render).
export async function fetchElevenLabsModels(): Promise<ElevenLabsModel[]> {
  const apiKey = loadElevenLabsApiKey();
  if (!apiKey) throw new Error("ElevenLabs API key not configured");
  const resp = await tauriFetch("https://api.elevenlabs.io/v1/models", {
    headers: { "xi-api-key": apiKey },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs error ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data: any[] = await resp.json();
  return data
    .filter((m) => m?.model_id && m.can_do_text_to_speech !== false)
    .map((m) => ({ model_id: m.model_id as string, name: (m.name as string) || m.model_id }));
}

/// Synthesizes `text` via the ElevenLabs API, writes the result (mp3) to
/// `workspace/outPath` for persistence, and returns the raw bytes as a Blob
/// for immediate in-app playback. Throws with a readable message on any
/// failure — the caller (Message.tsx's speak(), agent.ts's speak_text tool)
/// is expected to catch this exactly like it already catches
/// synthesize_speech's errors.
//
// Playback deliberately does NOT go through convertFileSrc's asset://
// protocol here: Tauri determines that protocol's Content-Type via
// content-sniffing (the `infer` crate), which reliably detects WAV's
// unambiguous RIFF/WAVE header but can miss MP3 (no universal magic bytes),
// serving it with no/wrong Content-Type — WebKit's <audio> then refuses to
// play a file that's otherwise perfectly valid (confirmed with ffprobe). A
// Blob URL built directly from these bytes carries an explicit MIME type
// and sidesteps that sniffing entirely.
export async function synthesizeElevenLabs(workspace: string, text: string, outPath: string): Promise<Blob> {
  const apiKey = loadElevenLabsApiKey();
  const voiceId = loadElevenLabsVoiceId();
  if (!apiKey || !voiceId) {
    throw new Error("ElevenLabs API key or voice ID not configured — open Settings → Local AI Models");
  }
  const resp = await tauriFetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({ text, model_id: loadElevenLabsModel() }),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs error ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const buf = await resp.arrayBuffer();
  await invoke("write_file_binary", { workspace, path: outPath, base64Content: toBase64(buf) });
  return new Blob([buf], { type: "audio/mpeg" });
}

export async function generateElevenLabsMusic(workspace: string, args: {
  prompt: string; path: string; duration_seconds?: number; model_id?: string; instrumental?: boolean;
}, signal?: AbortSignal): Promise<void> {
  const apiKey = loadElevenLabsApiKey();
  if (!apiKey) throw new Error("ElevenLabs API key not configured — open Settings → Local AI Models");
  const prompt = String(args.prompt ?? "").trim();
  if (!prompt || prompt.length > 4100) throw new Error("Music prompt must contain 1–4100 characters");
  const duration = args.duration_seconds == null ? 30 : Number(args.duration_seconds);
  if (!Number.isFinite(duration) || duration < 3 || duration > 600) throw new Error("Music duration must be between 3 and 600 seconds");
  const modelId = args.model_id === "music_v1" ? "music_v1" : "music_v2";
  const resp = await tauriFetch("https://api.elevenlabs.io/v1/music?output_format=auto", {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({
      prompt,
      music_length_ms: Math.round(duration * 1000),
      model_id: modelId,
      force_instrumental: !!args.instrumental,
    }),
    signal,
  });
  await saveAudioResponse(resp, workspace, args.path);
}

export async function generateElevenLabsSoundEffect(workspace: string, args: {
  text: string; path: string; duration_seconds?: number; prompt_influence?: number; loop?: boolean;
}, signal?: AbortSignal): Promise<void> {
  const apiKey = loadElevenLabsApiKey();
  if (!apiKey) throw new Error("ElevenLabs API key not configured — open Settings → Local AI Models");
  const text = String(args.text ?? "").trim();
  if (!text) throw new Error("Sound-effect description is required");
  const duration = args.duration_seconds == null ? undefined : Number(args.duration_seconds);
  if (duration != null && (!Number.isFinite(duration) || duration < 0.5 || duration > 30)) {
    throw new Error("Sound-effect duration must be between 0.5 and 30 seconds");
  }
  const influence = args.prompt_influence == null ? 0.3 : Number(args.prompt_influence);
  if (!Number.isFinite(influence) || influence < 0 || influence > 1) throw new Error("Prompt influence must be between 0 and 1");
  const resp = await tauriFetch("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
    method: "POST",
    headers: { "Content-Type": "application/json", "xi-api-key": apiKey },
    body: JSON.stringify({
      text,
      model_id: "eleven_text_to_sound_v2",
      duration_seconds: duration,
      prompt_influence: influence,
      loop: !!args.loop,
    }),
    signal,
  });
  await saveAudioResponse(resp, workspace, args.path);
}

// ElevenLabs's only speech-to-text model as of this writing — unlike the
// TTS models (fetched live in ModelsModal.tsx), there's nothing to pick
// between yet, so this is hardcoded rather than another stored preference.
const ELEVENLABS_ASR_MODEL = "scribe_v1";

/// Transcribes a raw mic recording via ElevenLabs's speech-to-text API —
/// the cloud sibling of asr.rs's local Whisper path (see ChatPanel.tsx's
/// finishRecording, which picks between the two based on
/// isElevenLabsAsrEnabled). Takes the recorded Blob directly (no need for
/// ffmpeg normalization first — the API accepts common browser recording
/// formats like webm/opus as-is). `language_code` is deliberately omitted
/// so the API auto-detects the spoken language, same reasoning as the local
/// Whisper path.
export async function transcribeElevenLabs(audio: Blob): Promise<{ text: string; languageCode: string | null }> {
  const apiKey = loadElevenLabsApiKey();
  if (!apiKey) throw new Error("ElevenLabs API key not configured — open Settings → Local AI Models");
  const form = new FormData();
  form.append("model_id", ELEVENLABS_ASR_MODEL);
  form.append("file", audio, "audio");
  const resp = await tauriFetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": apiKey },
    body: form,
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`ElevenLabs error ${resp.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const data: any = await resp.json();
  return { text: (data?.text as string) ?? "", languageCode: (data?.language_code as string) ?? null };
}
