import OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { reportRateLimitReset } from "./ide/limits";
import { t } from "./ide/i18n";
import {
  Provider,
  ProviderRole,
  findProviderForRole,
  isBrowserToolsEnabled,
  LOCAL_PROVIDER_ID,
  modelReasoningConfig,
  providerProtocol,
} from "./ide/providers";
import { resolveMediaAdapter } from "./ide/mediaAdapters";
import { loadActiveAsrModel, loadElevenLabsApiKey, loadTtsBackend, loadVoiceForLang } from "./ide/models";
import { getLang } from "./ide/i18n";
import { generateElevenLabsMusic, generateElevenLabsSoundEffect, synthesizeElevenLabs } from "./ide/elevenlabs";
import { McpServer, buildMcpTools, isMcpToolName, mcpToolIdentity, runMcpTool } from "./ide/mcp";
import {
  STUDIO_WINDOW_BUNDLES,
  captureObservedWindow,
  finishStudioVerification,
  listAllowedWindows,
  prepareStudioVerification,
  stopWindowObservation,
  watchForNewDialogSessions,
} from "./ide/windowVision";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  providerMeta?: {
    geminiThoughtSignature?: string;
  };
};

export type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
  // Only set on tool-role messages, so the UI can render a diff/preview
  // without having to look back at the assistant message that requested it.
  toolName?: string;
  toolArgs?: any;
  // Set on user messages: checkpoint taken before this turn's file mutations,
  // enabling one-click revert of everything the turn changed.
  checkpointId?: number;
  // User-pasted images (data: URLs, already downscaled/recompressed — see
  // ChatPanel's paste handler), sent to the model as real vision content.
  // Only ever set on role: "user" messages. Older turns' images are dropped
  // during compaction (see compactHistory) so they aren't resent forever.
  images?: string[];
  // Skills explicitly attached to this user turn. The composer selection is
  // cleared after send, while these ids let Continue reconstruct the same
  // context without making every project-enabled skill globally persistent.
  skillIds?: string[];
  // Opaque wire items that must survive a Responses API tool loop. These
  // include encrypted reasoning state; the UI never renders them.
  providerMeta?: {
    openaiResponseItems?: any[];
  };
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // Input tokens served from the provider's prompt cache (billed ~10x
  // cheaper by Sakana). Optional: only present when the API reports it.
  cached_tokens?: number;
};

export type ReasoningEffort = string;

export function reasoningEffortOptions(provider: Provider | undefined, model: string): string[] {
  return modelReasoningConfig(provider, model)?.options.map((option) => option.value) ?? [];
}

export function reasoningEffortChoices(provider: Provider | undefined, model: string) {
  return modelReasoningConfig(provider, model)?.options ?? [];
}

export function defaultReasoningEffort(provider: Provider | undefined, model: string): string | undefined {
  const config = modelReasoningConfig(provider, model);
  if (!config?.options.length) return undefined;
  return config.options.some((option) => option.value === config.defaultValue)
    ? config.defaultValue
    : config.options[0].value;
}

function applyReasoningParams(params: any, provider: Provider | undefined, model: string, selected?: string): void {
  const config = modelReasoningConfig(provider, model);
  if (!config || selected === undefined) return;
  const value = config.options.find((option) => option.value === selected)?.value;
  if (value === undefined) return;
  if (config.parameter === "reasoning_effort") params.reasoning_effort = value;
  if (config.parameter === "responses_reasoning") params.reasoning = { effort: value, summary: "auto" };
  if (config.parameter === "thinking") params.thinking = { type: value };
  if (config.parameter === "budget_tokens") {
    const budgetTokens = Number(value);
    if (Number.isFinite(budgetTokens) && budgetTokens > 0) {
      params.thinking = { type: "enabled", budget_tokens: budgetTokens };
    }
  }
}

function providerLooksLikeGemini(provider?: Provider): boolean {
  const haystack = `${provider?.id ?? ""} ${provider?.name ?? ""} ${provider?.baseURL ?? ""}`.toLowerCase();
  return haystack.includes("gemini") || haystack.includes("generativelanguage.googleapis.com");
}

function modelLooksLikeFixedTemperatureReasoning(model: string): boolean {
  const m = model.toLowerCase();
  // OpenAI o-series / GPT-5-style reasoning models commonly reject custom
  // temperature; Gemini can also 400 intermittently through compatibility
  // layers when sampling params are mixed with tool-calling streams.
  return /(^|[-_:])o[1-9](?:[-_:]|$)/.test(m) || m.startsWith("gpt-5") || m.includes("reasoning");
}

function shouldSendTemperature(provider: Provider | undefined, model: string): boolean {
  return !providerLooksLikeGemini(provider) && !modelLooksLikeFixedTemperatureReasoning(model);
}

function fallbackToolCallId(): string {
  return `call_${Math.random().toString(36).slice(2)}`;
}

function isJsonObjectString(raw: string): boolean {
  if (!raw?.trim()) return false;
  try {
    const parsed = JSON.parse(raw);
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

function safeToolArguments(raw: string): string {
  return isJsonObjectString(raw) ? raw : "{}";
}

function mergeToolArguments(current: string, chunk: string): string {
  if (!chunk) return current;
  const appended = current + chunk;
  // OpenAI streams arguments as fragments, so appending is the normal path.
  if (!current || isJsonObjectString(appended)) return appended;
  // Some compat streams can repeat the full JSON object; don't store
  // concatenated JSON objects, because echoed invalid arguments 400 later.
  if (isJsonObjectString(chunk)) return chunk;
  return appended;
}

// Tool calls that mutate the filesystem or run arbitrary shell commands
// require explicit user approval before executing, unless auto-approve is on.
export const SENSITIVE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "copy_library_asset",
  "run_command",
  "generate_image",
  "generate_audio",
  "generate_video",
  "generate_music",
  "generate_sound_effect",
  "browser_navigate",
  "browser_close",
  "browser_submit",
  "speak_text",
  "call_model",
]);

// Embedded-browser tools are handled by a separate dispatch path (they don't
// touch the filesystem — they control React state in App.tsx via the
// BrowserControl callbacks passed through AgentOptions) and are only sent to
// the model at all when isBrowserToolsEnabled() is on.
const BROWSER_TOOL_NAMES = new Set([
  "browser_open",
  "browser_navigate",
  "browser_close",
  "browser_screenshot",
  "browser_dom",
  "browser_click",
  "browser_type",
  "browser_submit",
  "browser_scroll",
  "browser_key",
]);

// File-mutating tools snapshot the previous state into the turn's checkpoint
// so the user can revert the whole turn.
const CHECKPOINTED_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file", "copy_library_asset"]);

// Tool name -> which provider role should serve it, when role routing is on.
const MEDIA_TOOLS: Record<string, ProviderRole> = {
  generate_image: "image",
  generate_audio: "audio",
  generate_video: "video",
};

function shouldVerifyStudioTool(toolName: string): boolean {
  return !(
    toolName.endsWith("_info") ||
    toolName.includes("_list_") ||
    toolName === "obs_status" ||
    toolName === "obs_screenshot"
  );
}

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file relative to the workspace root",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a new file or fully overwrite an existing one, relative to the workspace root. Prefer edit_file for targeted changes to existing files.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace an exact substring (old_string) with new_string in an existing file. old_string must match exactly and, unless replace_all is true, must be unique in the file - include enough surrounding context to make it unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description: "Delete a file (or directory, recursively) relative to the workspace root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "move_file",
      description: "Move or rename a file within the workspace.",
      parameters: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "copy_library_asset",
      description: "Copy a file from an enabled skill into the project workspace. Use an absolute source path exactly as listed in the enabled skill map and a workspace-relative destination path. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string" },
          path: { type: "string", description: "destination relative to the workspace" },
        },
        required: ["source", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List entries of a directory relative to the workspace root",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description:
        "Search the whole project for text (like grep). Returns matching lines as 'relative/path:line: content'. Read-only. Use this to locate where symbols, strings, or patterns are defined or used before editing.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "text or regex to search for" },
          is_regex: { type: "boolean", description: "treat query as a regular expression" },
          max_results: { type: "number" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob_files",
      description:
        "Find files by glob pattern (e.g. '**/*.tsx', 'src/**/index.ts'). Returns relative paths. Read-only. Use to discover files by name/extension.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          max_results: { type: "number" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Run a shell command (bash -lc) inside the workspace root and return stdout/stderr/exit code",
      parameters: {
        type: "object",
        properties: { cmd: { type: "string" } },
        required: ["cmd"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Generate an image from a text prompt and save it into the workspace. Uses whichever provider is configured with the 'image' role (Settings → Providers), or the current chat provider if role routing is off or no image provider is configured.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          path: { type: "string", description: "where to save the image, relative to the workspace root, e.g. 'assets/hero.png'" },
          size: { type: "string", description: "e.g. '1024x1024'" },
          aspect_ratio: { type: "string", description: "Gemini output ratio, e.g. '1:1', '16:9', or '9:16'" },
          image_size: { type: "string", description: "Gemini resolution: '512', '1K', '2K', or '4K'" },
          quality: { type: "string", description: "Provider-specific quality tier, e.g. 'standard', 'hd', or 'quality'" },
        },
        required: ["prompt", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_audio",
      description:
        "Generate speech audio from text and save it into the workspace. Uses whichever provider is configured with the 'audio' role, or falls back to the current chat provider.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          path: { type: "string" },
          voice: { type: "string" },
          format: { type: "string", description: "Audio format, usually mp3, wav, or flac" },
        },
        required: ["text", "path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_video",
      description:
        "Generate a short video from a text prompt and save it into the workspace. Uses whichever provider is configured with the 'video' role. Most OpenAI-compatible providers do not support this yet; expect a clear error unless the routed provider's endpoint exists.",
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          path: { type: "string" },
          duration: { type: "number", description: "Requested duration in seconds" },
          resolution: { type: "string", description: "e.g. 720p or 1080p" },
          aspect_ratio: { type: "string", description: "e.g. 16:9 or 9:16" },
          size: { type: "string", description: "Exact output size when the provider supports it" },
          with_audio: { type: "boolean" },
          quality: { type: "string" },
        },
        required: ["prompt", "path"],
      },
    },
  },
];

