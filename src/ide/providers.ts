// Multi-provider support: any OpenAI-compatible endpoint can be added and
// used side by side (each chat turn uses whatever provider is selected at
// send time). API keys stay in localStorage on this machine only.

export type ProviderRole = "chat" | "image" | "audio" | "video";
export const PROVIDER_ROLES: ProviderRole[] = ["chat", "image", "audio", "video"];
export type ProviderProtocol = "auto" | "chat-completions" | "openai-responses" | "gemini-chat" | "custom-json";
export type ImageProtocol = "auto" | "openai-images" | "gemini-interactions";

export type MediaKind = "image" | "audio" | "video";
export type MediaResponseConfig = {
  mode: "binary" | "json";
  base64Paths?: string[];
  urlPaths?: string[];
};

export type MediaJobConfig = {
  idPath: string;
  statusEndpoint: string;
  statusPath: string;
  successValues: string[];
  failureValues: string[];
  pollIntervalMs?: number;
  maxPolls?: number;
  resultIdPaths?: string[];
  resultEndpoint?: string;
  resultResponse?: MediaResponseConfig;
};

export type MediaAdapterConfig = {
  protocol: string;
  endpoint: string;
  method?: "POST";
  model: string;
  models?: string[];
  authHeader?: string;
  authScheme?: string;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
  response: MediaResponseConfig;
  job?: MediaJobConfig;
  source?: "builtin" | "assistant" | "custom";
  docsURL?: string;
  verifiedAt?: string;
};

export type CustomAdapterConfig = {
  endpointPath: string;
  streamMode: "sse" | "json";
  authHeader: string;
  authScheme: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  modelPath: string;
  messagesPath: string;
  toolsPath: string;
  streamPath: string;
  temperaturePath: string;
  maxTokensPath: string;
  reasoningPath: string;
  responseTextPath: string;
  streamTextPath: string;
  toolCallsPath: string;
  usagePath: string;
  errorPath: string;
};

export type ReasoningParameter = "reasoning_effort" | "responses_reasoning" | "thinking" | "budget_tokens";

export type ModelReasoningConfig = {
  parameter: ReasoningParameter;
  options: Array<{ label: string; value: string }>;
  defaultValue: string;
};

// Known-good presets. A provider's saved modelReasoning entry wins over
// these; an explicit null disables a preset for that model.
const BUILTIN_MODEL_REASONING: Record<string, Record<string, ModelReasoningConfig>> = {
  sakana: {
    fugu: {
      parameter: "reasoning_effort",
      options: ["high", "xhigh", "max"].map((value) => ({ label: value, value })),
      defaultValue: "high",
    },
    "fugu-ultra": {
      parameter: "reasoning_effort",
      options: ["high", "xhigh", "max"].map((value) => ({ label: value, value })),
      defaultValue: "max",
    },
  },
  zai: {
    "glm-5.2": {
      parameter: "reasoning_effort",
      options: ["none", "high", "max"].map((value) => ({ label: value, value })),
      defaultValue: "none",
    },
  },
};

export const OPENAI_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5-pro"];
export const GEMINI_MODELS = ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite"];

function reasoningOptions(values: string[], defaultValue: string, parameter: ReasoningParameter): ModelReasoningConfig {
  return { parameter, options: values.map((value) => ({ label: value, value })), defaultValue };
}

export function providerProtocol(provider?: Provider): Exclude<ProviderProtocol, "auto"> {
  if (provider?.protocol && provider.protocol !== "auto") return provider.protocol;
  const url = provider?.baseURL.toLowerCase() ?? "";
  if (url.includes("generativelanguage.googleapis.com")) return "gemini-chat";
  if (url.includes("api.openai.com")) return "openai-responses";
  return "chat-completions";
}

export function providerImageProtocol(provider?: Provider): Exclude<ImageProtocol, "auto"> {
  if (provider?.imageProtocol && provider.imageProtocol !== "auto") return provider.imageProtocol;
  if (provider?.id === "gemini" || provider?.baseURL.toLowerCase().includes("generativelanguage.googleapis.com")) return "gemini-interactions";
  return "openai-images";
}

