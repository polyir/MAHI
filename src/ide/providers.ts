// Multi-provider support: any OpenAI-compatible endpoint can be added and
// used side by side (each chat turn uses whatever provider is selected at
// send time). API keys stay in localStorage on this machine only.

export type ProviderRole = "chat" | "image" | "audio" | "video";
export const PROVIDER_ROLES: ProviderRole[] = ["chat", "image", "audio", "video"];

export type Provider = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  // URL of the provider's own usage/billing console, opened in the in-app
  // browser window (host must be in the Rust-side allowlist).
  consoleURL?: string;
  // Which jobs this provider is allowed to handle when role routing is on.
  // Missing/undefined means ["chat"] (older saved providers predate roles).
  roles?: ProviderRole[];
  imageModel?: string;
  audioModel?: string;
  videoModel?: string;
};

const PROVIDERS_KEY = "mahi_providers";
const ACTIVE_PROVIDER_KEY = "mahi_active_provider";
const ROLE_ROUTING_KEY = "mahi_role_routing_enabled";
const BROWSER_TOOLS_KEY = "mahi_browser_tools_enabled";

export function defaultProviders(): Provider[] {
  return [
    {
      id: "sakana",
      name: "Sakana Fugu",
      baseURL: "https://api.sakana.ai/v1",
      // migrate the key stored by earlier single-provider builds
      apiKey: localStorage.getItem("sakana_key") ?? "",
      models: ["fugu", "fugu-ultra"],
      consoleURL: "https://console.sakana.ai/billing",
      roles: ["chat"],
    },
    {
      id: "zai",
      name: "Z.AI (GLM)",
      baseURL: "https://api.z.ai/api/paas/v4",
      apiKey: "",
      models: ["glm-4.7", "glm-4.7-air", "glm-4.6"],
      consoleURL: "https://z.ai",
      roles: ["chat"],
    },
  ];
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
export function findProviderForRole(providers: Provider[], role: ProviderRole, fallback: Provider): Provider {
  if (!isRoleRoutingEnabled()) return fallback;
  const match = providers.find((p) => (p.roles ?? ["chat"]).includes(role) && p.apiKey);
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

export function loadProviders(): Provider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return withLocalProvider(defaultProviders());
    const parsed: Provider[] = JSON.parse(raw);
    return withLocalProvider(parsed.length ? parsed : defaultProviders());
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

export function loadActiveProviderId(): string {
  return localStorage.getItem(ACTIVE_PROVIDER_KEY) ?? "sakana";
}

export function saveActiveProviderId(id: string) {
  localStorage.setItem(ACTIVE_PROVIDER_KEY, id);
}
