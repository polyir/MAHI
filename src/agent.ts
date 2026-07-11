import OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { reportRateLimitReset } from "./ide/limits";
import { t } from "./ide/i18n";
import { Provider, ProviderRole, findProviderForRole, isBrowserToolsEnabled, LOCAL_PROVIDER_ID } from "./ide/providers";
import { loadActiveAsrModel, loadTtsBackend, loadVoiceForLang } from "./ide/models";
import { getLang } from "./ide/i18n";
import { synthesizeElevenLabs } from "./ide/elevenlabs";
import { McpServer, buildMcpTools, isMcpToolName, runMcpTool } from "./ide/mcp";

export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
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
};

export type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  // Input tokens served from the provider's prompt cache (billed ~10x
  // cheaper by Sakana). Optional: only present when the API reports it.
  cached_tokens?: number;
};

// Sakana Fugu only accepts these reasoning_effort values.
export type ReasoningEffort = "high" | "xhigh" | "max";
export const REASONING_EFFORTS: ReasoningEffort[] = ["high", "xhigh", "max"];

export function sanitizeEffort(v: any): ReasoningEffort {
  return REASONING_EFFORTS.includes(v) ? v : "high";
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

// Tool calls that mutate the filesystem or run arbitrary shell commands
// require explicit user approval before executing, unless auto-approve is on.
export const SENSITIVE_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "run_command",
  "generate_image",
  "generate_audio",
  "generate_video",
  "browser_navigate",
  "browser_close",
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
]);

// File-mutating tools snapshot the previous state into the turn's checkpoint
// so the user can revert the whole turn.
const CHECKPOINTED_TOOLS = new Set(["write_file", "edit_file", "delete_file", "move_file"]);

// Tool name -> which provider role should serve it, when role routing is on.
const MEDIA_TOOLS: Record<string, ProviderRole> = {
  generate_image: "image",
  generate_audio: "audio",
  generate_video: "video",
};

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
  return [
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
  ];
}

// Only appended to the request when isBrowserToolsEnabled() is on (Settings
// → Providers). There is no browser_read/click/type: the embedded browser is
// a plain iframe, and cross-origin iframe content is invisible to the parent
// page's JS by browser security design — so these tools are deliberately
// view-and-navigate only, not automation.
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
        "Take a screenshot of the whole MAHI window, including the active embedded browser tab if one is open, so the user can see what's currently on screen. This is view-only for you: you will NOT receive the image back (no vision input) and there is no way to read the page's text or click/type into it — use it purely to let the user look at the current state, not to inspect page content yourself.",
      parameters: { type: "object", properties: {} },
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
  checkpointId?: number
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