function inferredReasoningConfig(provider: Provider, model: string): ModelReasoningConfig | undefined {
  const protocol = providerProtocol(provider);
  if (protocol === "openai-responses") {
    if (/^gpt-5\.5-pro(?:-|$)/.test(model)) return reasoningOptions(["medium", "high", "xhigh"], "high", "responses_reasoning");
    if (/^gpt-5\.[4-9]/.test(model)) {
      return reasoningOptions(["none", "low", "medium", "high", "xhigh", "max"], "medium", "responses_reasoning");
    }
  }
  if (protocol === "gemini-chat") {
    if (model.startsWith("gemini-3.1-pro")) return reasoningOptions(["low", "medium", "high"], "high", "reasoning_effort");
    if (model.startsWith("gemini-3.1-flash-lite")) return reasoningOptions(["minimal", "low", "medium", "high"], "minimal", "reasoning_effort");
    if (model.startsWith("gemini-3")) return reasoningOptions(["minimal", "low", "medium", "high"], "medium", "reasoning_effort");
  }
  return undefined;
}

export type Provider = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  protocol?: ProviderProtocol;
  // URL of the provider's own usage/billing console, opened in the in-app
  // browser window (host must be in the Rust-side allowlist).
  consoleURL?: string;
  // Which jobs this provider is allowed to handle when role routing is on.
  // Missing/undefined means ["chat"] (older saved providers predate roles).
  roles?: ProviderRole[];
  imageModel?: string;
  imageModels?: string[];
  imageProtocol?: ImageProtocol;
  audioModel?: string;
  videoModel?: string;
  // Per-modality overrides generated by Adapter Studio. Built-in providers
  // fall back to the official registry in mediaAdapters.ts, so older saved
  // provider records continue to work without migration.
  mediaAdapters?: Partial<Record<MediaKind, MediaAdapterConfig>>;
  // Whether this provider's chat endpoint accepts image content in
  // messages (OpenAI-style image_url parts). Undefined means true (most
  // OpenAI-compatible chat endpoints do) — set false for providers whose
  // configured models reject it outright (confirmed for Z.AI/GLM: sending
  // image content 400s with "messages.content.type is invalid, allowed
  // values: ['text']"). When false, pasted/attached images are saved to a
  // temp file and referenced by path in plain text instead (see agent.ts),
  // so a vision-capable MCP tool can still be used on them.
  supportsVision?: boolean;
  // Per-model override. Missing uses a built-in preset when one exists;
  // null explicitly marks reasoning as unsupported/disabled.
  modelReasoning?: Record<string, ModelReasoningConfig | null>;
  customAdapter?: CustomAdapterConfig;
};

export type ProviderPreset = Omit<Provider, "apiKey"> & { mark: string; accent: string };

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "sakana", name: "Sakana Fugu", mark: "魚", accent: "#f2b84b", baseURL: "https://api.sakana.ai/v1", models: ["fugu", "fugu-ultra"], consoleURL: "https://console.sakana.ai/billing", roles: ["chat"] },
  { id: "zai", name: "Z.AI", mark: "Z", accent: "#6d7cff", baseURL: "https://api.z.ai/api/paas/v4", models: ["glm-4.7", "glm-4.7-air", "glm-4.6"], consoleURL: "https://z.ai", roles: ["chat"], supportsVision: false },
  { id: "openai", name: "OpenAI", mark: "◎", accent: "#10a37f", baseURL: "https://api.openai.com/v1", models: OPENAI_MODELS, roles: ["chat", "image"], protocol: "openai-responses", imageProtocol: "openai-images", imageModel: "gpt-image-2", imageModels: ["gpt-image-2"] },
  { id: "gemini", name: "Gemini", mark: "✦", accent: "#4f8cff", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", models: GEMINI_MODELS, roles: ["chat", "image"], protocol: "gemini-chat", imageProtocol: "gemini-interactions", imageModel: "gemini-3.1-flash-image", imageModels: ["gemini-3.1-flash-image", "gemini-3-pro-image"] },
  { id: "minimax", name: "MiniMax", mark: "M", accent: "#ff5c7a", baseURL: "https://api.minimax.io/v1", models: ["MiniMax-M2.7", "MiniMax-M2.7-highspeed", "MiniMax-M2.5"], roles: ["chat"], protocol: "chat-completions" },
  { id: "deepseek", name: "DeepSeek", mark: "D", accent: "#4d6bfe", baseURL: "https://api.deepseek.com", models: ["deepseek-v4-pro", "deepseek-v4-flash"], roles: ["chat"], protocol: "chat-completions" },
  { id: "qwen", name: "Qwen", mark: "Q", accent: "#7b61ff", baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", models: ["qwen3.7-max", "qwen3.7-plus", "qwen3.6-flash"], roles: ["chat"], protocol: "chat-completions" },
  { id: "openrouter", name: "OpenRouter", mark: "OR", accent: "#8b5cf6", baseURL: "https://openrouter.ai/api/v1", models: ["~openai/gpt-latest"], roles: ["chat"], protocol: "chat-completions" },
  { id: "groq", name: "Groq", mark: "G", accent: "#f55036", baseURL: "https://api.groq.com/openai/v1", models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "llama-3.1-8b-instant"], roles: ["chat"], protocol: "chat-completions" },
  { id: "nvidia", name: "NVIDIA NIM", mark: "N", accent: "#76b900", baseURL: "https://integrate.api.nvidia.com/v1", models: ["deepseek-ai/deepseek-v4-pro", "openai/gpt-oss-120b", "qwen/qwen3.5-122b-a10b"], roles: ["chat"], protocol: "chat-completions" },
];

