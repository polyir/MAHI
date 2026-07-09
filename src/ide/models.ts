// Client-side helpers for the local AI models feature (ASR/TTS). Mirrors the
// localStorage-preference pattern in providers.ts — the actual "is this
// downloaded" truth lives on disk (see model_list_status in Rust); these are
// just small user preferences for which installed model/voice to use.

export type ModelKind = "asr" | "tts" | "llm";

export type ModelStatus = {
  id: string;
  kind: ModelKind;
  label: string;
  lang: string;
  size_bytes: number;
  installed: boolean;
  size_on_disk: number;
};

const ACTIVE_ASR_KEY = "mahi_active_asr_model";
const VOICE_PREFIX = "mahi_tts_voice_";

export function loadActiveAsrModel(): string | null {
  return localStorage.getItem(ACTIVE_ASR_KEY);
}

export function saveActiveAsrModel(id: string) {
  localStorage.setItem(ACTIVE_ASR_KEY, id);
}

export function loadVoiceForLang(lang: string): string | null {
  return localStorage.getItem(VOICE_PREFIX + lang);
}

export function saveVoiceForLang(lang: string, voiceId: string) {
  localStorage.setItem(VOICE_PREFIX + lang, voiceId);
}

// Which engine actually renders speech — applies globally to both the
// message "Speak" button and the agent's speak_text tool. "local" keeps
// using the on-device sherpa-onnx voices configured above; "elevenlabs"
// routes through the ElevenLabs API instead (see ./elevenlabs.ts).
export type TtsBackend = "local" | "elevenlabs";
const TTS_BACKEND_KEY = "mahi_tts_backend";
const ELEVENLABS_API_KEY_KEY = "mahi_elevenlabs_api_key";
const ELEVENLABS_VOICE_ID_KEY = "mahi_elevenlabs_voice_id";

export function loadTtsBackend(): TtsBackend {
  return localStorage.getItem(TTS_BACKEND_KEY) === "elevenlabs" ? "elevenlabs" : "local";
}

export function saveTtsBackend(backend: TtsBackend) {
  localStorage.setItem(TTS_BACKEND_KEY, backend);
}

export function loadElevenLabsApiKey(): string {
  return localStorage.getItem(ELEVENLABS_API_KEY_KEY) ?? "";
}

export function saveElevenLabsApiKey(key: string) {
  localStorage.setItem(ELEVENLABS_API_KEY_KEY, key);
}

export function loadElevenLabsVoiceId(): string {
  return localStorage.getItem(ELEVENLABS_VOICE_ID_KEY) ?? "";
}

export function saveElevenLabsVoiceId(voiceId: string) {
  localStorage.setItem(ELEVENLABS_VOICE_ID_KEY, voiceId);
}

// eleven_multilingual_v2 is ElevenLabs' highest-quality general-purpose
// model — kept as the default so anyone who never opens this picker gets
// the same behavior as before this setting existed. Faster/cheaper models
// (Turbo, Flash) or others are opt-in via Settings → Local AI Models.
const ELEVENLABS_MODEL_KEY = "mahi_elevenlabs_model";
const DEFAULT_ELEVENLABS_MODEL = "eleven_multilingual_v2";

export function loadElevenLabsModel(): string {
  return localStorage.getItem(ELEVENLABS_MODEL_KEY) ?? DEFAULT_ELEVENLABS_MODEL;
}

export function saveElevenLabsModel(model: string) {
  localStorage.setItem(ELEVENLABS_MODEL_KEY, model);
}

// Independent of TtsBackend above — whether dictation (mic → text) is
// transcribed via ElevenLabs's cloud speech-to-text API instead of the
// local Whisper model. Off by default: local Whisper works fully offline
// and needs no API key, so this stays opt-in.
const ELEVENLABS_ASR_ENABLED_KEY = "mahi_elevenlabs_asr_enabled";

export function isElevenLabsAsrEnabled(): boolean {
  return localStorage.getItem(ELEVENLABS_ASR_ENABLED_KEY) === "1";
}

export function setElevenLabsAsrEnabled(v: boolean): void {
  localStorage.setItem(ELEVENLABS_ASR_ENABLED_KEY, v ? "1" : "0");
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}