/// Media-generation tools run against whichever provider owns that role
/// (see findProviderForRole), which may differ from the chat provider —
/// so they build their own short-lived client rather than reusing runTool's.
async function runMediaTool(
  provider: Provider,
  workspace: string,
  name: string,
  args: any,
  checkpointId?: number
): Promise<string> {
  try {
    const client = makeClient(provider.apiKey, provider.baseURL);
    if (name === "generate_image") {
      const model = provider.imageModel || provider.models[0];
      const resp = await client.images.generate({
        model,
        prompt: args.prompt,
        size: args.size,
        response_format: "b64_json",
      } as any);
      const b64 = (resp.data?.[0] as any)?.b64_json;
      if (!b64) return "error: provider did not return image data (it may not support image generation)";
      await recordCheckpoint(workspace, checkpointId, args.path);
      await invoke("write_file_binary", { workspace, path: args.path, base64Content: b64 });
      return `ok: image saved to ${args.path} (via provider "${provider.name}")`;
    }
    if (name === "generate_audio") {
      const model = provider.audioModel || provider.models[0];
      const resp = await client.audio.speech.create({
        model,
        voice: (args.voice || "alloy") as any,
        input: args.text,
      });
      const buf = new Uint8Array(await resp.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
      const b64 = btoa(binary);
      await recordCheckpoint(workspace, checkpointId, args.path);
      await invoke("write_file_binary", { workspace, path: args.path, base64Content: b64 });
      return `ok: audio saved to ${args.path} (via provider "${provider.name}")`;
    }
    if (name === "generate_video") {
      return "error: video generation is not supported by the OpenAI-compatible SDK surface — no standard endpoint exists yet for this provider.";
    }
    return `unknown media tool: ${name}`;
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

// call_model: lets the current turn's model delegate a sub-task to a
// DIFFERENT configured provider/model (e.g. a Skill/Workflow markdown file
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
        `Delegate a sub-task to a different configured model — use only when explicitly instructed to (e.g. a workflow/skill file naming a specific model for a specific step), not on your own initiative. Returns that model's plain text reply; it has no tools of its own and cannot see this conversation's history, so include everything it needs in the prompt. Available provider_id/model combinations: ${available || "(none configured with an API key)"}.`,
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
    const client = makeClient(provider.apiKey, provider.baseURL);
    const resp = await client.chat.completions.create({
      model: args.model,
      messages: [
        ...(args.system_prompt ? [{ role: "system" as const, content: args.system_prompt }] : []),
        { role: "user" as const, content: args.prompt },
      ],
    });
    const text = resp.choices?.[0]?.message?.content;
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
    const stubbed = m.role !== "user" ? stubMsg(m) : m;
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
  const mcpTools = opts.mcpServers?.length ? await buildMcpTools(opts.mcpServers) : [];
  const callModelTools = opts.allowModelRouting ? [buildCallModelTool(opts.allProviders ?? [])] : [];
  const activeTools = isBrowserToolsEnabled()
    ? [...tools, ...alwaysOnTools(), ...BROWSER_TOOLS, ...mcpTools, ...callModelTools]
    : [...tools, ...alwaysOnTools(), ...mcpTools, ...callModelTools];
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
  for (const m of history) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) tc.function.name = normalizeToolName(tc.function.name);
    }
  }
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
          const out: any = { role: "assistant", content: m.content };
          if (m.tool_calls?.length) {
            out.tool_calls = m.tool_calls;
            // A tool-only assistant turn has content "" here. Gemini's
            // OpenAI-compat endpoint is strict and rejects an empty string on
            // an assistant message that carries tool_calls with a bare 400
            // (no body) — it expects null. This is exactly the failure that
            // only surfaces on the SECOND call of a turn, once the tool-call
            // assistant message is echoed back in history. Other providers
            // (e.g. Sakana) accept null too, so this is safe everywhere.
            if (!m.content) out.content = null;
          }
          return out;
        }
        if (m.role === "tool") {
          // Same strictness applies to tool results: an empty content string
          // can be rejected. Send a short placeholder so no tool message ever
          // leaves with an empty body.
          return { role: "tool", tool_call_id: m.tool_call_id, content: m.content || "(no output)" };
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

    const params: any = {
      model,
      messages: apiMessages,
      tools: activeTools,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.reasoningEffort) params.reasoning_effort = opts.reasoningEffort;
    if (opts.temperature !== undefined && shouldSendTemperature(opts.chatProvider, model)) {
      params.temperature = opts.temperature;
    }

    let content = "";
    const callMap = new Map<number, { id?: string; name: string; arguments: string }>();

    // One model call, with automatic backoff-and-retry on transient failures
    // (rate limit exhausted, server overloaded, connection drop). Nothing is
    // committed to history until the stream completes, so a retry is safe.
    let attempt = 0;
    while (true) {
      content = "";
      callMap.clear();
      try {
        // .withResponse() exposes raw HTTP headers, where OpenAI-compatible
        // APIs report real rate-limit / usage windows.
        const runner = client.chat.completions.create(params, { signal: opts.signal });
        const { data: stream, response } = await (runner as any).withResponse();
        if (opts.onHeaders && response?.headers?.forEach) {
          const h: Record<string, string> = {};
          response.headers.forEach((value: string, key: string) => {
            h[key] = value;
          });
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
              const idx = tc.index ?? 0;
              const existing = callMap.get(idx) ?? { name: "", arguments: "" };
              if (tc.id) existing.id = tc.id;
              // OpenAI streams a tool call's name ONCE (first chunk) and only
              // streams `arguments` incrementally afterwards. Google's Gemini
              // OpenAI-compat layer instead repeats the FULL function name in
              // EVERY streamed chunk of the same call. Appending it produced
              // mangled names like "glob_filesglob_filesglob_files", which the
              // API then rejects with a bare 400 once the corrupt tool_call is
              // echoed back in history. Assign (not append) so both incremental
              // (OpenAI) and repeated-full (Gemini) streaming yield one clean
              // name — a function name is never split across chunks.
              if (tc.function?.name) existing.name = tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              callMap.set(idx, existing);
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

    const toolCalls: ToolCall[] = Array.from(callMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([, v]) => ({
        id: v.id ?? `call_${Math.random().toString(36).slice(2)}`,
        type: "function" as const,
        function: { name: v.name, arguments: v.arguments },
      }));

    const assistantMsg: Msg = {
      role: "assistant",
      content,
      tool_calls: toolCalls.length ? toolCalls : undefined,
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
          const roleProvider = findProviderForRole(opts.allProviders ?? [], role, opts.chatProvider);
          result = await runMediaTool(roleProvider, workspace, call.function.name, args, opts.checkpointId);
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
          ? await runTool(workspace, call.function.name, args, opts.checkpointId)
          : "Rejected by user. Do not retry this exact action without asking.";
        // The file changed; a later re-read must return fresh content.
        if (approved && args?.path) readSeen.delete(args.path);
        if (approved && args?.to) readSeen.delete(args.to);
      } else if (isMcpToolName(call.function.name)) {
        result = await runMcpTool(opts.mcpServers ?? [], call.function.name, args);
      } else {
        result = await runTool(workspace, call.function.name, args, opts.checkpointId);
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