export function newCustomAdapter(): CustomAdapterConfig {
  return {
    endpointPath: "/chat/completions", streamMode: "sse", authHeader: "Authorization", authScheme: "Bearer",
    headers: {}, body: {}, modelPath: "model", messagesPath: "messages", toolsPath: "tools",
    streamPath: "stream", temperaturePath: "temperature", maxTokensPath: "max_tokens", reasoningPath: "reasoning_effort",
    responseTextPath: "choices.0.message.content", streamTextPath: "choices.0.delta.content",
    toolCallsPath: "choices.0.delta.tool_calls", usagePath: "usage", errorPath: "error.message",
  };
}

export function modelReasoningConfig(provider: Provider | undefined, model: string): ModelReasoningConfig | undefined {
  if (!provider) return undefined;
  if (provider.modelReasoning && Object.prototype.hasOwnProperty.call(provider.modelReasoning, model)) {
    return provider.modelReasoning[model] ?? undefined;
  }
  return BUILTIN_MODEL_REASONING[provider.id]?.[model] ?? inferredReasoningConfig(provider, model);
}

const PROVIDERS_KEY = "mahi_providers";
const ACTIVE_PROVIDER_KEY = "mahi_active_provider";
const ROLE_ROUTING_KEY = "mahi_role_routing_enabled";
const BROWSER_TOOLS_KEY = "mahi_browser_tools_enabled";

export function defaultProviders(): Provider[] {
  return PROVIDER_PRESETS.map(({ mark: _mark, accent: _accent, ...preset }) => ({
    ...preset,
    apiKey: preset.id === "sakana" ? localStorage.getItem("sakana_key") ?? "" : "",
  }));
}

// Off by default: most providers don't support image/audio/speech
// generation, so routing only kicks in once the user explicitly assigns
// roles to a provider and turns this on in Settings → Providers.
export function isRoleRoutingEnabled(): boolean {
  return localStorage.getItem(ROLE_ROUTING_KEY) === "1";
}

export function setRoleRoutingEnabled(v: boolean): void {
  localStorage.setItem(ROLE_ROUTING_KEY, v ? "1" : "0");
}

// Off by default: lets the agent open/navigate/close embedded browser tabs
// and take whole-window screenshots. Sensitive actions (navigate/close)
// still require per-call approval regardless of this flag.
export function isBrowserToolsEnabled(): boolean {
  return localStorage.getItem(BROWSER_TOOLS_KEY) === "1";
}

export function setBrowserToolsEnabled(v: boolean): void {
  localStorage.setItem(BROWSER_TOOLS_KEY, v ? "1" : "0");
}

/// Find the provider assigned to `role`, falling back to `fallback` (the
/// currently active chat provider) when routing is off, no provider has that
/// role, or the matching provider has no API key configured yet. This keeps
/// the media tools always "attemptable" rather than hard-blocked.
export function findProviderForRole(
  providers: Provider[],
  role: ProviderRole,
  fallback: Provider,
  supports?: (provider: Provider) => boolean
): Provider {
  if (!isRoleRoutingEnabled()) return fallback;
  const match = providers.find((p) => (p.roles ?? ["chat"]).includes(role) && p.apiKey && (!supports || supports(p)));
  return match ?? fallback;
}

// A built-in, virtual provider for the local Qwen3 models (served by a
// spawned llama-server sidecar — see src-tauri/src/llm.rs) — NEVER persisted
// to localStorage (see withLocalProvider below for why). "models" lists the
// registry ids directly (identity mapping with the model <select>, same
// convention as "glm-4.7" etc. for cloud providers). apiKey is a non-empty
// dummy: ChatPanel's send() blocks on `!provider.apiKey`, and llama-server
// ignores the Authorization header entirely, so any non-empty string works.
export const LOCAL_PROVIDER_ID = "local";

