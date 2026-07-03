// Multi-provider support: any OpenAI-compatible endpoint can be added and
// used side by side (each chat turn uses whatever provider is selected at
// send time). API keys stay in localStorage on this machine only.

export type Provider = {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  models: string[];
  // URL of the provider's own usage/billing console, opened in the in-app
  // browser window (host must be in the Rust-side allowlist).
  consoleURL?: string;
};

const PROVIDERS_KEY = "mahi_providers";
const ACTIVE_PROVIDER_KEY = "mahi_active_provider";

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
    },
    {
      id: "zai",
      name: "Z.AI (GLM)",
      baseURL: "https://api.z.ai/api/paas/v4",
      apiKey: "",
      models: ["glm-4.7", "glm-4.7-air", "glm-4.6"],
      consoleURL: "https://z.ai",
    },
  ];
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
