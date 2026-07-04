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

/// Find the provider assigned to `role`, falling back to `fallback` (the
/// currently active chat provider) when routing is off, no provider has that
/// role, or the matching provider has no API key configured yet. This keeps
/// the media tools always "attemptable" rather than hard-blocked.
export function findProviderForRole(providers: Provider[], role: ProviderRole, fallback: Provider): Provider {
  if (!isRoleRoutingEnabled()) return fallback;
  const match = providers.find((p) => (p.roles ?? ["chat"]).includes(role) && p.apiKey);
  return match ?? fallback;
}

export function loadProviders(): Provider[] {
  try {
    const raw = localStorage.getItem(PROVIDERS_KEY);
    if (!raw) return defaultProviders();
    const parsed: Provider[] = JSON.parse(raw);
    return parsed.length ? parsed : defaultProviders();
  } catch {
    return defaultProviders();
  }
}

export function saveProviders(providers: Provider[]) {
  localStorage.setItem(PROVIDERS_KEY, JSON.stringify(providers));
}

export function loadActiveProviderId(): string {
  return localStorage.getItem(ACTIVE_PROVIDER_KEY) ?? "sakana";
}

export function saveActiveProviderId(id: string) {
  localStorage.setItem(ACTIVE_PROVIDER_KEY, id);
}