// Always available (no settings flag, no approval) — passive/view-only
// capabilities distinct from the browser-control toggle: opening a file tab
// or looking at the whole window isn't "controlling the browser," it's just
// letting the agent see what the user sees in the IDE's own preview panel.
// A function rather than a static array so speak_text's description can
// reflect whichever TTS backend is currently configured (Settings → Local
// AI Models) — it changed at runtime after ElevenLabs was added as an
// alternative to the local voices, and the model needs to know which output
// format/extension it's actually going to get.
function alwaysOnTools(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  const usingElevenLabs = loadTtsBackend() === "elevenlabs";
  const result: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "open_file_in_editor",
      description:
        "Open a file as a new tab in the IDE's own editor/preview panel, so the user can see it (works for text, images, PDF, audio, video — whatever the panel can preview). Only works when this chat's project is the same folder currently open in the IDE; otherwise returns an error.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          line: { type: "number", description: "optional line to scroll to, for text files" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "view_screen",
      description:
        "Take a screenshot of the whole MAHI window as it currently looks — useful to see what's in the editor/preview panel (an image, PDF, rendered markdown, a file the user has open) or an embedded browser tab. View-only: you will NOT receive the image back (no vision input); it's shown to the user in this tool's card.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "transcribe_media",
      description:
        "Transcribe speech from a local audio or video file using the installed local Whisper model (fully offline, no cloud provider). Requires a model to be downloaded first (Settings → Local AI Models); if none is installed, returns a clear error saying so. Returns plain text and timestamped segments.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          language: { type: "string", description: "optional ISO 639-1 code, e.g. 'fa', 'en' — omit to auto-detect" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "speak_text",
      description: usingElevenLabs
        ? "Synthesize speech from text via the configured ElevenLabs voice (cloud) and save it as an MP3 file into the workspace — use a .mp3 path. Requires an ElevenLabs API key and voice ID to be configured (Settings → Local AI Models); if missing, returns a clear error saying so."
        : "Synthesize speech from text using a downloaded local voice (fully offline, no cloud provider) and save it as a WAV file into the workspace — use a .wav path. Requires a voice to be installed for the target language (Settings → Local AI Models); if none is installed, returns a clear error saying so.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string" },
          path: { type: "string" },
          voice_id: {
            type: "string",
            description: usingElevenLabs
              ? "ignored — ElevenLabs uses the single voice ID configured in Settings"
              : "optional — omit to use the default voice for the current UI language",
          },
        },
        required: ["text", "path"],
      },
    },
  },
  ...WINDOW_VISION_TOOLS,
  ];
  if (loadElevenLabsApiKey()) {
    result.push(
      {
        type: "function",
        function: {
          name: "generate_music",
          description: "Generate original music with the ElevenLabs Music API using the API key configured in MAHI, and save it as an MP3 in the workspace. Use this instead of shell, curl, Python, or ELEVENLABS_API_KEY. Requires user approval and may consume paid ElevenLabs credits.",
          parameters: {
            type: "object",
            properties: {
              prompt: { type: "string", description: "Original musical direction; avoid copyrighted artist names and lyrics" },
              path: { type: "string", description: "Relative .mp3 output path" },
              duration_seconds: { type: "number", description: "3–600 seconds; defaults to 30" },
              model_id: { type: "string", enum: ["music_v2", "music_v1"], description: "Defaults to music_v2" },
              instrumental: { type: "boolean", description: "Force an instrumental result" },
            },
            required: ["prompt", "path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "generate_sound_effect",
          description: "Generate a non-speech sound effect with ElevenLabs using the API key configured in MAHI, and save it as an MP3 in the workspace. Use this instead of shell, curl, Python, or ELEVENLABS_API_KEY. Requires user approval and may consume paid ElevenLabs credits.",
          parameters: {
            type: "object",
            properties: {
              text: { type: "string", description: "Description of the desired sound" },
              path: { type: "string", description: "Relative .mp3 output path" },
              duration_seconds: { type: "number", description: "Optional duration from 0.5–30 seconds" },
              prompt_influence: { type: "number", description: "0–1; defaults to 0.3" },
              loop: { type: "boolean", description: "Create a seamless loop" },
            },
            required: ["text", "path"],
          },
        },
      }
    );
  }
  return result;
}

const WINDOW_VISION_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "window_list",
      description: "List capture-eligible macOS application windows after the user's one-time screen permission. Protected apps and MAHI itself are always excluded.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "window_observe",
      description: "Start an independent, focus-free observation stream for one application window. Prefer role=main unless a dialog/panel is required.",
      parameters: {
        type: "object",
        properties: {
          bundle_id: { type: "string" },
          window_id: { type: "number" },
          title_contains: { type: "string" },
          role: { type: "string", enum: ["main", "dialog", "panel"] },
          session_id: { type: "string" },
          fps: { type: "number", description: "0.5–10; default 1" },
          threshold: { type: "number", description: "Meaningful visual-change threshold, 0.001–1; default 0.03" },
          include_cursor: { type: "boolean" },
        },
        required: ["bundle_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "window_observe_group",
      description: "Temporarily observe several eligible windows together. Group capture is display-bound, so all windows must currently be on display_id.",
      parameters: {
        type: "object",
        properties: {
          display_id: { type: "number" },
          window_ids: { type: "array", items: { type: "number" } },
          session_id: { type: "string" },
          fps: { type: "number" },
          threshold: { type: "number" },
          include_cursor: { type: "boolean" },
        },
        required: ["display_id", "window_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "window_capture",
      description: "Return the latest screenshot path and change metadata for an observation session. Pass the imagePath to a vision-capable tool when visual inspection is needed.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" }, since_revision: { type: "number" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "window_wait_for_change",
      description: "Wait for a meaningful local visual change without sending frames to a model. Returns a screenshot path only after the session revision changes or timeout expires.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string" },
          after_revision: { type: "number" },
          timeout_ms: { type: "number", description: "Maximum 30000; default 3000" },
        },
        required: ["session_id", "after_revision"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "window_detect_dialogs",
      description: "Find newly opened dialog or floating-panel windows for an allowed application.",
      parameters: {
        type: "object",
        properties: {
          bundle_id: { type: "string" },
          known_window_ids: { type: "array", items: { type: "number" } },
        },
        required: ["bundle_id", "known_window_ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "window_sessions",
      description: "List active Window Vision observation sessions and their latest revision/status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "window_stop",
      description: "Stop a Window Vision observation session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string" } },
        required: ["session_id"],
      },
    },
  },
];

// Only appended when browser control is enabled. DOM actions run inside the
// native child WebView through Rust-side evaluateJavaScript, never through a
// Tauri IPC bridge exposed to the untrusted page itself.
const BROWSER_TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "browser_open",
      description:
        "Open a URL in a new embedded browser tab (visible to the user in the preview panel) and make it the active tab. Returns the new tab's id. Note: some sites (Google, banks, many login-gated apps) refuse to load in an iframe and will show a blank/error page — that's a site restriction, not a bug.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_navigate",
      description: "Navigate an embedded browser tab to a new URL. Defaults to the currently active browser tab if tab_id is omitted.",
      parameters: {
        type: "object",
        properties: { url: { type: "string" }, tab_id: { type: "string" } },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_close",
      description: "Close an embedded browser tab. Defaults to the currently active tab if tab_id is omitted.",
      parameters: {
        type: "object",
        properties: { tab_id: { type: "string" } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description:
        "Take a screenshot of the whole MAHI window, including the active embedded browser tab. The image is shown to the user; use browser_dom to inspect page content yourself.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_dom",
      description: "Read the active page's visible text and interactive elements with stable CSS selectors. Call this before clicking or typing and again after the page changes.",
      parameters: { type: "object", properties: { tab_id: { type: "string" } } },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_click",
      description: "Click a non-sensitive page element by CSS selector. Form submission, purchases, login, sending, deletion, and confirmation are blocked; use browser_submit for those.",
      parameters: { type: "object", properties: { selector: { type: "string" }, tab_id: { type: "string" } }, required: ["selector"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_type",
      description: "Focus and type into a normal input/textarea/contenteditable element. Password and payment-card fields are blocked. Does not press Enter or submit.",
      parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string" }, clear: { type: "boolean" }, tab_id: { type: "string" } }, required: ["selector", "text"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_submit",
      description: "Submit a form or activate a sensitive action after explicit user approval. Use the exact selector returned by browser_dom.",
      parameters: { type: "object", properties: { selector: { type: "string" }, tab_id: { type: "string" } }, required: ["selector"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_scroll",
      description: "Scroll the page or a scrollable element by CSS pixels.",
      parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, selector: { type: "string" }, tab_id: { type: "string" } }, required: ["y"] },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_key",
      description: "Send a safe navigation key to the focused or selected element: Tab, Escape, arrows, PageUp/PageDown, Home, or End. Enter is intentionally unavailable; use browser_submit.",
      parameters: { type: "object", properties: { key: { type: "string", enum: ["Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"] }, selector: { type: "string" }, tab_id: { type: "string" } }, required: ["key"] },
    },
  },
];

// Tool results feed straight into conversation history, which gets resent in
// full on every subsequent API call for the rest of the session. Uncapped
// file dumps or command logs are the single biggest source of runaway token
// costs, so every tool result is capped at the source, before it ever enters
// history.
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return (
    s.slice(0, max) +
    `\n… [truncated ${s.length - max} more characters — use search_files for a targeted look instead of re-reading the whole file]`
  );
}

async function runTool(
  workspace: string,
  name: string,
  args: any,
  checkpointId?: number,
  skillRoots: string[] = []
): Promise<string> {
  try {
    if (checkpointId !== undefined && CHECKPOINTED_TOOLS.has(name)) {
      const paths: string[] =
        name === "move_file" ? [args.from, args.to] : args.path ? [args.path] : [];
      for (const p of paths) {
        await recordCheckpoint(workspace, checkpointId, p);
      }
    }
    switch (name) {
      case "read_file": {
        const content = await invoke<string>("read_file", { workspace, path: args.path });
        return truncate(content, 15000);
      }
      case "write_file": {
        try {
          args.__oldContent = await invoke<string>("read_file", { workspace, path: args.path });
        } catch {
          args.__oldContent = "";
        }
        await invoke("write_file", { workspace, path: args.path, content: args.content });
        return "ok";
      }
      case "edit_file":
        await invoke("edit_file", {
          workspace,
          path: args.path,
          oldString: args.old_string,
          newString: args.new_string,
          replaceAll: !!args.replace_all,
        });
        return "ok";
      case "delete_file":
        await invoke("delete_file", { workspace, path: args.path });
        return "ok";
      case "move_file":
        await invoke("move_file", { workspace, from: args.from, to: args.to });
        return "ok";
      case "copy_library_asset":
        await invoke("library_copy_asset", { workspace, source: args.source, path: args.path, allowedRoots: skillRoots });
        return `ok: copied library asset to ${args.path}`;
      case "list_dir": {
        const entries = await invoke<{ name: string; is_dir: boolean }[]>("list_dir", {
          workspace,
          path: args.path ?? ".",
        });
        return JSON.stringify(entries);
      }
      case "search_files":
        return await invoke<string>("search_files", {
          workspace,
          query: args.query,
          isRegex: !!args.is_regex,
          maxResults: args.max_results ?? 40,
        });
      case "glob_files":
        return await invoke<string>("glob_files", {
          workspace,
          pattern: args.pattern,
          maxResults: args.max_results ?? 150,
        });
      case "run_command": {
        const out = await invoke<{ stdout: string; stderr: string; code: number }>("run_command", {
          workspace,
          cmd: args.cmd,
        });
        return JSON.stringify({
          stdout: truncate(out.stdout, 4000),
          stderr: truncate(out.stderr, 2000),
          code: out.code,
        });
      }
      case "window_list":
        return JSON.stringify(await invoke("window_vision_list_allowed_windows"));
      case "window_observe": {
        const sessionId = args.session_id || `obs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return JSON.stringify(await invoke("window_vision_observe_app", {
          sessionId,
          bundleId: args.bundle_id,
          windowId: args.window_id,
          titleContains: args.title_contains,
          role: args.role,
          includeCursor: !!args.include_cursor,
          fps: args.fps,
          threshold: args.threshold,
        }));
      }
      case "window_observe_group": {
        const sessionId = args.session_id || `group_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        return JSON.stringify(await invoke("window_vision_start_group", {
          sessionId,
          displayId: args.display_id,
          windowIds: args.window_ids,
          includeCursor: !!args.include_cursor,
          fps: args.fps,
          threshold: args.threshold,
        }));
      }
      case "window_capture":
        return JSON.stringify(await invoke("window_vision_capture", {
          sessionId: args.session_id,
          sinceRevision: args.since_revision ?? 0,
        }));
      case "window_wait_for_change":
        return JSON.stringify(await invoke("window_vision_wait_for_change", {
          sessionId: args.session_id,
          afterRevision: args.after_revision,
          timeoutMs: args.timeout_ms ?? 3000,
        }));
      case "window_detect_dialogs":
        return JSON.stringify(await invoke("window_vision_detect_dialogs", {
          bundleId: args.bundle_id,
          knownWindowIds: args.known_window_ids ?? [],
        }));
      case "window_sessions":
        return JSON.stringify(await invoke("window_vision_sessions"));
      case "window_stop":
        return JSON.stringify(await invoke("window_vision_stop", { sessionId: args.session_id }));
      default:
        return `unknown tool: ${name}`;
    }
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

async function recordCheckpoint(workspace: string, checkpointId: number | undefined, path?: string) {
  if (checkpointId === undefined || !path) return;
  await invoke("checkpoint_record", { workspace, id: checkpointId, path }).catch(() => {});
}

export function makeClient(apiKey: string, baseURL = "https://api.sakana.ai/v1") {
  return new OpenAI({
    apiKey,
    baseURL,
    dangerouslyAllowBrowser: true,
    // The webview's own fetch is subject to browser CORS, which most provider
    // APIs don't allow for cross-origin calls. Route through Tauri's http
    // plugin instead, which performs the request natively in Rust.
    fetch: tauriFetch as unknown as typeof fetch,
  });
}

function toResponsesTools(chatTools: any[]): any[] {
  return chatTools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
    strict: false,
  }));
}

