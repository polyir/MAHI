// Single entry point for every local-LLM-backed utility feature (prompt
// improvement, TTS text normalization, next-message suggestions, chat
// titles, dictation cleanup, attachment/history summarization). Every
// function here returns `null` on ANY failure (model not installed, timeout,
// malformed output) — null is the universal "fall back to today's behavior"
// signal; callers never need their own try/catch for this.
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { ModelStatus } from "./models";
import { canonicalProviderId, LOCAL_PROVIDER_ID } from "./providers";

export const QWEN_1_7B = "qwen3-1.7b";
export const QWEN_4B = "qwen3-4b";
export const LLAMA_RUNTIME = "llama-server";

// Per-model context-length override (Settings → Local AI Models), capped to
// the same range llm.rs enforces server-side (defense in depth — this is a
// value that ends up in a spawned process's CLI args). Falls back to these
// defaults, which must stay in sync with llm.rs's ctx_for.
const LOCAL_CTX_KEY_PREFIX = "mahi_local_ctx_";
export const MIN_LOCAL_CTX = 2048;
export const MAX_LOCAL_CTX = 32768;
const CTX_DEFAULTS: Record<string, number> = { [QWEN_4B]: 12_288, [QWEN_1_7B]: 8_192 };
const CTX_HEADROOM = 1_800;

export function loadLocalCtxOverride(modelId: string): number | null {
  const raw = localStorage.getItem(`${LOCAL_CTX_KEY_PREFIX}${modelId}`);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.min(MAX_LOCAL_CTX, Math.max(MIN_LOCAL_CTX, n)) : null;
}
export function saveLocalCtxOverride(modelId: string, ctx: number): void {
  localStorage.setItem(`${LOCAL_CTX_KEY_PREFIX}${modelId}`, String(Math.min(MAX_LOCAL_CTX, Math.max(MIN_LOCAL_CTX, ctx))));
}
export function localCtxDefault(modelId: string): number {
  return CTX_DEFAULTS[modelId] ?? MIN_LOCAL_CTX;
}

// Effective ctx (override or default) minus generation headroom — used as
// the contextBudget for local chat turns (see ChatPanel's runTurn), since a
// local model's real window is far smaller than a cloud contextBudget
// default.
export function localPromptBudget(modelId: string): number {
  const ctx = loadLocalCtxOverride(modelId) ?? localCtxDefault(modelId);
  return Math.max(512, ctx - CTX_HEADROOM);
}

const SUGGESTIONS_KEY = "mahi_suggestions_enabled";

// Off by default: a background inference call after every single reply has
// a real battery/thermal cost on a fanless laptop.
export function isSuggestionsEnabled(): boolean {
  return localStorage.getItem(SUGGESTIONS_KEY) === "1";
}
export function setSuggestionsEnabled(v: boolean): void {
  localStorage.setItem(SUGGESTIONS_KEY, v ? "1" : "0");
}

const DICTATION_CLEANUP_KEY = "mahi_dictation_cleanup_enabled";

// Off by default, same reasoning as isSuggestionsEnabled: an extra
// inference call on every dictation has a real cost.
export function isDictationCleanupEnabled(): boolean {
  return localStorage.getItem(DICTATION_CLEANUP_KEY) === "1";
}
export function setDictationCleanupEnabled(v: boolean): void {
  localStorage.setItem(DICTATION_CLEANUP_KEY, v ? "1" : "0");
}

// Which provider/model rewrites the prompt when the Wand2 button (next to
// Send) is clicked — independent of the main chat provider/model, and
// independent of the task-wrapper functions below (which are always
// local-only). Defaults to the local 4B model, preserving the original
// hardcoded behavior for anyone who never opens the picker in Settings →
// Providers.
const IMPROVE_PROVIDER_KEY = "mahi_improve_provider_id";
const IMPROVE_MODEL_KEY = "mahi_improve_model";

