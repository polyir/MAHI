import type { MediaAdapterConfig, MediaKind, Provider } from "./providers";

type PresetRegistry = Record<string, Partial<Record<MediaKind, MediaAdapterConfig>>>;

const json = (base64Paths: string[] = [], urlPaths: string[] = []) => ({
  mode: "json" as const,
  base64Paths,
  urlPaths,
});

const bearer = { authHeader: "Authorization", authScheme: "Bearer" };

// Official media surfaces. These are deliberately data, not branches in the
// agent: provider-specific request/response differences stay editable and an
// Adapter Studio import can override any one modality without replacing chat.
export const MEDIA_ADAPTER_PRESETS: PresetRegistry = {
  openai: {
    image: {
      protocol: "openai-images", endpoint: "/images/generations", model: "gpt-image-2", models: ["gpt-image-2"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", size: "{{size}}" },
      response: json(["data.0.b64_json"], ["data.0.url"]), source: "builtin",
      docsURL: "https://developers.openai.com/api/docs/guides/image-generation",
    },
    audio: {
      protocol: "openai-speech", endpoint: "/audio/speech", model: "gpt-4o-mini-tts", models: ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"], ...bearer,
      body: { model: "{{model}}", input: "{{text}}", voice: "{{voice}}", response_format: "{{format}}" },
      response: { mode: "binary" }, source: "builtin",
      docsURL: "https://developers.openai.com/api/docs/guides/text-to-speech",
    },
    video: {
      protocol: "openai-video", endpoint: "/videos", model: "sora-2", models: ["sora-2", "sora-2-pro"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", size: "{{size}}", seconds: "{{duration}}" },
      response: json(), source: "builtin", docsURL: "https://developers.openai.com/api/docs/guides/video-generation",
      job: { idPath: "id", statusEndpoint: "/videos/{{jobId}}", statusPath: "status", successValues: ["completed"], failureValues: ["failed", "cancelled"], resultEndpoint: "/videos/{{jobId}}/content", resultResponse: { mode: "binary" } },
    },
  },
  gemini: {
    image: {
      protocol: "gemini-interactions", endpoint: "https://generativelanguage.googleapis.com/v1beta/interactions", model: "gemini-3.1-flash-image", models: ["gemini-3.1-flash-image", "gemini-3-pro-image"],
      authHeader: "x-goog-api-key", authScheme: "", body: { model: "{{model}}", input: [{ type: "text", text: "{{prompt}}" }], response_format: { type: "image", mime_type: "image/png", aspect_ratio: "{{aspect_ratio}}", image_size: "{{image_size}}" } },
      response: json(["outputs.0.content.0.data", "output.0.content.0.data", "candidates.0.content.parts.0.inlineData.data"]), source: "builtin",
      docsURL: "https://ai.google.dev/gemini-api/docs/image-generation",
    },
    audio: {
      protocol: "gemini-tts", endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{{model}}:generateContent", model: "gemini-2.5-flash-preview-tts", models: ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"],
      authHeader: "x-goog-api-key", authScheme: "", body: { contents: [{ parts: [{ text: "{{text}}" }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "{{voice}}" } } } } },
      response: json(["candidates.0.content.parts.0.inlineData.data"]), source: "builtin",
      docsURL: "https://ai.google.dev/gemini-api/docs/speech-generation",
    },
    video: {
      protocol: "gemini-veo", endpoint: "https://generativelanguage.googleapis.com/v1beta/models/{{model}}:predictLongRunning", model: "veo-3.1-generate-preview", models: ["veo-3.1-generate-preview", "veo-3.1-fast-generate-preview"],
      authHeader: "x-goog-api-key", authScheme: "", body: { instances: [{ prompt: "{{prompt}}" }], parameters: { aspectRatio: "{{aspect_ratio}}", resolution: "{{resolution}}", durationSeconds: "{{duration}}" } },
      response: json(), source: "builtin", docsURL: "https://ai.google.dev/gemini-api/docs/video",
      job: { idPath: "name", statusEndpoint: "https://generativelanguage.googleapis.com/v1beta/{{jobId}}", statusPath: "done", successValues: ["true"], failureValues: ["failed", "cancelled"], resultResponse: json([], ["response.generateVideoResponse.generatedSamples.0.video.uri", "response.generatedVideos.0.video.uri"]) },
    },
  },
  zai: {
    image: {
      protocol: "zai-images", endpoint: "/images/generations", model: "glm-image", models: ["glm-image", "cogview-4-250304"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", size: "{{size}}", quality: "{{quality}}" }, response: json([], ["data.0.url"]), source: "builtin",
      docsURL: "https://docs.z.ai/api-reference/image/generate-image",
    },
    video: {
      protocol: "zai-video", endpoint: "/videos/generations", model: "cogvideox-3", models: ["cogvideox-3"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", quality: "{{quality}}", size: "{{size}}", with_audio: "{{with_audio}}" }, response: json(), source: "builtin",
      docsURL: "https://docs.z.ai/guides/video/cogvideox-3",
      job: { idPath: "id", statusEndpoint: "/async-result/{{jobId}}", statusPath: "task_status", successValues: ["SUCCESS"], failureValues: ["FAIL"], resultResponse: json([], ["video_result.0.url", "video_result.url"]) },
    },
  },
  minimax: {
    image: {
      protocol: "minimax-image", endpoint: "/image_generation", model: "image-01", models: ["image-01"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", aspect_ratio: "{{aspect_ratio}}", response_format: "base64" }, response: json(["data.image_base64.0"], ["data.image_urls.0"]), source: "builtin",
      docsURL: "https://platform.minimax.io/docs/api-reference/image-generation-t2i",
    },
    audio: {
      protocol: "minimax-speech", endpoint: "/t2a_v2", model: "speech-2.8-hd", models: ["speech-2.8-hd", "speech-2.8-turbo"], ...bearer,
      body: { model: "{{model}}", text: "{{text}}", voice_setting: { voice_id: "{{voice}}", speed: 1, vol: 1, pitch: 0 }, audio_setting: { format: "{{format}}", sample_rate: 32000, bitrate: 128000, channel: 1 } }, response: json(["data.audio"]), source: "builtin",
      docsURL: "https://platform.minimax.io/docs/api-reference/speech-t2a-http",
    },
    video: {
      protocol: "minimax-video", endpoint: "/video_generation", model: "MiniMax-Hailuo-2.3", models: ["MiniMax-Hailuo-2.3", "MiniMax-Hailuo-2.3-Fast", "MiniMax-Hailuo-02"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", duration: "{{duration}}", resolution: "{{resolution}}" }, response: json(), source: "builtin",
      docsURL: "https://platform.minimax.io/docs/guides/video-generation",
      job: { idPath: "task_id", statusEndpoint: "/query/video_generation?task_id={{jobId}}", statusPath: "status", successValues: ["Success"], failureValues: ["Fail"], resultIdPaths: ["file_id"], resultEndpoint: "/files/retrieve?file_id={{resultId}}", resultResponse: json([], ["file.download_url"]) },
    },
  },
  qwen: {
    image: {
      protocol: "dashscope-image", endpoint: "/images/generations", model: "qwen-image-2.0-pro", models: ["qwen-image-2.0-pro", "wan2.7-image-pro"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", size: "{{size}}" }, response: json(["data.0.b64_json"], ["data.0.url"]), source: "builtin",
      docsURL: "https://www.alibabacloud.com/help/en/model-studio/text-to-image-v2-api-reference",
    },
    audio: {
      protocol: "dashscope-speech", endpoint: "/audio/speech", model: "cosyvoice-v3.5-plus", models: ["cosyvoice-v3.5-plus"], ...bearer,
      body: { model: "{{model}}", input: "{{text}}", voice: "{{voice}}", response_format: "{{format}}" }, response: { mode: "binary" }, source: "builtin",
      docsURL: "https://www.alibabacloud.com/help/en/model-studio/cosyvoice-api",
    },
    video: {
      protocol: "dashscope-video", endpoint: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis", model: "wan2.7-t2v", models: ["wan2.7-t2v"], ...bearer,
      headers: { "X-DashScope-Async": "enable" }, body: { model: "{{model}}", input: { prompt: "{{prompt}}" }, parameters: { resolution: "{{resolution}}", duration: "{{duration}}", prompt_extend: true } }, response: json(), source: "builtin",
      docsURL: "https://www.alibabacloud.com/help/en/model-studio/text-to-video-api-reference",
      job: { idPath: "output.task_id", statusEndpoint: "https://dashscope-intl.aliyuncs.com/api/v1/tasks/{{jobId}}", statusPath: "output.task_status", successValues: ["SUCCEEDED"], failureValues: ["FAILED", "CANCELED"], resultResponse: json([], ["output.video_url"]) },
    },
  },
  openrouter: {
    image: {
      protocol: "openrouter-images", endpoint: "/images", model: "openai/gpt-image-1", models: ["openai/gpt-image-1", "google/gemini-3.1-flash-image-preview"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", size: "{{size}}", aspect_ratio: "{{aspect_ratio}}" }, response: json(["data.0.b64_json"], ["data.0.url"]), source: "builtin",
      docsURL: "https://openrouter.ai/docs/guides/overview/multimodal/image-generation",
    },
    audio: {
      protocol: "openrouter-speech", endpoint: "/audio/speech", model: "openai/gpt-4o-mini-tts", models: ["openai/gpt-4o-mini-tts"], ...bearer,
      body: { model: "{{model}}", input: "{{text}}", voice: "{{voice}}", response_format: "{{format}}" }, response: { mode: "binary" }, source: "builtin",
      docsURL: "https://openrouter.ai/docs/guides/overview/multimodal/tts",
    },
    video: {
      protocol: "openrouter-video", endpoint: "/videos", model: "google/veo-3.1", models: ["google/veo-3.1", "alibaba/wan-2.7"], ...bearer,
      body: { model: "{{model}}", prompt: "{{prompt}}", aspect_ratio: "{{aspect_ratio}}", duration: "{{duration}}", resolution: "{{resolution}}" }, response: json(), source: "builtin",
      docsURL: "https://openrouter.ai/docs/guides/overview/multimodal/video-generation",
      job: { idPath: "id", statusEndpoint: "/videos/{{jobId}}", statusPath: "status", successValues: ["completed"], failureValues: ["failed", "cancelled"], resultEndpoint: "/videos/{{jobId}}/content", resultResponse: { mode: "binary" } },
    },
  },
  groq: {
    audio: {
      protocol: "groq-speech", endpoint: "/audio/speech", model: "canopylabs/orpheus-v1-english", models: ["canopylabs/orpheus-v1-english", "canopylabs/orpheus-arabic-saudi"], ...bearer,
      body: { model: "{{model}}", input: "{{text}}", voice: "{{voice}}", response_format: "{{format}}" }, response: { mode: "binary" }, source: "builtin",
      docsURL: "https://console.groq.com/docs/text-to-speech/orpheus",
    },
  },
  nvidia: {
    image: {
      protocol: "nvidia-image", endpoint: "https://ai.api.nvidia.com/v1/genai/{{model}}", model: "black-forest-labs/flux.2-klein-4b", models: ["black-forest-labs/flux.2-klein-4b"], ...bearer,
      body: { prompt: "{{prompt}}", width: "{{width}}", height: "{{height}}" }, response: json(["artifacts.0.base64", "image"], ["artifacts.0.url"]), source: "builtin",
      docsURL: "https://docs.api.nvidia.com/nim/reference/black-forest-labs-flux_2-klein-4b-infer",
    },
  },
};

function legacyModel(provider: Provider, kind: MediaKind): string | undefined {
  if (kind === "image") return provider.imageModel;
  if (kind === "audio") return provider.audioModel;
  return provider.videoModel;
}

export function mediaCapabilities(provider: Provider): MediaKind[] {
  const preset = MEDIA_ADAPTER_PRESETS[provider.id] ?? {};
  return (["image", "audio", "video"] as MediaKind[]).filter((kind) => !!provider.mediaAdapters?.[kind] || !!preset[kind]);
}

export function resolveMediaAdapter(provider: Provider, kind: MediaKind): MediaAdapterConfig | undefined {
  const preset = MEDIA_ADAPTER_PRESETS[provider.id]?.[kind];
  const override = provider.mediaAdapters?.[kind];
  const adapter = override ?? preset;
  if (!adapter) return undefined;
  const model = legacyModel(provider, kind) || override?.model || preset?.model || "";
  return { ...adapter, model };
}

export type AdapterImportResult = {
  adapter?: MediaAdapterConfig;
  errors: string[];
  warnings: string[];
  summary: string;
};

function shellTokens(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < input.length) current += input[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/\s/.test(ch)) { if (current) { out.push(current); current = ""; } continue; }
    if (ch === "\\" && i + 1 < input.length) { const next = input[++i]; if (next !== "\n" && next !== "\r") current += next; continue; }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function redactSecret(value: string): string {
  const trimmed = value.trim();
  const scheme = /^(Bearer|Token|Basic)\s+/i.exec(trimmed)?.[1];
  const secret = scheme ? trimmed.slice(scheme.length).trim() : trimmed;
  if (!/^(?:sk-|AIza|key-|nvapi-)|^[A-Za-z0-9_\-.]{20,}$/i.test(secret)) return value;
  return scheme ? `${scheme} {{apiKey}}` : "{{apiKey}}";
}

function inferResponse(kind: MediaKind): MediaAdapterConfig["response"] {
  if (kind === "audio") return { mode: "binary" };
  return json(["data.0.b64_json", "data.image_base64.0", "data.audio", "artifacts.0.base64"], ["data.0.url", "data.image_urls.0", "output.video_url", "video.url"]);
}

function inferAsyncJob(url: URL, headers: Record<string, string>): MediaAdapterConfig["job"] {
  const full = `${url.hostname}${url.pathname}`.toLowerCase();
  if (Object.keys(headers).some((key) => key.toLowerCase() === "x-dashscope-async") || full.includes("dashscope")) {
    return { idPath: "output.task_id", statusEndpoint: `${url.origin}/api/v1/tasks/{{jobId}}`, statusPath: "output.task_status", successValues: ["SUCCEEDED"], failureValues: ["FAILED", "CANCELED"], resultResponse: json([], ["output.video_url", "output.results.0.url"]) };
  }
  if (full.includes("minimax") && full.includes("video_generation")) {
    return { idPath: "task_id", statusEndpoint: `${url.origin}/v1/query/video_generation?task_id={{jobId}}`, statusPath: "status", successValues: ["Success"], failureValues: ["Fail"], resultIdPaths: ["file_id"], resultEndpoint: `${url.origin}/v1/files/retrieve?file_id={{resultId}}`, resultResponse: json([], ["file.download_url"]) };
  }
  if (full.includes("generativelanguage.googleapis.com") && full.includes("predictlongrunning")) {
    return { idPath: "name", statusEndpoint: `${url.origin}/v1beta/{{jobId}}`, statusPath: "done", successValues: ["true"], failureValues: ["failed", "cancelled"], resultResponse: json([], ["response.generateVideoResponse.generatedSamples.0.video.uri", "response.generatedVideos.0.video.uri"]) };
  }
  if (full.includes("api.z.ai") && full.includes("videos/generations")) {
    const apiRoot = url.pathname.split("/videos/generations")[0];
    return { idPath: "id", statusEndpoint: `${url.origin}${apiRoot}/async-result/{{jobId}}`, statusPath: "task_status", successValues: ["SUCCESS"], failureValues: ["FAIL"], resultResponse: json([], ["video_result.0.url", "video_result.url"]) };
  }
  return { idPath: "id", statusEndpoint: "{{pollingUrl}}", statusPath: "status", successValues: ["completed", "succeeded"], failureValues: ["failed", "cancelled"], resultResponse: json([], ["unsigned_urls.0", "data.0.url", "output.url"]) };
}

export function importCurlAdapter(raw: string, kind: MediaKind, fallbackModel = ""): AdapterImportResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const tokens = shellTokens(raw.replace(/\\\r?\n/g, " "));
  if (tokens.some((token) => ["|", "||", "&&", ";", ">", ">>", "<"].includes(token))) errors.push("Shell operators are not allowed; only a single curl HTTP request can be imported.");
  if (!tokens.length || !/(^|\/)curl$/.test(tokens[0])) errors.push("Input must start with curl.");
  let method = "POST";
  let url = "";
  let data = "";
  const headers: Record<string, string> = {};
  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    if ((token === "-X" || token === "--request") && tokens[i + 1]) method = tokens[++i].toUpperCase();
    else if ((token === "-H" || token === "--header") && tokens[i + 1]) {
      const value = tokens[++i]; const at = value.indexOf(":");
      if (at > 0) {
        const key = value.slice(0, at).trim();
        const headerValue = value.slice(at + 1).trim();
        headers[key] = /authorization|api[-_]?key|token|cookie/i.test(key) ? redactSecret(headerValue) : headerValue;
      }
    } else if (["-d", "--data", "--data-raw", "--data-binary"].includes(token) && tokens[i + 1]) data = tokens[++i];
    else if (/^https?:\/\//i.test(token)) url = token;
  }
  if (method !== "POST") errors.push("Only POST media-generation requests are supported.");
  let parsedURL: URL | undefined;
  try { parsedURL = new URL(url); } catch { errors.push("No valid endpoint URL was found."); }
  if (parsedURL?.protocol !== "https:") errors.push("Only HTTPS endpoints can be imported.");
  if (parsedURL && /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(parsedURL.hostname)) errors.push("Local and private-network endpoints cannot be imported here.");
  if (data.startsWith("@")) errors.push("Reading request bodies from files is not allowed.");
  let body: Record<string, unknown> = {};
  if (data) {
    try { const value = JSON.parse(data); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); body = value; }
    catch { errors.push("The curl request body must be valid JSON."); }
  } else warnings.push("No JSON body was found; add fields manually after import.");
  if (errors.length || !parsedURL) return { errors, warnings, summary: "Import failed" };

  const authEntry = Object.entries(headers).find(([key]) => /^(authorization|x-goog-api-key|api-key|x-api-key)$/i.test(key));
  let authHeader = authEntry?.[0] ?? "Authorization";
  const importedScheme = authEntry ? /^(Bearer|Token|Basic)\s+/i.exec(authEntry[1])?.[1] : undefined;
  let authScheme = importedScheme ?? (authHeader.toLowerCase() === "authorization" ? "Bearer" : "");
  if (authEntry) delete headers[authEntry[0]];
  for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-type") delete headers[key];
  const model = typeof body.model === "string" ? body.model : fallbackModel;
  if (model) body.model = "{{model}}";
  const replaceFirstString = (value: unknown, keys: string[], placeholder: string): boolean => {
    if (!value || typeof value !== "object") return false;
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && typeof child === "string") { (value as Record<string, unknown>)[key] = placeholder; return true; }
      if (replaceFirstString(child, keys, placeholder)) return true;
    }
    return false;
  };
  if (kind === "audio") replaceFirstString(body, ["input", "text"], "{{text}}");
  else replaceFirstString(body, ["prompt", "text"], "{{prompt}}");
  if (kind === "audio") replaceFirstString(body, ["voice", "voice_id", "voiceName"], "{{voice}}");
  const asyncHint = kind === "video" || Object.keys(headers).some((key) => key.toLowerCase() === "x-dashscope-async");
  if (asyncHint) warnings.push("This looks asynchronous; configure status/result paths before testing if the assistant could not infer them.");
  const endpoint = `${parsedURL.origin}${parsedURL.pathname}${parsedURL.search}`;
  const adapter: MediaAdapterConfig = {
    protocol: asyncHint ? "custom-async" : "custom-sync", endpoint, method: "POST", model,
    authHeader, authScheme, headers, body, response: inferResponse(kind), source: "assistant",
    ...(asyncHint ? { job: inferAsyncJob(parsedURL, headers) } : {}),
  };
  return { adapter, errors, warnings, summary: `${kind} POST ${parsedURL.hostname}${parsedURL.pathname}` };
}

export function validateMediaAdapter(adapter: MediaAdapterConfig): string[] {
  const errors: string[] = [];
  if (!adapter.model) errors.push("A model id is required.");
  try { const url = adapter.endpoint.startsWith("/") ? new URL(`https://placeholder.invalid${adapter.endpoint}`) : new URL(adapter.endpoint); if (url.protocol !== "https:") errors.push("Endpoint must use HTTPS."); }
  catch { errors.push("Endpoint is not a valid URL or absolute path."); }
  if (!adapter.response) errors.push("Response extraction is missing.");
  if (adapter.protocol === "custom-async" && !adapter.job) errors.push("Async adapters need job id, status and result mappings.");
  return errors;
}