export function localProvider(): Provider {
  return {
    id: LOCAL_PROVIDER_ID,
    name: "Local (Qwen3)",
    baseURL: "http://127.0.0.1",
    apiKey: "local",
    models: ["qwen3-4b", "qwen3-1.7b"],
    roles: ["chat"],
    supportsVision: false,
  };
}

/// Ensures exactly one, canonical copy of the local provider is present —
/// drops any stale persisted copy (e.g. from an older localStorage snapshot)
/// and appends the current one. Called on every load, which is itself the
/// migration path for users who already had a saved provider list before
/// this feature existed.
export function withLocalProvider(list: Provider[]): Provider[] {
  return [...list.filter((p) => p.id !== LOCAL_PROVIDER_ID), localProvider()];
}

// Migration for provider lists saved before supportsVision existed: the
// built-in "zai" entry predates it, so an old localStorage snapshot has it
// missing (undefined), which the gating check in agent.ts reads as "true" —
// silently re-breaking the exact bug this field exists to prevent. Force it
// explicitly for that one known-id rather than relying on the field being
// present in whatever was persisted.
function migrateVisionFlag(list: Provider[]): Provider[] {
  return list.map((p) => (p.id === "zai" && p.supportsVision === undefined ? { ...p, supportsVision: false } : p));
}

function canonicalizeKnownProviders(list: Provider[]): Provider[] {
  const out: Provider[] = [];
  for (const provider of list) {
    const url = provider.baseURL.toLowerCase();
    const isOpenAI = provider.protocol !== "custom-json" && url.includes("api.openai.com");
    const isGemini = provider.protocol !== "custom-json" && url.includes("generativelanguage.googleapis.com");
    const canonical = isOpenAI
      ? { ...provider, id: "openai", name: "OpenAI (GPT)", baseURL: "https://api.openai.com/v1", models: OPENAI_MODELS, protocol: "openai-responses" as const, roles: provider.imageModel || provider.imageProtocol ? (provider.roles ?? ["chat"]) : Array.from(new Set([...(provider.roles ?? ["chat"]), "image" as const])), imageProtocol: "openai-images" as const, imageModel: provider.imageModel || "gpt-image-2", imageModels: ["gpt-image-2"] }
      : isGemini
        ? { ...provider, id: "gemini", name: "Google Gemini", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", models: GEMINI_MODELS, protocol: "gemini-chat" as const, roles: provider.imageModel || provider.imageProtocol ? (provider.roles ?? ["chat"]) : Array.from(new Set([...(provider.roles ?? ["chat"]), "image" as const])), imageProtocol: "gemini-interactions" as const, imageModel: provider.imageModel || "gemini-3.1-flash-image", imageModels: ["gemini-3.1-flash-image", "gemini-3-pro-image"] }
        : provider;
    const existing = out.findIndex((p) => p.id === canonical.id);
    if (existing >= 0) {
      if (canonical.apiKey) out[existing] = { ...out[existing], ...canonical };
    } else {
      out.push(canonical);
    }
  }
  for (const builtin of defaultProviders()) {
    if (!out.some((p) => p.id === builtin.id)) out.push(builtin);
  }
  return out;
}

export function loadProviders(): Provider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return withLocalProvider(defaultProviders());
    const parsed: Provider[] = JSON.parse(raw);
    return withLocalProvider(canonicalizeKnownProviders(migrateVisionFlag(parsed.length ? parsed : defaultProviders())));
  } catch {
    return withLocalProvider(defaultProviders());
  }
}

/// The local provider is virtual — it must never be written to
/// localStorage. Besides being pointless (it's derived fresh every load),
/// ProvidersModal's own save filter drops any provider whose baseURL isn't
/// "https://", which would silently corrupt it anyway if it were persisted.
export function saveProviders(providers: Provider[]) {
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers.filter((p) => p.id !== LOCAL_PROVIDER_ID)));
}

export function canonicalProviderId(id: string): string {
  try {
    const saved: Provider[] = JSON.parse(localStorage.getItem(PROVIDERS_KEY) ?? "[]");
    const provider = saved.find((p) => p.id === id);
    if (provider?.baseURL.toLowerCase().includes("api.openai.com")) return "openai";
    if (provider?.baseURL.toLowerCase().includes("generativelanguage.googleapis.com")) return "gemini";
  } catch {
    // Keep the stored id when old provider JSON is malformed.
  }
  return id;
}

export function loadActiveProviderId(): string {
  return canonicalProviderId(localStorage.getItem(ACTIVE_PROVIDER_KEY) ?? "sakana");
}

export function saveActiveProviderId(id: string) {
  localStorage.setItem(ACTIVE_PROVIDER_KEY, id);
}