export function loadImproveProviderId(): string {
  return canonicalProviderId(localStorage.getItem(IMPROVE_PROVIDER_KEY) ?? LOCAL_PROVIDER_ID);
}
export function saveImproveProviderId(id: string): void {
  localStorage.setItem(IMPROVE_PROVIDER_KEY, id);
}
export function loadImproveModel(): string {
  return localStorage.getItem(IMPROVE_MODEL_KEY) ?? QWEN_4B;
}
export function saveImproveModel(model: string): void {
  localStorage.setItem(IMPROVE_MODEL_KEY, model);
}

// Which provider/model cleans up the Whisper transcript when dictation
// cleanup is on (see isDictationCleanupEnabled above) — independent of the
// main chat provider/model and of the prompt-improve picker above. Defaults
// to the local 1.7B model, preserving the original hardcoded behavior for
// anyone who never opens the picker in Settings → Providers.
const DICTATION_PROVIDER_KEY = "mahi_dictation_provider_id";
const DICTATION_MODEL_KEY = "mahi_dictation_model";

export function loadDictationProviderId(): string {
  return canonicalProviderId(localStorage.getItem(DICTATION_PROVIDER_KEY) ?? LOCAL_PROVIDER_ID);
}
export function saveDictationProviderId(id: string): void {
  localStorage.setItem(DICTATION_PROVIDER_KEY, id);
}
export function loadDictationModel(): string {
  return localStorage.getItem(DICTATION_MODEL_KEY) ?? QWEN_1_7B;
}
export function saveDictationModel(model: string): void {
  localStorage.setItem(DICTATION_MODEL_KEY, model);
}

let installedCache: { at: number; ids: Set<string> } | null = null;

async function installedIds(): Promise<Set<string>> {
  if (installedCache && Date.now() - installedCache.at < 10_000) return installedCache.ids;
  try {
    const statuses = await invoke<ModelStatus[]>("model_list_status");
    const ids = new Set(statuses.filter((s) => s.installed).map((s) => s.id));
    installedCache = { at: Date.now(), ids };
    return ids;
  } catch {
    return new Set();
  }
}

export async function localInstalled(modelId: string): Promise<boolean> {
  const ids = await installedIds();
  return ids.has(modelId) && ids.has(LLAMA_RUNTIME);
}

// Serializes utility calls so two features never race to cold-spawn the same
// (or different) llama-server at once — Rust's own mutex keeps this
// correct either way, this is purely to avoid janky simultaneous cold starts.
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function localCompleteInner(opts: {
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
}): Promise<string | null> {
  if (!(await localInstalled(opts.modelId))) return null;
  try {
    const baseURL = await invoke<string>("local_llm_ensure", { modelId: opts.modelId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const resp = await tauriFetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: opts.modelId,
          stream: false,
          messages: [
            { role: "system", content: opts.system },
            { role: "user", content: `${opts.user}\n/no_think` },
          ],
          max_tokens: opts.maxTokens,
          temperature: opts.temperature ?? 0.2,
        }),
      });
      if (!resp.ok) return null;
      const data: any = await resp.json();
      const text: string | undefined = data?.choices?.[0]?.message?.content;
      if (!text) return null;
      return stripThinking(text);
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export function localComplete(opts: {
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  temperature?: number;
}): Promise<string | null> {
  return serialize(() => localCompleteInner(opts));
}