function pathParts(path: string): string[] {
  return path.split(".").map((part) => part.trim()).filter((part) => part && !["__proto__", "prototype", "constructor"].includes(part));
}

function getPath(value: any, path: string): any {
  return pathParts(path).reduce((current, part) => current?.[/^\d+$/.test(part) ? Number(part) : part], value);
}

function setPath(target: any, path: string, value: any): void {
  const parts = pathParts(path);
  if (!parts.length) return;
  let current = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    const nextIsIndex = /^\d+$/.test(parts[i + 1]);
    current = current[part] ??= nextIsIndex ? [] : {};
  }
  current[parts[parts.length - 1]] = value;
}

function customRequest(provider: Provider, values: Record<string, any>) {
  const adapter = provider.customAdapter!;
  const expand = (value: string) => value.split("{{apiKey}}").join(provider.apiKey);
  const expandValue = (value: any): any => {
    if (typeof value === "string") return expand(value);
    if (Array.isArray(value)) return value.map(expandValue);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandValue(item)]));
    return value;
  };
  const body: any = expandValue(structuredClone(adapter.body ?? {}));
  const mappings: Array<[string, any]> = [
    [adapter.modelPath, values.model], [adapter.messagesPath, values.messages], [adapter.toolsPath, values.tools],
    [adapter.streamPath, values.stream], [adapter.temperaturePath, values.temperature], [adapter.maxTokensPath, values.maxTokens],
    [adapter.reasoningPath, values.reasoning],
  ];
  for (const [path, value] of mappings) if (path && value !== undefined) setPath(body, path, value);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (adapter.authHeader) headers[adapter.authHeader] = `${adapter.authScheme ? `${adapter.authScheme} ` : ""}${provider.apiKey}`;
  for (const [key, value] of Object.entries(adapter.headers ?? {})) headers[key] = expand(value);
  const url = `${provider.baseURL.replace(/\/+$/, "")}/${adapter.endpointPath.replace(/^\/+/, "")}`;
  return { url, headers, body };
}

async function customJsonComplete(provider: Provider, values: Record<string, any>, signal?: AbortSignal): Promise<any> {
  const request = customRequest(provider, { ...values, stream: false });
  const response = await tauriFetch(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal });
  const payload: any = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(getPath(payload, provider.customAdapter!.errorPath) || `HTTP ${response.status}`);
  return payload;
}

export async function providerComplete(
  provider: Provider,
  model: string,
  messages: Array<{ role: string; content: string }>,
  options: { temperature?: number; maxTokens?: number } = {}
): Promise<string | null> {
  const client = makeClient(provider.apiKey, provider.baseURL);
  if (providerProtocol(provider) === "custom-json" && provider.customAdapter) {
    const payload = await customJsonComplete(provider, {
      model, messages, temperature: options.temperature, maxTokens: options.maxTokens,
      reasoning: defaultReasoningEffort(provider, model),
    });
    const text = getPath(payload, provider.customAdapter.responseTextPath);
    return typeof text === "string" ? text.trim() || null : null;
  }
  if (providerProtocol(provider) === "openai-responses") {
    const params: any = { model, input: messages, store: false, max_output_tokens: options.maxTokens };
    applyReasoningParams(params, provider, model, defaultReasoningEffort(provider, model));
    if (options.temperature !== undefined && shouldSendTemperature(provider, model)) params.temperature = options.temperature;
    const response: any = await client.responses.create(params);
    return response.output_text?.trim() || null;
  }
  const params: any = {
    model,
    messages,
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.temperature !== undefined && shouldSendTemperature(provider, model) ? { temperature: options.temperature } : {}),
  };
  applyReasoningParams(params, provider, model, defaultReasoningEffort(provider, model));
  const response = await client.chat.completions.create(params);
  return response.choices?.[0]?.message?.content?.trim() || null;
}

/// Media-generation tools run against whichever provider owns that role
/// (see findProviderForRole), which may differ from the chat provider —
/// so they build their own short-lived client rather than reusing runTool's.
function sizeToAspectRatio(size?: string): string | undefined {
  const match = String(size ?? "").match(/^(\d+)x(\d+)$/);
  if (!match) return undefined;
  const width = Number(match[1]); const height = Number(match[2]);
  if (!width || !height) return undefined;
  const ratio = width / height;
  const supported: Array<[string, number]> = [["1:1", 1], ["2:3", 2 / 3], ["3:2", 3 / 2], ["3:4", 3 / 4], ["4:3", 4 / 3], ["4:5", 4 / 5], ["5:4", 5 / 4], ["9:16", 9 / 16], ["16:9", 16 / 9], ["21:9", 21 / 9]];
  return supported.reduce((best, entry) => Math.abs(entry[1] - ratio) < Math.abs(best[1] - ratio) ? entry : best)[0];
}

function findGeneratedImageData(value: any): string | undefined {
  if (!value) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) { const found = findGeneratedImageData(item); if (found) return found; }
    return undefined;
  }
  if (typeof value !== "object") return undefined;
  if (typeof value.b64_json === "string") return value.b64_json;
  const mime = value.mime_type ?? value.mimeType;
  if (typeof value.data === "string" && (value.type === "image" || String(mime ?? "").startsWith("image/"))) return value.data;
  for (const item of Object.values(value)) { const found = findGeneratedImageData(item); if (found) return found; }
  return undefined;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer); let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function mediaPath(value: any, path: string): any {
  return path.split(".").reduce((current: any, key) => {
    if (current === undefined || current === null) return undefined;
    return current[/^\d+$/.test(key) ? Number(key) : key];
  }, value);
}

function firstMediaPath(value: any, paths: string[] | undefined): any {
  for (const path of paths ?? []) {
    const result = mediaPath(value, path);
    if (result !== undefined && result !== null && result !== "") return result;
  }
  return undefined;
}

function mediaTemplate(value: unknown, variables: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([a-zA-Z0-9_]+)\}\}$/);
    if (exact) return variables[exact[1]];
    return value.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key) => String(variables[key] ?? ""));
  }
  if (Array.isArray(value)) return value.map((item) => mediaTemplate(item, variables)).filter((item) => item !== undefined && item !== "");
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const rendered = mediaTemplate(item, variables);
      if (rendered !== undefined && rendered !== "") output[key] = rendered;
    }
    return output;
  }
  return value;
}

function mediaURL(baseURL: string, template: string, variables: Record<string, unknown>): string {
  const rendered = String(mediaTemplate(template, variables));
  if (/^https:\/\//i.test(rendered)) return rendered;
  return `${baseURL.replace(/\/+$/, "")}/${rendered.replace(/^\/+/, "")}`;
}

function mediaHeaders(provider: Provider, authHeader?: string, authScheme?: string, extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(extra ?? {}) };
  if (authHeader) headers[authHeader] = authScheme ? `${authScheme} ${provider.apiKey}` : provider.apiKey;
  return headers;
}

