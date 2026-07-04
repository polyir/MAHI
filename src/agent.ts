import OpenAI from "openai";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { reportRateLimitReset } from "./ide/limits";
import { t } from "./ide/i18n";
import { Provider, ProviderRole, findProviderForRole } from "./ide/providers";

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
]);

// File-mutating tools snapshot the previous state into the turn's checkpoint
// so the user can revert the whole turn. Media-generation tools are
// deliberately NOT included: checkpoint_record reads the "before" content as
// UTF-8 text, so on a binary file it silently records "did not exist" and a
// revert would DELETE the file instead of restoring its bytes. Until
// checkpoint.rs gets a binary-safe snapshot, generated media is excluded
// from turn-revert rather than risk destroying it.
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
        await invoke("checkpoint_record", { workspace, id: checkpointId, path: p }).catch(() => {});
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
async function runMediaTool(provider: Provider, workspace: string, name: string, args: any): Promise<string> {
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
  return messages.map((m, i) => (i < lastUserIdx && m.role !== "user" ? stubMsg(m) : m));
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

    const params: any = {
      model,
      messages: history,
      tools,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.reasoningEffort) params.reasoning_effort = opts.reasoningEffort;
    if (opts.temperature !== undefined) params.temperature = opts.temperature;

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
              if (tc.function?.name) existing.name += tc.function.name;
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
      if (call.function.name in MEDIA_TOOLS) {
        const approved = await opts.requestApproval(call.function.name, args);
        if (!approved) {
          result = "Rejected by user. Do not retry this exact action without asking.";
        } else if (!opts.chatProvider) {
          result = "error: no provider available to route this media tool";
        } else {
          const role = MEDIA_TOOLS[call.function.name];
          const roleProvider = findProviderForRole(opts.allProviders ?? [], role, opts.chatProvider);
          result = await runMediaTool(roleProvider, workspace, call.function.name, args);
        }
      } else if (SENSITIVE_TOOLS.has(call.function.name)) {
        const approved = await opts.requestApproval(call.function.name, args);
        result = approved
          ? await runTool(workspace, call.function.name, args, opts.checkpointId)
          : "Rejected by user. Do not retry this exact action without asking.";
        // The file changed; a later re-read must return fresh content.
        if (approved && args?.path) readSeen.delete(args.path);
        if (approved && args?.to) readSeen.delete(args.to);
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
}