// Multi-turn sibling of localComplete — used by Prompt Lab, which needs to
// keep iterating on a draft across several back-and-forth messages rather
// than one fixed system+user pair. Kept separate instead of extending
// localComplete's signature since every existing caller (improvePrompt,
// ttsNormalize, suggestReplies, chatTitle, cleanDictation, summarize*) is
// genuinely single-turn and would gain nothing from a messages array.
async function localCompleteMultiInner(opts: {
  modelId: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
  timeoutMs: number;
}): Promise<string | null> {
  if (!(await localInstalled(opts.modelId))) return null;
  try {
    const baseURL = await invoke<string>("local_llm_ensure", { modelId: opts.modelId });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      // Same /no_think suffix as localCompleteInner — without it, Qwen3's
      // thinking mode burns most (or all) of maxTokens on a hidden <think>
      // block, and if that block never closes before the cap, stripThinking
      // has nothing to strip and the raw in-progress reasoning comes back
      // as the "reply" (looked like a rambling, question-less response).
      const lastIdx = opts.messages.length - 1;
      const messages =
        lastIdx >= 0 && opts.messages[lastIdx].role === "user"
          ? opts.messages.map((m, i) => (i === lastIdx ? { ...m, content: `${m.content}\n/no_think` } : m))
          : opts.messages;
      const resp = await tauriFetch(`${baseURL}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: opts.modelId,
          stream: false,
          messages,
          max_tokens: opts.maxTokens,
        }),
      });
      if (!resp.ok) return null;
      const data: any = await resp.json();
      const text: string | undefined = data?.choices?.[0]?.message?.content;
      return text ? stripThinking(text) : null;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }
}

export function localCompleteMulti(opts: {
  modelId: string;
  messages: { role: string; content: string }[];
  maxTokens: number;
  timeoutMs: number;
}): Promise<string | null> {
  return serialize(() => localCompleteMultiInner(opts));
}

// ---- task wrappers ----

// Shared with ChatPanel.tsx's cloud-provider improve path (see
// improveWithCloudProvider) so the rewrite behaves identically regardless of
// which provider/model the user picks in Settings → Providers.
export function improvePromptSystem(lang: string): string {
  return `Rewrite the user's draft message into a clearer, more effective prompt for a coding-agent chat. Keep it in the same language (${lang}). Preserve every concrete detail (file paths, names, numbers) verbatim. Output ONLY the improved prompt text, no preamble, no quotes, no explanation.`;
}

export async function improvePrompt(draft: string, lang: string, modelId = QWEN_4B): Promise<string | null> {
  const result = await localComplete({
    modelId,
    system: improvePromptSystem(lang),
    user: draft.slice(0, 4000),
    maxTokens: 700,
    timeoutMs: 30_000,
  });
  return result?.trim() || null;
}

export async function ttsNormalize(text: string, lang: string): Promise<string | null> {
  if (text.length > 3000) return null; // caller speaks the raw text instead
  const result = await localComplete({
    modelId: QWEN_1_7B,
    system: `Rewrite the text so it sounds natural when read aloud in ${lang}: spell out numbers/dates/units as words, remove markdown formatting/URLs, and replace code blocks with a short spoken note like "code omitted". Keep the meaning. Output ONLY the speakable text.`,
    user: text,
    maxTokens: 1000,
    timeoutMs: 20_000,
  });
  return result?.trim() || null;
}

export async function suggestReplies(lastUser: string, lastAssistant: string): Promise<string[] | null> {
  const result = await localComplete({
    modelId: QWEN_1_7B,
    system:
      'Given the last exchange in a chat, propose exactly 3 short, natural follow-up messages the user might send next, in the same language as the conversation. Each under 60 characters. Output ONLY a JSON array of exactly 3 strings, nothing else — e.g. ["...", "...", "..."]',
    user: `User: ${lastUser.slice(0, 500)}\n\nAssistant: ${lastAssistant.slice(0, 2500)}`,
    maxTokens: 120,
    timeoutMs: 15_000,
  });
  if (!result) return null;
  try {
    const cleaned = result.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length === 3 && parsed.every((x) => typeof x === "string")) {
      return parsed as string[];
    }
    return null;
  } catch {
    return null;
  }
}

export async function chatTitle(firstUser: string, firstAssistant: string): Promise<string | null> {
  const result = await localComplete({
    modelId: QWEN_1_7B,
    system: "Write a short title (max 6 words) for this conversation, in its own language. Output ONLY the title, no quotes, no punctuation at the end.",
    user: `User: ${firstUser.slice(0, 800)}\n\nAssistant: ${firstAssistant.slice(0, 800)}`,
    maxTokens: 24,
    timeoutMs: 10_000,
  });
  const title = result?.trim().replace(/^["']|["']$/g, "");
  return title || null;
}

// Language codes this app uses (see i18n.ts) mapped to plain English names
// for the prompt below — models tend to treat a spelled-out language name
// as a stronger instruction than a bare code like "ru".
const DICTATION_LANG_NAMES: Record<string, string> = {
  fa: "Persian (Farsi)",
  en: "English",
  ru: "Russian",
  ja: "Japanese",
  zh: "Chinese",
  tr: "Turkish",
};

// Shared with ChatPanel.tsx's cloud-provider dictation-cleanup path (see
// cleanDictationWithCloudProvider) so the correction behaves identically
// regardless of which provider/model the user picks in Settings → Providers.
// Explicitly calls out the script/alphabet: without this, Qwen3-4B in
// particular would occasionally substitute Cyrillic (Russian) characters
// into otherwise-correct Persian or English output — a reported bug.
export function dictationCleanupSystem(lang: string): string {
  const langName = DICTATION_LANG_NAMES[lang] ?? lang;
  return `Fix punctuation, casing, and obvious misheard words in this ${langName} speech-to-text transcript. The entire transcript is in ${langName} — output must use ONLY ${langName}'s own script/alphabet, exactly matching the input. Never substitute words or characters from any other language or alphabet (for example, no Cyrillic/Russian characters in a Persian or English transcript). Do not change the meaning or add/remove content. Output ONLY the corrected transcript.`;
}

export async function cleanDictation(text: string, lang: string, modelId = QWEN_1_7B): Promise<string | null> {
  if (text.length > 2000) return null;
  const result = await localComplete({
    modelId,
    system: dictationCleanupSystem(lang),
    user: text,
    maxTokens: Math.max(200, Math.round(text.length * 1.3)),
    timeoutMs: 12_000,
  });
  return result?.trim() || null;
}

export async function summarizeAttachment(path: string, content: string): Promise<string | null> {
  const chunks: string[] = [];
  for (let i = 0; i < content.length && chunks.length < 5; i += 6000) {
    chunks.push(content.slice(i, i + 6000));
  }
  let summary = "";
  for (const chunk of chunks) {
    const result = await localComplete({
      modelId: QWEN_1_7B,
      system: `Summarize this chunk of the file "${path}" in at most 300 words: its purpose, key definitions/exports, and any notable details. This may be a partial chunk of a larger file.${
        summary ? " Continue from the previous summary provided." : ""
      } Output ONLY the summary.`,
      user: summary ? `Previous summary:\n${summary}\n\nNext chunk:\n${chunk}` : chunk,
      maxTokens: 500,
      timeoutMs: 25_000,
    });
    if (!result) return null;
    summary = result.trim();
  }
  return summary || null;
}

export async function summarizeHistory(serializedTurns: string, prevSummary?: string): Promise<string | null> {
  const chunks: string[] = [];
  for (let i = 0; i < serializedTurns.length; i += 6000) {
    chunks.push(serializedTurns.slice(i, i + 6000));
  }
  let summary = prevSummary ?? "";
  for (const chunk of chunks) {
    const result = await localComplete({
      modelId: QWEN_1_7B,
      system:
        "Summarize this part of an ongoing coding-agent conversation in at most 350 words: decisions made, files touched, current state, and open TODOs. Keep the conversation's own language. Build on the previous summary if given rather than restarting. Output ONLY the summary.",
      user: summary ? `Previous summary:\n${summary}\n\nNext part of conversation:\n${chunk}` : chunk,
      maxTokens: 550,
      timeoutMs: 30_000,
    });
    if (!result) return null;
    summary = result.trim();
  }
  return summary || null;
}