function mediaError(payload: any, status: number): string {
  return String(mediaPath(payload, "error.message") ?? mediaPath(payload, "base_resp.status_msg") ?? mediaPath(payload, "message") ?? `HTTP ${status}`);
}

function hexToBase64(value: string): string {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2) return value;
  const bytes = new Uint8Array(value.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function responseToMediaBase64(
  response: Response,
  config: { mode: "binary" | "json"; base64Paths?: string[]; urlPaths?: string[] },
  headers: Record<string, string>,
  protocol: string
): Promise<{ base64?: string; payload?: any; error?: string }> {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    return { payload, error: mediaError(payload, response.status) };
  }
  if (config.mode === "binary") return { base64: arrayBufferToBase64(await response.arrayBuffer()) };
  const payload: any = await response.json().catch(() => ({}));
  let base64 = firstMediaPath(payload, config.base64Paths);
  if (typeof base64 !== "string") base64 = findGeneratedImageData(payload);
  if (typeof base64 === "string" && protocol === "minimax-speech") base64 = hexToBase64(base64);
  if (typeof base64 === "string") base64 = base64.replace(/^data:[^;]+;base64,/, "");
  const url = firstMediaPath(payload, config.urlPaths);
  if (!base64 && typeof url === "string") {
    const download = await tauriFetch(url, { headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")) });
    if (download.ok) base64 = arrayBufferToBase64(await download.arrayBuffer());
  }
  return { base64: typeof base64 === "string" ? base64 : undefined, payload };
}

function defaultMediaVoice(provider: Provider): string {
  if (provider.id === "gemini") return "Kore";
  if (provider.id === "minimax") return "male-qn-qingse";
  if (provider.id === "groq") return "autumn";
  if (provider.id === "qwen") return "longxiaochun";
  return "alloy";
}

type PendingMediaJob = {
  id: string;
  providerId: string;
  workspace: string;
  path: string;
  kind: "image" | "audio" | "video";
  adapter: NonNullable<ReturnType<typeof resolveMediaAdapter>>;
  variables: Record<string, unknown>;
  initial: any;
  createdAt: number;
  attempts: number;
};

const MEDIA_JOBS_KEY = "mahi_pending_media_jobs_v1";

function pendingMediaJobs(): PendingMediaJob[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(MEDIA_JOBS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function savePendingMediaJobs(jobs: PendingMediaJob[]) {
  localStorage.setItem(MEDIA_JOBS_KEY, JSON.stringify(jobs));
}

function rememberMediaJob(job: Omit<PendingMediaJob, "id" | "createdAt" | "attempts">): string {
  const id = `media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  savePendingMediaJobs([...pendingMediaJobs(), { ...job, id, createdAt: Date.now(), attempts: 0 }]);
  return id;
}

function forgetMediaJob(id: string) {
  savePendingMediaJobs(pendingMediaJobs().filter((job) => job.id !== id));
}

function bumpMediaJob(id: string) {
  savePendingMediaJobs(pendingMediaJobs().map((job) => job.id === id ? { ...job, attempts: job.attempts + 1 } : job));
}

async function waitForMediaJob(
  provider: Provider,
  adapter: NonNullable<ReturnType<typeof resolveMediaAdapter>>,
  initial: any,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
  signal?: AbortSignal,
  onStatus?: (status: string) => void,
  pendingJobId?: string
): Promise<{ base64?: string; error?: string }> {
  const job = adapter.job;
  if (!job) return { error: "provider returned an asynchronous job but no polling configuration exists" };
  const jobId = mediaPath(initial, job.idPath);
  if (typeof jobId !== "string" || !jobId) return { error: `job id was not found at ${job.idPath}` };
  const pollingUrl = firstMediaPath(initial, ["polling_url", "pollingUrl"]);
  const jobVariables = { ...variables, jobId, pollingUrl };
  let payload = initial;
  for (let attempt = 0; attempt < (job.maxPolls ?? 120); attempt++) {
    if (signal?.aborted) throw new DOMException("Media generation stopped", "AbortError");
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, job.pollIntervalMs ?? 3000));
    const statusResponse = await tauriFetch(mediaURL(provider.baseURL, job.statusEndpoint, jobVariables), {
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
      signal,
    });
    payload = await statusResponse.json().catch(() => ({}));
    if (!statusResponse.ok) return { error: mediaError(payload, statusResponse.status) };
    const rawStatus = mediaPath(payload, job.statusPath);
    const status = String(rawStatus);
    onStatus?.(`${provider.name}: ${status}`);
    if (pendingJobId) bumpMediaJob(pendingJobId);
    if (job.failureValues.some((value) => value.toLowerCase() === status.toLowerCase())) return { error: mediaError(payload, statusResponse.status) };
    if (!job.successValues.some((value) => value.toLowerCase() === status.toLowerCase())) continue;

    const resultId = firstMediaPath(payload, job.resultIdPaths);
    const resultVariables = { ...jobVariables, resultId };
    const responseConfig = job.resultResponse ?? adapter.response;
    if (job.resultEndpoint) {
      const resultResponse = await tauriFetch(mediaURL(provider.baseURL, job.resultEndpoint, resultVariables), {
        headers: Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== "content-type")),
        signal,
      });
      return responseToMediaBase64(resultResponse, responseConfig, headers, adapter.protocol);
    }
    const syntheticResponse = new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    return responseToMediaBase64(syntheticResponse, responseConfig, headers, adapter.protocol);
  }
  return { error: "media generation timed out while waiting for the provider job" };
}

async function runMediaTool(
  provider: Provider,
  workspace: string,
  name: string,
  args: any,
  checkpointId?: number,
  signal?: AbortSignal,
  onStatus?: (status: string) => void
): Promise<string> {
  let pendingJobId: string | undefined;
  try {
    const kind = MEDIA_TOOLS[name];
    if (!kind) return `unknown media tool: ${name}`;
    const adapter = resolveMediaAdapter(provider, kind as "image" | "audio" | "video");
    if (!adapter) return `error: ${provider.name} has no configured ${kind} generation adapter`;
    if (!adapter.model) return `error: no ${kind}-generation model is configured for ${provider.name}`;
    const size = String(args.size || (kind === "image" ? "1024x1024" : "1280x720"));
    const dimensions = size.match(/^(\d+)x(\d+)$/i);
    const variables: Record<string, unknown> = {
      ...args,
      model: adapter.model,
      size,
      width: dimensions ? Number(dimensions[1]) : 1024,
      height: dimensions ? Number(dimensions[2]) : 1024,
      aspect_ratio: args.aspect_ratio || sizeToAspectRatio(size) || (kind === "video" ? "16:9" : "1:1"),
      image_size: ["512", "1K", "2K", "4K"].includes(args.image_size) ? args.image_size : "1K",
      voice: args.voice || defaultMediaVoice(provider),
      format: args.format || (String(args.path).toLowerCase().endsWith(".wav") ? "wav" : "mp3"),
      duration: args.duration ?? 5,
      resolution: args.resolution || "720p",
      quality: args.quality || (kind === "image" ? "hd" : "quality"),
      with_audio: args.with_audio ?? true,
    };
    const headers = mediaHeaders(provider, adapter.authHeader, adapter.authScheme, adapter.headers);
    const response = await tauriFetch(mediaURL(provider.baseURL, adapter.endpoint, variables), {
      method: "POST",
      headers,
      body: JSON.stringify(mediaTemplate(adapter.body, variables)),
      signal,
    });
    let result: { base64?: string; payload?: any; error?: string };
    if (adapter.job) {
      const initial = await response.json().catch(() => ({}));
      if (!response.ok) return `error: ${provider.name} ${kind} API ${response.status}: ${mediaError(initial, response.status)}`;
      pendingJobId = rememberMediaJob({ providerId: provider.id, workspace, path: args.path, kind: kind as "image" | "audio" | "video", adapter, variables, initial });
      result = await waitForMediaJob(provider, adapter, initial, variables, headers, signal, onStatus, pendingJobId);
    } else {
      result = await responseToMediaBase64(response, adapter.response, headers, adapter.protocol);
    }
    if (result.error) return `error: ${provider.name} ${kind} API: ${result.error}`;
    if (!result.base64) return `error: ${provider.name} returned no decodable ${kind} data`;
    await recordCheckpoint(workspace, checkpointId, args.path);
    await invoke("write_file_binary", { workspace, path: args.path, base64Content: result.base64 });
    if (pendingJobId) forgetMediaJob(pendingJobId);
    return `ok: ${kind} saved to ${args.path} (via provider "${provider.name}", model "${adapter.model}")`;
    return `unknown media tool: ${name}`;
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

// A video provider can outlive the WebView/process that submitted the job.
// Resume remembered polling work on the next launch without persisting API
// keys (the current provider key is looked up at resume time).
export async function resumePendingMediaJobs(providers: Provider[]): Promise<string[]> {
  const results: string[] = [];
  const now = Date.now();
  for (const job of pendingMediaJobs()) {
    if (now - job.createdAt > 24 * 60 * 60 * 1000 || job.attempts > 240) { forgetMediaJob(job.id); continue; }
    const provider = providers.find((candidate) => candidate.id === job.providerId && candidate.apiKey);
    if (!provider) continue;
    try {
      const headers = mediaHeaders(provider, job.adapter.authHeader, job.adapter.authScheme, job.adapter.headers);
      const result = await waitForMediaJob(provider, job.adapter, job.initial, job.variables, headers, undefined, undefined, job.id);
      if (!result.base64) { results.push(`${provider.name}: ${result.error ?? "media result unavailable"}`); continue; }
      await invoke("write_file_binary", { workspace: job.workspace, path: job.path, base64Content: result.base64 });
      forgetMediaJob(job.id);
      results.push(`${provider.name}: resumed media saved to ${job.path}`);
    } catch (error) {
      results.push(`${provider.name}: ${String(error)}`);
    }
  }
  return results;
}

// call_model: lets the current turn's model delegate a sub-task to a
// DIFFERENT configured provider/model (e.g. a Skill file
// saying "have Gemini do the translation step"). Gated behind
// opts.allowModelRouting (see agentTurn) — a per-session switch the user
// explicitly turns on, confirmed once per project via a popup — so this
// tool is simply absent from activeTools otherwise, not just discouraged.
// Deliberately a single plain completion with NO tools of its own: the
// sub-model can't call further tools (including call_model itself), so
// there's no recursive delegation chain to reason about or runaway on.
function buildCallModelTool(providers: Provider[]): OpenAI.Chat.Completions.ChatCompletionTool {
  const available = providers
    .filter((p) => p.id !== LOCAL_PROVIDER_ID && p.apiKey)
    .map((p) => `${p.id} (${p.name}): ${p.models.join(", ")}`)
    .join("; ");
  return {
    type: "function",
    function: {
      name: "call_model",
      description:
        `Delegate a sub-task to a different configured model — use only when explicitly instructed to (e.g. a skill file naming a specific model for a specific step), not on your own initiative. Returns that model's plain text reply; it has no tools of its own and cannot see this conversation's history, so include everything it needs in the prompt. Available provider_id/model combinations: ${available || "(none configured with an API key)"}.`,
      parameters: {
        type: "object",
        properties: {
          provider_id: { type: "string", description: "One of the provider ids listed above." },
          model: { type: "string", description: "One of that provider's model ids listed above." },
          prompt: { type: "string", description: "The task/content to send to that model." },
          system_prompt: { type: "string", description: "Optional system prompt for the sub-call." },
        },
        required: ["provider_id", "model", "prompt"],
      },
    },
  };
}

async function runCallModelTool(providers: Provider[], args: any): Promise<string> {
  const provider = providers.find((p) => p.id === args.provider_id);
  if (!provider) return `error: unknown provider_id "${args.provider_id}" — check the tool's listed available providers.`;
  if (!provider.apiKey) return `error: provider "${provider.name}" has no API key configured in Settings → Providers.`;
  if (!args.model || !provider.models.includes(args.model)) {
    return `error: "${args.model}" is not one of ${provider.name}'s configured models (${provider.models.join(", ")}).`;
  }
  if (!args.prompt) return "error: prompt is required.";
  try {
    const text = await providerComplete(provider, args.model, [
      ...(args.system_prompt ? [{ role: "system", content: args.system_prompt }] : []),
      { role: "user", content: args.prompt },
    ]);
    return text || "error: the delegated model returned an empty response.";
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

// Backs the embedded-browser tools. Implemented in App.tsx against React
// state (the browser tabs live there, not in Rust) — navigate/close return
// null/false when the given (or default active) tab id doesn't exist.
export type BrowserControl = {
  open: (url: string) => string;
  navigate: (url: string, tabId?: string) => string | null;
  close: (tabId?: string) => boolean;
  screenshot: () => Promise<string>;
  dom: (tabId?: string) => Promise<unknown>;
  click: (selector: string, tabId?: string) => Promise<unknown>;
  type: (selector: string, text: string, clear?: boolean, tabId?: string) => Promise<unknown>;
  submit: (selector: string, tabId?: string) => Promise<unknown>;
  scroll: (x: number, y: number, selector?: string, tabId?: string) => Promise<unknown>;
  key: (key: string, selector?: string, tabId?: string) => Promise<unknown>;
};

/// Dispatches browser_* tool calls against the BrowserControl passed from
/// App.tsx. The screenshot's base64 payload is stashed on `args` (mutated in
/// place, mirroring write_file's `args.__oldContent` pattern) purely for
/// ToolCallView renders the screenshot via onScreenshot, keyed by tool_call_id
/// — deliberately NOT stashed on the Msg/toolArgs that ends up in `history`.
/// A full-window PNG easily runs into multiple MB as base64; putting that on
/// a persisted Msg would mean: it gets JSON.stringify'd and resent to the API
/// on every later call in the conversation (a multi-MB string can visibly
/// hang the render thread), and it gets written into localStorage on every
/// session change (risking a quota-exceeded error — see the sessions-save
/// effect in ChatPanel.tsx). Keeping it in an in-memory-only side channel
/// avoids all of that; the trade-off is screenshots don't survive a reload,
/// which is fine for a "look at the current state" utility.
async function runBrowserTool(
  control: BrowserControl | undefined,
  name: string,
  args: any,
  onScreenshot?: (b64: string) => void
): Promise<string> {
  if (!control) return "error: embedded browser is not available right now";
  try {
    if (name === "browser_open") {
      const id = control.open(args.url);
      return `ok: opened tab ${id} → ${args.url}`;
    }
    if (name === "browser_navigate") {
      const id = control.navigate(args.url, args.tab_id);
      return id
        ? `ok: navigated tab ${id} → ${args.url}`
        : "error: tab not found (pass a valid tab_id, or omit it to use the active tab)";
    }
    if (name === "browser_close") {
      return control.close(args.tab_id) ? "ok: tab closed" : "error: tab not found";
    }
    if (name === "browser_screenshot") {
      const b64 = await control.screenshot();
      onScreenshot?.(b64);
      return "ok: screenshot captured (shown to the user in this tool card — you cannot see it yourself)";
    }
    if (name === "browser_dom") return truncate(JSON.stringify(await control.dom(args.tab_id)), 16_000);
    if (name === "browser_click") return JSON.stringify(await control.click(args.selector, args.tab_id));
    if (name === "browser_type") return JSON.stringify(await control.type(args.selector, args.text, !!args.clear, args.tab_id));
    if (name === "browser_submit") return JSON.stringify(await control.submit(args.selector, args.tab_id));
    if (name === "browser_scroll") return JSON.stringify(await control.scroll(args.x ?? 0, args.y ?? 0, args.selector, args.tab_id));
    if (name === "browser_key") return JSON.stringify(await control.key(args.key, args.selector, args.tab_id));
    return `unknown browser tool: ${name}`;
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

export type AgentOptions = {
  reasoningEffort?: ReasoningEffort;
  temperature?: number;
  signal?: AbortSignal;
  checkpointId?: number;
  // MAHI's prompt-history budget in tokens (estimated). Kept under Sakana's
  // 272k price cliff by default; the provider's real context limit still
  // applies on top of this.
  contextBudget?: number;
  onDelta: (contentSoFar: string) => void;
  onStep: (m: Msg) => void;
  onUsage: (u: Usage) => void;
  onHeaders?: (headers: Record<string, string>) => void;
  onNotice?: (text: string) => void;
  requestApproval: (toolName: string, args: any) => Promise<boolean>;
  // Needed to route generate_image/generate_audio/generate_video to
  // whichever provider owns that role, which may differ from the provider
  // driving this chat turn. chatProvider is also the fallback when role
  // routing is off or no provider claims the role.
  chatProvider?: Provider;
  allProviders?: Provider[];
  // Backs browser_open/navigate/close/screenshot when isBrowserToolsEnabled()
  // is on. Undefined is treated as "browser tools unavailable".
  browserControl?: BrowserControl;
  // Delivers a browser_screenshot's base64 PNG straight to the UI, keyed by
  // the tool call's id — see runBrowserTool's comment for why this must stay
  // out of the persisted Msg/history instead of being returned as text.
  onScreenshot?: (toolCallId: string, base64: string) => void;
  // Backs open_file_in_editor. Undefined (rather than a no-op) when this
  // chat's project isn't the folder open in the IDE, so the tool can return
  // a clear error instead of silently doing nothing.
  openFile?: (path: string, line?: number) => void;
  // Enabled servers' tools get discovered and merged into this turn's tool
  // list (see mcp.ts's buildMcpTools) and dispatched back through
  // runMcpTool when called. Undefined/empty means no MCP tools this turn.
  mcpServers?: McpServer[];
  // Per-session switch (see ChatPanel's model-routing toggle) — call_model
  // is only added to activeTools when true, so the model literally cannot
  // delegate to another model unless the user has explicitly turned this on
  // for the current session.
  allowModelRouting?: boolean;
  // Absolute roots selected for this user message. The native copy command
  // checks these again so project-enabled but unselected skills remain
  // inaccessible to model tools.
  skillRoots?: string[];
};

function isRetryable(e: any): boolean {
  const status: number | undefined = e?.status ?? e?.response?.status;
  if (status !== undefined) {
    return status === 429 || status === 408 || (status >= 500 && status < 600);
  }
  const msg = String(e?.message ?? e).toLowerCase();
  return (
    msg.includes("connection") ||
    msg.includes("network") ||
    msg.includes("timeout") ||
    msg.includes("overloaded") ||
    msg.includes("exhausted") ||
    msg.includes("rate limit")
  );
}

/// Sakana's 429 errors include "Try again after <ISO timestamp>". Returns ms
/// until that reset, or null if the error carries no reset time.
function resetDelayFromError(e: any): number | null {
  const msg = String(e?.message ?? e);
  const m = msg.match(/[Tt]ry again after (\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+)/);
  if (!m) return null;
  const t = Date.parse(m[1]);
  if (Number.isNaN(t)) return null;
  return Math.max(0, t - Date.now());
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true }
    );
  });
}

/// The dominant token cost is the stateless-API quadratic: within one turn
/// the agent may call the API dozens of times, and EVERY call resends the
/// whole history — so every old tool dump gets billed again and again.
/// Compact past turns' tool results down to a stub before starting a new
/// turn. The assistant's own text (its conclusions) is kept verbatim, so
/// quality is preserved; if the model needs the raw data again it can
/// re-fetch exactly the part it needs.
const TOOL_STUB_NOTE =
  "\n… [compacted: older tool result trimmed to save tokens — re-run the tool if the full data is needed]";

/// Deterministic stub for one message (same input → same output, so
/// consecutive turns produce byte-identical prefixes and the provider's
/// prompt cache keeps hitting). Returns the original object when nothing
/// needs trimming.
function stubMsg(m: Msg): Msg {
  let changed = false;
  let content = m.content;
  if (m.role === "tool" && content.length > 500) {
    content = content.slice(0, 400) + TOOL_STUB_NOTE;
    changed = true;
  }
  // Big write_file/edit_file bodies live in the ASSISTANT message's
  // tool_calls arguments and would otherwise be re-billed forever.
  let tool_calls = m.tool_calls;
  if (m.role === "assistant" && tool_calls?.some((tc) => tc.function.arguments.length > 800)) {
    tool_calls = tool_calls.map((tc) => {
      if (tc.function.arguments.length <= 800) return tc;
      let brief = "";
      try {
        const a = JSON.parse(tc.function.arguments);
        brief = a.path ?? a.from ?? a.cmd ?? a.pattern ?? a.query ?? "";
      } catch {
        // unparseable arguments — stub without the brief
      }
      return {
        ...tc,
        function: {
          ...tc.function,
          arguments: JSON.stringify({
            target: String(brief).slice(0, 200),
            note: "[arguments compacted after being applied — see the tool result and later file state]",
          }),
        },
      };
    });
    changed = true;
  }
  return changed ? { ...m, content, tool_calls } : m;
}

/// The dominant token cost is the stateless-API quadratic: within one turn
/// the agent may call the API dozens of times, and EVERY call resends the
/// whole history. Compact past turns' bulky payloads before a new turn;
/// the assistant's own text (its conclusions) is kept verbatim.
export function compactHistory(messages: Msg[]): Msg[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  return messages.map((m, i) => {
    if (i >= lastUserIdx) return m;
    let stubbed = m.role !== "user" ? stubMsg(m) : m;
    // Provider wire metadata is only required while continuing the current
    // tool turn. Once a newer user turn exists, normalized text/tool history
    // is enough and much smaller than replaying opaque response items.
    if (stubbed.providerMeta) stubbed = { ...stubbed, providerMeta: undefined };
    // User text is otherwise pinned verbatim (cheap), but pasted images are
    // not — resending them on every subsequent call for the rest of the
    // conversation would be expensive for zero benefit once the turn that
    // introduced them is done. Drop images from older turns only.
    if (!stubbed.images?.length) return stubbed;
    return {
      ...stubbed,
      images: undefined,
      content: `${stubbed.content}\n[${stubbed.images.length} image(s) omitted after compaction — no longer sent to the model]`,
    };
  });
}

// ---- token estimation (self-calibrating) ----
// We have no tokenizer for Fugu, and Persian tokenizes at ~2-3 chars/token
// vs ~4 for English. But every API response reports exact prompt_tokens, so
// we keep a live EMA of tokens-per-char and calibrate ourselves for free.
const RATIO_KEY = "mahi_tokens_per_char";

function tokensPerChar(): number {
  const v = Number(localStorage.getItem(RATIO_KEY));
  return v > 0.05 && v < 2 ? v : 0.35; // conservative default
}

function updateTokenRatio(promptTokens: number, sentChars: number) {
  if (sentChars < 4000 || promptTokens <= 0) return; // too small to be meaningful
  const observed = promptTokens / sentChars;
  const next = 0.7 * tokensPerChar() + 0.3 * observed;
  localStorage.setItem(RATIO_KEY, String(next));
}

export function historyChars(history: Msg[]): number {
  let n = 0;
  for (const m of history) {
    n += m.content.length;
    if (m.tool_calls) for (const tc of m.tool_calls) n += tc.function.arguments.length + 40;
    // Rough token-equivalent padding for vision input — there's no real
    // tokenizer for this, but ignoring images entirely would badly
    // undercount the budget once any are attached.
    if (m.images?.length) n += m.images.length * 6000;
  }
  return n;
}

export function estimateTokens(chars: number): number {
  return Math.round(chars * tokensPerChar());
}

/// Mid-turn compaction: when the running history estimate crosses the budget
/// threshold, stub older bulky messages IN PLACE (replacing array slots, not
/// mutating the stored message objects). The most recent `keepRecent`
/// messages stay raw so the model keeps exact local context; the system
/// prompt (index 0) and all user messages are pinned.
function compactInPlaceKeepingRecent(history: Msg[], keepRecent: number): number {
  let saved = 0;
  const cutoff = Math.max(1, history.length - keepRecent);
  for (let i = 1; i < cutoff; i++) {
    const m = history[i];
    if (m.role === "user") continue; // pinned
    const stubbed = stubMsg(m);
    if (stubbed !== m) {
      saved += m.content.length - stubbed.content.length;
      history[i] = stubbed;
    }
  }
  return saved;
}

/// Repair a history whose previous turn was interrupted mid-flight: every
/// assistant tool_call must have a matching tool result or the API rejects
/// the request. Missing results get a synthetic "interrupted" entry.
export function sanitizeHistory(history: Msg[]): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < history.length; i++) {
    const m = history[i];
    out.push(m);
    if (m.role === "assistant" && m.tool_calls?.length) {
      const answered = new Set<string>();
      for (let j = i + 1; j < history.length && history[j].role === "tool"; j++) {
        answered.add(history[j].tool_call_id ?? "");
      }
      for (const tc of m.tool_calls) {
        if (!answered.has(tc.id)) {
          out.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "error: interrupted before this tool could run (connection lost). Re-issue the call if still needed.",
          });
        }
      }
    }
  }
  return out;
}

export async function agentTurn(
  client: OpenAI,
  model: string,
  workspace: string,
  history: Msg[],
  opts: AgentOptions
): Promise<void> {
  const backoffs = [3000, 8000, 20000, 45000];
  // Models love re-reading files they already have in context. Within one
  // turn, an identical re-read returns a one-line marker instead of paying
  // for the whole content again (in every subsequent call of the turn).
  const readSeen = new Map<string, string>();
  const budget = opts.contextBudget ?? 200_000;
  const protocol = providerProtocol(opts.chatProvider);
  const mcpTools = opts.mcpServers?.length ? await buildMcpTools(opts.mcpServers) : [];
  const callModelTools = opts.allowModelRouting ? [buildCallModelTool(opts.allProviders ?? [])] : [];
  const configuredTools = tools.filter((tool) => {
    const name = (tool as OpenAI.Chat.Completions.ChatCompletionFunctionTool).function.name;
    const role = MEDIA_TOOLS[name];
    if (!role || !opts.chatProvider) return true;
    const mediaProvider = findProviderForRole(
      opts.allProviders ?? [opts.chatProvider], role, opts.chatProvider,
      (candidate) => !!resolveMediaAdapter(candidate, role as "image" | "audio" | "video")
    );
    return !!mediaProvider.apiKey && !!resolveMediaAdapter(mediaProvider, role as "image" | "audio" | "video");
  });
  const activeTools = isBrowserToolsEnabled()
    ? [...configuredTools, ...alwaysOnTools(), ...BROWSER_TOOLS, ...mcpTools, ...callModelTools]
    : [...configuredTools, ...alwaysOnTools(), ...mcpTools, ...callModelTools];
  const validToolNames = new Set(
    activeTools.map((tool) => (tool as any).function?.name).filter(Boolean) as string[]
  );
  function normalizeToolName(name: string): string {
    if (validToolNames.has(name)) return name;
    // Repair legacy/current Gemini-stream corruption where the same complete
    // function name was appended once per chunk, e.g.
    // "glob_filesglob_filesglob_files". Without this, pressing Continue in an
    // already-corrupted chat would keep resending invalid assistant tool_calls
    // and Gemini would keep returning 400.
    for (const valid of validToolNames) {
      if (
        valid &&
        name.length > valid.length &&
        name.length % valid.length === 0 &&
        name === valid.repeat(name.length / valid.length)
      ) {
        return valid;
      }
    }
    return name;
  }
  const validEchoToolCallIds = new Set<string>();
  history = history.map((m) => {
    if (m.role !== "assistant" || !m.tool_calls?.length) return m;
    const tool_calls = m.tool_calls
      .map((tc) => ({
        ...tc,
        id: tc.id?.trim() || fallbackToolCallId(),
        function: {
          ...tc.function,
          name: normalizeToolName(tc.function.name),
          arguments: safeToolArguments(tc.function.arguments),
        },
      }))
      .filter((tc) => validToolNames.has(tc.function.name));
    for (const tc of tool_calls) validEchoToolCallIds.add(tc.id);
    if (tool_calls.length) return { ...m, tool_calls };
    return {
      ...m,
      content: m.content || "error: previous invalid tool call was omitted before sending context to the model.",
      tool_calls: undefined,
    };
  }).filter((m) => m.role !== "tool" || validEchoToolCallIds.has(m.tool_call_id ?? ""));
  // Some providers' chat endpoints flat-out reject image content in messages
  // (confirmed for Z.AI/GLM: a 400 on messages.content.type before the model
  // ever runs) — supportsVision === false means don't even try. The image(s)
  // still need to reach the model somehow, so each one is saved to a temp
  // file once per turn (cached here so repeat iterations of the same turn
  // don't re-save it) and its path is inlined into the message as plain
  // text, letting the model hand that path to a vision-capable MCP tool
  // instead of seeing it inline.
  const supportsVision = opts.chatProvider?.supportsVision !== false;
  const tempImagePaths = new Map<string, string>();
  async function imagesToPathNote(images: string[]): Promise<string> {
    const paths = await Promise.all(
      images.map(async (dataUrl) => {
        const cached = tempImagePaths.get(dataUrl);
        if (cached) return cached;
        const match = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
        const ext = match?.[1] === "jpeg" ? "jpg" : match?.[1] ?? "png";
        const base64 = match?.[2] ?? dataUrl.split(",").pop() ?? "";
        const path = await invoke<string>("save_temp_image", { base64Content: base64, extension: ext });
        tempImagePaths.set(dataUrl, path);
        return path;
      })
    );
    return `\n\n[${images.length} image(s) attached — this model can't see images directly in chat. If a vision-capable tool is available, use it on: ${paths.join(", ")}]`;
  }

  async function cleanupTempImages(): Promise<void> {
    await Promise.allSettled(
      Array.from(new Set(tempImagePaths.values())).map((path) => invoke("delete_temp_image", { path }))
    );
  }

  try {
    // Each iteration is a full re-bill of the conversation, so the cap is the
    // last defense against runaway spend. If a legit big task hits it, the
    // user resumes with the Continue button — nothing is lost.
    const MAX_ITERS = 24;
    for (let iter = 0; iter < MAX_ITERS; iter++) {
    // Mid-turn compaction: long turns are exactly where runaway usage
    // happens (dozens of calls, each resending everything). Trigger at 70%
    // of budget; escalate with a smaller raw window if still over.
    let chars = historyChars(history);
    if (estimateTokens(chars) > 0.7 * budget) {
      const saved = compactInPlaceKeepingRecent(history, 20);
      chars -= saved;
      if (estimateTokens(chars) > 0.9 * budget) {
        chars -= compactInPlaceKeepingRecent(history, 10);
      }
      if (saved > 0) {
        opts.onNotice?.(t("compacted"));
        setTimeout(() => opts.onNotice?.(""), 2500);
      }
    }
    const sentChars = chars;

    // Build strict Chat Completions messages. Our in-app Msg carries UI/local
    // bookkeeping fields (toolName/toolArgs/checkpointId/images) that are not
    // part of the OpenAI schema; some providers ignore extras, but Gemini's
    // OpenAI-compatible endpoint is stricter and can reject them with 400.
    const apiMessages = await Promise.all(
      history.map(async (m) => {
        if (m.role === "assistant") {
          const out: any = { role: "assistant" };
          if (m.tool_calls?.length) {
            out.tool_calls = m.tool_calls.map((tc) => {
              const wire: any = {
                id: tc.id?.trim() || fallbackToolCallId(),
                type: "function",
                function: {
                  name: tc.function.name,
                  arguments: safeToolArguments(tc.function.arguments),
                },
              };
              if (protocol === "gemini-chat" && tc.providerMeta?.geminiThoughtSignature) {
                wire.extra_content = { google: { thought_signature: tc.providerMeta.geminiThoughtSignature } };
              }
              return wire;
            });
            // Tool-only assistant turns have no textual content. Tried both
            // content: null and omitting the key entirely (see VERSION_LOG
            // 1.3.6/1.3.7) — both still 400'd on Gemini's follow-up request
            // after a tool result, which means content-shape wasn't the
            // actual culprit (see the missing `name` field below). Keeping
            // content always present as a plain string is the one variant
            // that was never tried in isolation; safe for every other
            // provider regardless.
            out.content = m.content || "";
          } else {
            out.content = m.content;
          }
          return out;
        }
        if (m.role === "tool") {
          // Same strictness applies to tool results: an empty content string
          // can be rejected. Send a short placeholder so no tool message ever
          // leaves with an empty body.
          return { role: "tool", tool_call_id: m.tool_call_id, content: m.content || "(no output)", name: m.toolName };
        }
        if (m.images?.length) {
          if (supportsVision) {
            return {
              role: m.role,
              content: [
                ...(m.content ? [{ type: "text", text: m.content }] : []),
                ...m.images.map((url) => ({ type: "image_url", image_url: { url } })),
              ],
            };
          }
          return { role: m.role, content: `${m.content}${await imagesToPathNote(m.images)}` };
        }
        return { role: m.role, content: m.content };
      })
    );

    const responsesInput: any[] = [];
    if (protocol === "openai-responses") {
      for (const m of history) {
        if (m.role === "assistant") {
          if (m.providerMeta?.openaiResponseItems?.length) {
            responsesInput.push(...m.providerMeta.openaiResponseItems);
          } else {
            if (m.content) responsesInput.push({ role: "assistant", content: m.content });
            for (const tc of m.tool_calls ?? []) {
              responsesInput.push({
                type: "function_call",
                call_id: tc.id,
                name: tc.function.name,
                arguments: safeToolArguments(tc.function.arguments),
              });
            }
          }
          continue;
        }
        if (m.role === "tool") {
          responsesInput.push({
            type: "function_call_output",
            call_id: m.tool_call_id,
            output: m.content || "(no output)",
          });
          continue;
        }
        if (m.images?.length && supportsVision) {
          responsesInput.push({
            role: m.role,
            content: [
              ...(m.content ? [{ type: "input_text", text: m.content }] : []),
              ...m.images.map((image_url) => ({ type: "input_image", image_url, detail: "auto" })),
            ],
          });
        } else if (m.images?.length) {
          responsesInput.push({ role: m.role, content: `${m.content}${await imagesToPathNote(m.images)}` });
        } else {
          responsesInput.push({ role: m.role, content: m.content });
        }
      }
    }

    const params: any = protocol === "openai-responses"
      ? {
          model,
          input: responsesInput,
          tools: toResponsesTools(activeTools),
          stream: !model.includes("-pro"),
          store: false,
          include: ["reasoning.encrypted_content"],
        }
      : {
          model,
          messages: apiMessages,
          tools: activeTools,
          stream: true,
          stream_options: { include_usage: true },
        };
    applyReasoningParams(params, opts.chatProvider, model, opts.reasoningEffort);
    if (opts.temperature !== undefined && shouldSendTemperature(opts.chatProvider, model)) {
      params.temperature = opts.temperature;
    }

    let content = "";
    const callMap = new Map<string, { id?: string; name: string; arguments: string; order: number; geminiThoughtSignature?: string }>();
    let openaiResponseItems: any[] | undefined;

    // One model call, with automatic backoff-and-retry on transient failures
    // (rate limit exhausted, server overloaded, connection drop). Nothing is
    // committed to history until the stream completes, so a retry is safe.
    let attempt = 0;
    while (true) {
      content = "";
      callMap.clear();
      openaiResponseItems = undefined;
      try {
        if (protocol === "openai-responses") {
          const ingestResponse = (completed: any) => {
            if (!completed) return;
            if (completed.status === "failed") throw new Error(completed.error?.message || "OpenAI response failed");
            openaiResponseItems = completed.output ?? [];
            content = completed.output_text ?? content;
            for (const item of completed.output ?? []) {
              if (item.type !== "function_call") continue;
              const key = `response:${item.call_id || item.id}`;
              callMap.set(key, {
                id: item.call_id || item.id,
                name: item.name || "",
                arguments: item.arguments || "{}",
                order: callMap.size,
              });
            }
            if (completed.usage) {
              updateTokenRatio(completed.usage.input_tokens, sentChars);
              opts.onUsage({
                prompt_tokens: completed.usage.input_tokens ?? 0,
                completion_tokens: completed.usage.output_tokens ?? 0,
                total_tokens: completed.usage.total_tokens ?? 0,
                cached_tokens: completed.usage.input_tokens_details?.cached_tokens ?? 0,
              });
            }
            opts.onDelta(content);
          };

          if (model.includes("-pro")) {
            const backgroundParams = { ...params, stream: false, background: true, store: true };
            let completed: any = await client.responses.create(backgroundParams, { signal: opts.signal });
            while (completed.status === "queued" || completed.status === "in_progress") {
              opts.onNotice?.(t("working"));
              await sleep(2000, opts.signal);
              completed = await client.responses.retrieve(completed.id, {}, { signal: opts.signal });
            }
            opts.onNotice?.("");
            ingestResponse(completed);
            client.responses.delete(completed.id).catch(() => {});
          } else {
            const runner = client.responses.create(params, { signal: opts.signal });
            const { data: stream, response } = await (runner as any).withResponse();
            if (opts.onHeaders && response?.headers?.forEach) {
              const h: Record<string, string> = {};
              response.headers.forEach((value: string, key: string) => { h[key] = value; });
              opts.onHeaders(h);
            }
            for await (const event of stream as any) {
              if (event.type === "response.output_text.delta") {
                content += event.delta;
                opts.onDelta(content);
              } else if (event.type === "response.completed") {
                ingestResponse(event.response);
              } else if (event.type === "response.failed") {
                throw new Error(event.response?.error?.message || "OpenAI response failed");
              }
            }
          }
        } else if (protocol === "custom-json" && opts.chatProvider?.customAdapter) {
          const customProvider = opts.chatProvider;
          const adapter = customProvider.customAdapter!;
          const ingestCustomChunk = (chunk: any, final = false) => {
            const text = getPath(chunk, final ? adapter.responseTextPath : adapter.streamTextPath);
            if (typeof text === "string" && text) {
              content += text;
              opts.onDelta(content);
            }
            const calls = getPath(chunk, adapter.toolCallsPath);
            if (Array.isArray(calls)) {
              for (const tc of calls) {
                const key = tc.index !== undefined && tc.index !== null ? `index:${tc.index}` : tc.id ? `id:${tc.id}` : `fallback:${callMap.size}`;
                const existing = callMap.get(key) ?? { name: "", arguments: "", order: callMap.size };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments = mergeToolArguments(existing.arguments, tc.function.arguments);
                callMap.set(key, existing);
              }
            }
            const usage = getPath(chunk, adapter.usagePath);
            if (usage) opts.onUsage({
              prompt_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
              completion_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0,
              total_tokens: usage.total_tokens ?? ((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)),
            });
          };
          const request = customRequest(customProvider, {
            model, messages: apiMessages, tools: activeTools,
            stream: adapter.streamMode === "sse", temperature: params.temperature,
            reasoning: params.reasoning_effort ?? params.reasoning ?? params.thinking,
          });
          const response = await tauriFetch(request.url, {
            method: "POST", headers: request.headers, body: JSON.stringify(request.body), signal: opts.signal,
          });
          if (opts.onHeaders) {
            const headers: Record<string, string> = {};
            response.headers.forEach((value, key) => { headers[key] = value; });
            opts.onHeaders(headers);
          }
          if (!response.ok) {
            const errorPayload: any = await response.json().catch(() => ({}));
            throw new Error(getPath(errorPayload, adapter.errorPath) || `HTTP ${response.status}`);
          }
          if (adapter.streamMode === "json") {
            ingestCustomChunk(await response.json(), true);
          } else {
            const reader = response.body?.getReader();
            if (!reader) throw new Error("Custom provider returned no response stream");
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
              const { done, value } = await reader.read();
              buffer += decoder.decode(value, { stream: !done });
              const blocks = buffer.split(/\r?\n\r?\n/);
              buffer = blocks.pop() ?? "";
              for (const block of blocks) {
                for (const line of block.split(/\r?\n/)) {
                  if (!line.startsWith("data:")) continue;
                  const raw = line.slice(5).trim();
                  if (!raw || raw === "[DONE]") continue;
                  try { ingestCustomChunk(JSON.parse(raw)); } catch { /* ignore non-JSON SSE events */ }
                }
              }
              if (done) break;
            }
          }
        } else {
          // .withResponse() exposes raw HTTP headers, where compatible APIs
          // report real rate-limit / usage windows.
          const runner = client.chat.completions.create(params, { signal: opts.signal });
          const { data: stream, response } = await (runner as any).withResponse();
          if (opts.onHeaders && response?.headers?.forEach) {
            const h: Record<string, string> = {};
            response.headers.forEach((value: string, key: string) => { h[key] = value; });
            opts.onHeaders(h);
          }

          for await (const chunk of stream as any) {
            const choice = chunk.choices?.[0];
            const delta = choice?.delta;
            if (delta?.content) {
              content += delta.content;
              opts.onDelta(content);
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const key = tc.index !== undefined && tc.index !== null
                  ? `index:${tc.index}`
                  : tc.id
                    ? `id:${tc.id}`
                    : `fallback:${callMap.size}`;
                const existing = callMap.get(key) ?? { name: "", arguments: "", order: callMap.size };
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.arguments = mergeToolArguments(existing.arguments, tc.function.arguments);
                const signature = tc.extra_content?.google?.thought_signature;
                if (typeof signature === "string" && signature) existing.geminiThoughtSignature = signature;
                callMap.set(key, existing);
              }
            }
            if (chunk.usage) {
              updateTokenRatio(chunk.usage.prompt_tokens, sentChars);
              opts.onUsage({
                prompt_tokens: chunk.usage.prompt_tokens,
                completion_tokens: chunk.usage.completion_tokens,
                total_tokens: chunk.usage.total_tokens,
                cached_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
              });
            }
          }
        }
        break; // stream completed
      } catch (e: any) {
        if (opts.signal?.aborted || e?.name === "AbortError") throw e;
        // Any 429 that states its reset time is ground truth for the local
        // usage-window tracker — record it even if we're about to give up.
        const knownReset = resetDelayFromError(e);
        if (knownReset !== null) reportRateLimitReset(new Date(Date.now() + knownReset));
        if (attempt >= backoffs.length || !isRetryable(e)) throw e;
        // Quota-window errors state their reset time. If it's soon, wait for
        // it exactly; if it's far, fail fast so the user gets the Continue
        // button instead of doomed retries.
        const resetMs = knownReset;
        if (resetMs !== null && resetMs > 90_000) throw e;
        const wait = resetMs !== null ? resetMs + 2000 : backoffs[attempt];
        attempt++;
        opts.onNotice?.(
          `${t("retrying")} ${Math.round(wait / 1000)}${t("seconds")}`
        );
        await sleep(wait, opts.signal);
        opts.onNotice?.("");
      }
    }

    const invalidToolNames: string[] = [];
    const toolCalls: ToolCall[] = Array.from(callMap.entries())
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([, v]) => ({
        id: v.id?.trim() || fallbackToolCallId(),
        type: "function" as const,
        function: { name: normalizeToolName(v.name), arguments: safeToolArguments(v.arguments) },
        providerMeta: v.geminiThoughtSignature ? { geminiThoughtSignature: v.geminiThoughtSignature } : undefined,
      }))
      .filter((tc) => {
        if (validToolNames.has(tc.function.name)) return true;
        invalidToolNames.push(tc.function.name || "(empty)");
        return false;
      });
    if (invalidToolNames.length) {
      content += `${content ? "\n\n" : ""}error: model produced invalid tool call name(s): ${invalidToolNames.join(", ")}.`;
    }

    const assistantMsg: Msg = {
      role: "assistant",
      content,
      tool_calls: toolCalls.length ? toolCalls : undefined,
      providerMeta: (openaiResponseItems as any[] | undefined)?.length ? { openaiResponseItems } : undefined,
    };
    history.push(assistantMsg);
    opts.onStep(assistantMsg);

    if (toolCalls.length === 0) {
      return;
    }

    for (const call of toolCalls) {
      let args: any = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        // leave args empty if the model produced malformed JSON
      }

      let result: string;
      if (call.function.name === "open_file_in_editor") {
        if (!opts.openFile) {
          result = "error: this chat's project isn't the folder currently open in the IDE, so there's no tab strip to open it in.";
        } else {
          opts.openFile(args.path, args.line);
          result = `ok: opened ${args.path} in the IDE editor`;
        }
      } else if (call.function.name === "view_screen") {
        if (!opts.browserControl) {
          result = "error: screen capture is not available right now";
        } else {
          const b64 = await opts.browserControl.screenshot();
          opts.onScreenshot?.(call.id, b64);
          result = "ok: screenshot captured (shown to the user in this tool card — you cannot see it yourself)";
        }
      } else if (call.function.name === "transcribe_media") {
        const modelId = loadActiveAsrModel();
        if (!modelId) {
          result = "error: no local Whisper model installed — open Settings → Local AI Models to download one";
        } else {
          try {
            const r = await invoke("transcribe_media", {
              workspace,
              path: args.path,
              modelId,
              language: args.language,
            });
            result = JSON.stringify(r);
          } catch (e) {
            result = `error: ${String(e)}`;
          }
        }
      } else if (call.function.name === "generate_music" || call.function.name === "generate_sound_effect") {
        const approved = await opts.requestApproval(call.function.name, args);
        if (!approved) {
          result = "Rejected by user. Do not retry this exact action without asking.";
        } else {
          try {
            if (!String(args.path ?? "").toLowerCase().endsWith(".mp3")) throw new Error("output path must end in .mp3");
            await recordCheckpoint(workspace, opts.checkpointId, args.path);
            if (call.function.name === "generate_music") {
              await generateElevenLabsMusic(workspace, args, opts.signal);
              result = `ok: music saved to ${args.path}`;
            } else {
              await generateElevenLabsSoundEffect(workspace, args, opts.signal);
              result = `ok: sound effect saved to ${args.path}`;
            }
          } catch (e) {
            result = `error: ${String(e)}`;
          }
        }
      } else if (call.function.name === "speak_text") {
        const ttsBackend = loadTtsBackend();
        const voiceId = args.voice_id || loadVoiceForLang(getLang());
        if (ttsBackend === "local" && !voiceId) {
          result = "error: no local voice installed for the current language — open Settings → Local AI Models to download one";
        } else {
          const approved = await opts.requestApproval(call.function.name, args);
          if (!approved) {
            result = "Rejected by user. Do not retry this exact action without asking.";
          } else {
            try {
              await recordCheckpoint(workspace, opts.checkpointId, args.path);
              if (ttsBackend === "elevenlabs") {
                await synthesizeElevenLabs(workspace, args.text, args.path);
              } else {
                await invoke("synthesize_speech", {
                  workspace,
                  text: args.text,
                  voiceId,
                  outPath: args.path,
                });
              }
              result = `ok: speech saved to ${args.path}`;
            } catch (e) {
              result = `error: ${String(e)}`;
            }
          }
        }
      } else if (call.function.name === "call_model") {
        const approved = await opts.requestApproval(call.function.name, args);
        result = approved
          ? await runCallModelTool(opts.allProviders ?? [], args)
          : "Rejected by user. Do not retry this exact action without asking.";
      } else if (call.function.name in MEDIA_TOOLS) {
        const approved = await opts.requestApproval(call.function.name, args);
        if (!approved) {
          result = "Rejected by user. Do not retry this exact action without asking.";
        } else if (!opts.chatProvider) {
          result = "error: no provider available to route this media tool";
        } else {
          const role = MEDIA_TOOLS[call.function.name];
          const roleProvider = findProviderForRole(
            opts.allProviders ?? [], role, opts.chatProvider,
            (candidate) => !!resolveMediaAdapter(candidate, role as "image" | "audio" | "video")
          );
          result = await runMediaTool(roleProvider, workspace, call.function.name, args, opts.checkpointId, opts.signal, opts.onNotice);
        }
      } else if (BROWSER_TOOL_NAMES.has(call.function.name)) {
        const onScreenshot = opts.onScreenshot ? (b64: string) => opts.onScreenshot!(call.id, b64) : undefined;
        if (SENSITIVE_TOOLS.has(call.function.name)) {
          const approved = await opts.requestApproval(call.function.name, args);
          result = approved
            ? await runBrowserTool(opts.browserControl, call.function.name, args, onScreenshot)
            : "Rejected by user. Do not retry this exact action without asking.";
        } else {
          result = await runBrowserTool(opts.browserControl, call.function.name, args, onScreenshot);
        }
      } else if (SENSITIVE_TOOLS.has(call.function.name)) {
        const approved = await opts.requestApproval(call.function.name, args);
        result = approved
          ? await runTool(workspace, call.function.name, args, opts.checkpointId, opts.skillRoots)
          : "Rejected by user. Do not retry this exact action without asking.";
        // The file changed; a later re-read must return fresh content.
        if (approved && args?.path) readSeen.delete(args.path);
        if (approved && args?.to) readSeen.delete(args.to);
      } else if (isMcpToolName(call.function.name)) {
        const identity = mcpToolIdentity(call.function.name);
        const bundleId = identity ? STUDIO_WINDOW_BUNDLES[identity.serverId] : undefined;
        const verify = !!bundleId && !!identity && shouldVerifyStudioTool(identity.toolName);
        const baseline = verify ? await prepareStudioVerification(bundleId!) : null;
        const dialogAbort = new AbortController();
        const knownWindowIds = baseline
          ? (await listAllowedWindows().catch(() => []))
              .filter((window) => window.bundleId === bundleId)
              .map((window) => window.windowId)
          : [];
        const dialogWatch = baseline
          ? watchForNewDialogSessions(bundleId!, knownWindowIds, dialogAbort.signal)
          : Promise.resolve([]);

        try {
          result = await runMcpTool(opts.mcpServers ?? [], call.function.name, args);

          if (baseline) {
            const verification = await finishStudioVerification(baseline, 3000);
            dialogAbort.abort();
            const dialogSessions = await dialogWatch;
            const dialogs = [];
            for (const session of dialogSessions) {
              const captured = await captureObservedWindow(session.sessionId).catch(() => session);
              dialogs.push({
                sessionId: captured.sessionId,
                status: captured.status,
                imagePath: captured.imagePath,
                revision: captured.revision,
              });
              await stopWindowObservation(session.sessionId).catch(() => {});
            }
            result += `\n\nWindow Vision verification: ${JSON.stringify({
              changed: verification?.changed ?? false,
              status: verification?.status ?? "unavailable",
              revision: verification?.revision ?? baseline.revision,
              changeScore: verification?.changeScore ?? 0,
              imagePath: verification?.imagePath || baseline.imagePath || "",
              dialogs,
            })}`;
          }
        } finally {
          dialogAbort.abort();
        }
      } else {
        result = await runTool(workspace, call.function.name, args, opts.checkpointId, opts.skillRoots);
        if (call.function.name === "read_file" && args?.path) {
          if (readSeen.get(args.path) === result) {
            result = "(unchanged — identical to the earlier read_file of this path above; refer to that.)";
          } else {
            readSeen.set(args.path, result);
          }
        }
      }

      const toolMsg: Msg = {
        role: "tool",
        tool_call_id: call.id,
        content: result,
        toolName: call.function.name,
        toolArgs: args,
      };
      history.push(toolMsg);
      opts.onStep(toolMsg);
    }
  }

    // Cap reached mid-task: surface it as an interruption so the Continue
    // button appears (the ⚠️ prefix is what canContinue/continueTurn key on).
    opts.onStep({
      role: "assistant",
      content: t("iterCap"),
    });
  } finally {
    await cleanupTempImages();
  }
}
