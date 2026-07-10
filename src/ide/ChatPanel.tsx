import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Plus,
  History,
  Settings2,
  Send,
  Square,
  AtSign,
  Undo2,
  Bot,
  RotateCw,
  Briefcase,
  FolderPlus,
  Trash2,
  Mic,
  Wand2,
  FlaskConical,
} from "lucide-react";
import {
  agentTurn,
  makeClient,
  Msg,
  Usage,
  sanitizeEffort,
  sanitizeHistory,
  compactHistory,
  BrowserControl,
  estimateTokens,
  historyChars,
} from "../agent";
import { isElevenLabsAsrEnabled, loadActiveAsrModel } from "./models";
import { transcribeElevenLabs } from "./elevenlabs";
import { FILE_DRAG_MIME, readFileDragData } from "./fileOps";
import FishLoader from "./FishLoader";
import { recordUsage } from "./limits";
import { notifyTaskDone } from "./completion";
import Message from "../components/Message";
import ApprovalModal, { PendingApproval } from "../components/ApprovalModal";
import SettingsModal, { SessionSettings } from "../components/SettingsModal";
import PromptLabModal from "./PromptLabModal";
import type { Session } from "./sessions";
import { loadSessions, loadSessionsFromFile, saveSessionsToFile, newSession, SESSIONS_KEY, ACTIVE_KEY } from "./sessions";
import type { Project } from "./projects";
import { loadProjects, saveProjects, loadActiveProjectId, saveActiveProjectId, newProject } from "./projects";
import type { Provider } from "./providers";
import { LOCAL_PROVIDER_ID } from "./providers";
import {
  loadLocalCtxOverride,
  localPromptBudget,
  chatTitle,
  cleanDictation,
  dictationCleanupSystem,
  improvePrompt,
  improvePromptSystem,
  isDictationCleanupEnabled,
  isSuggestionsEnabled,
  loadDictationModel,
  loadDictationProviderId,
  loadImproveModel,
  loadImproveProviderId,
  suggestReplies,
  summarizeAttachment,
  summarizeHistory,
} from "./localLlm";
import { t, useLang, dir as uiDir, getLang } from "./i18n";

const MAX_ATTACH_CHARS = 8000;
const TURN_MUTATION_TOOLS = new Set([
  "write_file",
  "edit_file",
  "delete_file",
  "move_file",
  "generate_image",
  "generate_audio",
  "speak_text",
]);
const TREE_MUTATION_TOOLS = new Set([
  "write_file",
  "delete_file",
  "move_file",
  "generate_image",
  "generate_audio",
  "speak_text",
]);

export default function ChatPanel({
  provider,
  providers,
  model,
  workspace,
  onFileChanged,
  onUsageChange,
  onHeaders,
  toast,
  browserControl,
  openTabs,
  activeTabPath,
  onOpenFileForAgent,
  onOpenModels,
}: {
  provider: Provider;
  providers: Provider[];
  model: string;
  workspace: string;
  onFileChanged: (relPath: string) => void;
  onUsageChange: (total: number) => void;
  onHeaders: (headers: Record<string, string>) => void;
  toast: (text: string, kind?: "ok" | "err") => void;
  browserControl: BrowserControl;
  // The IDE's own open tabs (independent of this chat's project — see the
  // projectDir === workspace guard below), so the agent can be told about
  // "the file I have open" and open new tabs itself.
  openTabs: string[];
  activeTabPath: string | null;
  onOpenFileForAgent: (relPath: string, line?: number) => void;
  // Opens Settings → Local AI Models — used when the user picks the local
  // provider/model but hasn't downloaded it yet.
  onOpenModels: () => void;
}) {
  useLang();
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [activeProjectId, setActiveProjectId] = useState<string>(loadActiveProjectId);
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0];
  // The directory this chat's tool calls operate on — independent of
  // `workspace` (the IDE's own open-folder), which is only used below to
  // decide whether an agent file-change should also refresh the IDE tree.
  const projectDir = activeProject?.directory ?? "";

  const [sessions, setSessions] = useState<Session[]>(() => {
    const s = loadSessions();
    return s.length ? s : [newSession(loadActiveProjectId())];
  });
  const [activeId, setActiveId] = useState<string>(() => localStorage.getItem(ACTIVE_KEY) ?? "");
  // Draft is persisted per-session so it survives panel remounts and app
  // restarts (the user reported losing unsent prompts on layout changes).
  const [input, setInputRaw] = useState("");
  const setInput = (v: string | ((cur: string) => string)) => {
    setInputRaw((cur) => {
      const next = typeof v === "function" ? v(cur) : v;
      const key = `vibe_draft_${localStorage.getItem(ACTIVE_KEY) ?? ""}`;
      if (next) localStorage.setItem(key, next);
      else localStorage.removeItem(key);
      return next;
    });
  };
  const [busy, setBusy] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const turnStartRef = useRef<number | null>(null);
  const [streamingText, setStreamingText] = useState("");
  const [notice, setNotice] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showPromptLab, setShowPromptLab] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pastedImages, setPastedImages] = useState<string[]>([]);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [recording, setRecording] = useState(false);
  const [micConnecting, setMicConnecting] = useState(false);
  const [transcribingMic, setTranscribingMic] = useState(false);
  const [improving, setImproving] = useState(false);
  const [preparingAttachment, setPreparingAttachment] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [projectFiles, setProjectFiles] = useState<string[]>([]);
  const clientRef = useRef<ReturnType<typeof makeClient> | null>(null);
  const clientSigRef = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // browser_screenshot results live here, keyed by tool_call_id — NEVER on
  // the persisted Msg/session (see agent.ts's runBrowserTool comment): a
  // multi-MB base64 PNG on a stored message would get resent to the API on
  // every later call and written to localStorage on every session save.
  // A plain ref (not state) avoids growing this into serialized app state.
  const screenshotsRef = useRef<Map<string, string>>(new Map());
  const [, bumpScreenshots] = useReducer((x: number) => x + 1, 0);
  function onScreenshot(toolCallId: string, base64: string) {
    screenshotsRef.current.set(toolCallId, base64);
    bumpScreenshots();
  }
  function getScreenshot(toolCallId?: string): string | undefined {
    return toolCallId ? screenshotsRef.current.get(toolCallId) : undefined;
  }

  useEffect(() => {
    if (!sessions.find((s) => s.id === activeId)) setActiveId(sessions[0].id);
  }, []);

  // Live elapsed-time counter shown next to the "Working…" indicator.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      if (turnStartRef.current) setElapsedMs(Date.now() - turnStartRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, [busy]);

  function formatK(n: number): string {
    return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  }

  function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  // ⌘N: new chat
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        createChat();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // One-time migration off localStorage (see sessions.ts) — on the first
  // launch after upgrading, the file doesn't exist yet, so `sessions` stays
  // whatever the synchronous localStorage-based initializer above produced.
  useEffect(() => {
    loadSessionsFromFile().then((fromFile) => {
      if (fromFile && fromFile.length) setSessions(fromFile);
    });
  }, []);
  useEffect(() => {
    // Old localStorage copy is only cleared once a file write is actually
    // confirmed — if it fails (disk full, permissions), the frozen
    // localStorage snapshot from before this change stays as a backup.
    saveSessionsToFile(sessions).then((ok) => {
      if (ok) {
        localStorage.removeItem(SESSIONS_KEY);
        localStorage.removeItem("vibe_sessions");
      }
    });
  }, [sessions]);
  useEffect(() => localStorage.setItem(ACTIVE_KEY, activeId), [activeId]);
  useEffect(() => saveProjects(projects), [projects]);
  useEffect(() => saveActiveProjectId(activeProjectId), [activeProjectId]);

  // Switching the active project should show one of ITS chats — reuse the
  // most recent one if it has any, otherwise start a fresh chat for it.
  useEffect(() => {
    const forThisProject = sessions.filter((s) => s.projectId === activeProjectId);
    if (forThisProject.some((s) => s.id === activeId)) return;
    if (forThisProject.length) {
      setActiveId(forThisProject.slice().sort((a, b) => b.createdAt - a.createdAt)[0].id);
    } else {
      const s = newSession(activeProjectId);
      setSessions((cur) => [s, ...cur]);
      setActiveId(s.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId]);

  // Restore the per-session draft on mount and whenever the session changes.
  useEffect(() => {
    setInputRaw(localStorage.getItem(`vibe_draft_${activeId}`) ?? "");
    setLastPromptTokens(0); // context gauge below has no reading for this chat yet
    setSuggestions([]);
  }, [activeId]);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [sessions, streamingText, activeId]);

  // File list for @-mention (refreshed when the active project's directory changes)
  useEffect(() => {
    if (!projectDir) return;
    invoke<string>("project_tree", { workspace: projectDir, maxEntries: 3000 })
      .then((t) => setProjectFiles(t ? t.split("\n").filter(Boolean) : []))
      .catch(() => setProjectFiles([]));
  }, [projectDir]);

  const active =
    sessions.find((s) => s.id === activeId && s.projectId === activeProjectId) ??
    sessions.find((s) => s.projectId === activeProjectId) ??
    sessions[0];

  // The local Qwen3 models have a real context window far smaller than any
  // cloud contextBudget default — the gauge must reflect whichever is
  // actually in effect for the currently selected provider/model.
  const gaugeBudget =
    provider.id === LOCAL_PROVIDER_ID ? localPromptBudget(model) : active.contextBudget || 200_000;

  function pickProjectFolder() {
    open({ directory: true, multiple: false }).then((dir) => {
      if (typeof dir !== "string") return;
      const existing = projects.find((p) => p.directory === dir);
      if (existing) {
        setActiveProjectId(existing.id);
        return;
      }
      const p = newProject(dir);
      setProjects((cur) => [...cur, p]);
      setActiveProjectId(p.id);
    });
  }

  function deleteProject(id: string) {
    if (projects.length <= 1) return;
    setProjects((cur) => cur.filter((p) => p.id !== id));
    setSessions((cur) => cur.filter((s) => s.projectId !== id));
    if (activeProjectId === id) {
      setActiveProjectId(projects.find((p) => p.id !== id)!.id);
    }
  }

  useEffect(() => {
    onUsageChange(active?.usage.total_tokens ?? 0);
  }, [active?.usage.total_tokens]);

  function updateActive(patch: Partial<Session>) {
    setSessions((cur) => cur.map((s) => (s.id === active.id ? { ...s, ...patch } : s)));
  }
  function addMessage(m: Msg) {
    setSessions((cur) => cur.map((s) => (s.id === active.id ? { ...s, messages: [...s.messages, m] } : s)));
  }

  // Builds the history actually sent to the API: a session with a
  // local-model-generated `summary` gets that summary substituted for
  // messages[0..summaryUpTo) as a synthetic user/assistant pair, with only
  // the tail beyond it going through the usual per-turn compactHistory.
  // The full transcript in session.messages is never touched — this only
  // shapes what leaves the machine on the next call.
  function outgoingHistory(session: Session): Msg[] {
    if (!session.summary || !session.summaryUpTo) return compactHistory(session.messages);
    const tail = session.messages.slice(session.summaryUpTo);
    const summaryMsgs: Msg[] = [
      { role: "user", content: `[Summary of the earlier conversation]\n${session.summary}` },
      { role: "assistant", content: "Understood — I have the context from the summary above and will continue accordingly." },
    ];
    return [...summaryMsgs, ...compactHistory(tail)];
  }

  function serializeForSummary(messages: Msg[]): string {
    return messages
      .map((m) => {
        if (m.role === "tool") return `[tool ${m.toolName ?? ""}] ${m.content.slice(0, 500)}`;
        if (m.tool_calls?.length) return `assistant (called ${m.tool_calls.map((tc) => tc.function.name).join(", ")})`;
        return `${m.role}: ${m.content.slice(0, 2000)}`;
      })
      .join("\n\n");
  }

  // Background history compaction: folds everything but the last 2 user
  // turns into a running local-model summary, so a long chat's *raw*
  // history sent to the API stays bounded instead of growing every single
  // turn. Never blocks sending — runs after a turn completes, and any
  // failure just leaves the existing summary/messages as they are (today's
  // plain compactHistory still applies via outgoingHistory's fallback).
  function maybeCompactHistory(session: Session) {
    const userIdxs: number[] = [];
    session.messages.forEach((m, i) => {
      if (m.role === "user") userIdxs.push(i);
    });
    if (userIdxs.length < 3) return; // need ≥1 turn to summarize + 2 to keep raw
    const newCutoff = userIdxs[userIdxs.length - 2];
    const prevCutoff = session.summaryUpTo ?? 0;
    if (newCutoff <= prevCutoff) return; // nothing new since the last summary
    const unsummarized = session.messages.slice(prevCutoff, newCutoff);
    if (estimateTokens(historyChars(unsummarized)) <= 3000) return;
    // Cache-friendliness: only re-summarize once the unsummarized range has
    // grown substantially, so the output prefix stays byte-stable between
    // consecutive turns most of the time.
    if (prevCutoff > 0 && newCutoff - prevCutoff < 0.5 * prevCutoff) return;
    const sessionId = session.id;
    summarizeHistory(serializeForSummary(unsummarized), session.summary).then((summary) => {
      if (!summary) return;
      setSessions((cur) =>
        cur.map((s) => (s.id === sessionId ? { ...s, summary, summaryUpTo: newCutoff } : s))
      );
    });
  }

  // The prompt-improve model is independently configurable in Settings →
  // Providers (see ProvidersModal) — it may be the local Qwen3 provider
  // (handled by improvePrompt/localComplete) or any cloud provider the user
  // already has an API key for. This is the cloud branch: a plain,
  // non-streaming completion using the same rewrite instructions as the
  // local path, so behavior is consistent regardless of which the user picks.
  async function improveWithCloudProvider(p: Provider, model: string, draft: string, lang: string): Promise<string | null> {
    try {
      const client = makeClient(p.apiKey, p.baseURL);
      const resp = await client.chat.completions.create({
        model: model || p.models[0],
        messages: [
          { role: "system", content: improvePromptSystem(lang) },
          { role: "user", content: draft.slice(0, 4000) },
        ],
        max_tokens: 700,
        temperature: 0.2,
      });
      const text = resp.choices[0]?.message?.content;
      return text?.trim() || null;
    } catch {
      return null;
    }
  }
  // Cloud-provider sibling of cleanDictation (localLlm.ts), for the
  // dictation-cleanup picker in Settings → Providers — same rewrite
  // instructions, just routed through a cloud chat-completions call instead
  // of the local llama-server.
  async function cleanDictationWithCloudProvider(p: Provider, model: string, text: string, lang: string): Promise<string | null> {
    if (text.length > 2000) return null;
    try {
      const client = makeClient(p.apiKey, p.baseURL);
      const resp = await client.chat.completions.create({
        model: model || p.models[0],
        messages: [
          { role: "system", content: dictationCleanupSystem(lang) },
          { role: "user", content: text },
        ],
        max_tokens: Math.max(200, Math.round(text.length * 1.3)),
        temperature: 0.2,
      });
      const reply = resp.choices[0]?.message?.content;
      return reply?.trim() || null;
    } catch {
      return null;
    }
  }
  // The last API-reported prompt_tokens is the real, current size of the
  // conversation as billed by the provider — unlike active.usage.total_tokens
  // (a running sum across the whole session), this is what the context
  // window gauge below needs.
  const [lastPromptTokens, setLastPromptTokens] = useState(0);
  function addUsage(u: Usage) {
    setLastPromptTokens(u.prompt_tokens);
    // The 5h/weekly window tracker models Sakana's subscription limits.
    if (provider.id === "sakana") recordUsage(u.total_tokens);
    setSessions((cur) =>
      cur.map((s) =>
        s.id === active.id
          ? {
              ...s,
              usage: {
                prompt_tokens: s.usage.prompt_tokens + u.prompt_tokens,
                completion_tokens: s.usage.completion_tokens + u.completion_tokens,
                total_tokens: s.usage.total_tokens + u.total_tokens,
                cached_tokens: (s.usage.cached_tokens ?? 0) + (u.cached_tokens ?? 0),
              },
            }
          : s
      )
    );
  }
  function createChat() {
    const s = newSession(activeProjectId);
    setSessions((cur) => [s, ...cur]);
    setActiveId(s.id);
    setShowHistory(false);
  }
  function deleteChat(id: string) {
    setSessions((cur) => {
      const next = cur.filter((s) => s.id !== id);
      if (id === activeId) {
        const sameProject = next.filter((s) => s.projectId === activeProjectId);
        if (sameProject.length) {
          setActiveId(sameProject.slice().sort((a, b) => b.createdAt - a.createdAt)[0].id);
        } else {
          const s = newSession(activeProjectId);
          setActiveId(s.id);
          return [s, ...next];
        }
      }
      return next;
    });
  }

  function requestApproval(toolName: string, args: any): Promise<boolean> {
    if (active.autoApprove) return Promise.resolve(true);
    return new Promise((resolve) => {
      setPendingApproval({ toolName, args, workspace: projectDir, resolve });
    });
  }

  async function revertTo(checkpointId: number) {
    try {
      const restored = await invoke<string[]>("checkpoint_revert", { workspace: projectDir, id: checkpointId });
      for (const p of restored) onFileChanged(p);
      toast(restored.length ? `${restored.length} ${t("revertedN")}` : t("nothingToRevert"));
    } catch (e) {
      toast(`${t("revertError")}: ${String(e)}`, "err");
    }
  }

  const mentionMatches = useMemo(() => {
    if (!mentionQuery) return projectFiles.slice(0, 8);
    const q = mentionQuery.toLowerCase();
    return projectFiles.filter((f) => f.toLowerCase().includes(q)).slice(0, 8);
  }, [mentionQuery, projectFiles]);

  function onInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const v = e.target.value;
    setInput(v);
    // open mention dropdown while typing @word
    const caret = e.target.selectionStart ?? v.length;
    const before = v.slice(0, caret);
    const m = before.match(/@([\w./-]*)$/);
    if (m) {
      setMentionOpen(true);
      setMentionQuery(m[1]);
    } else {
      setMentionOpen(false);
    }
  }

  function pickMention(path: string) {
    // remove the trailing @query from input and attach the file instead
    setInput((cur) => cur.replace(/@([\w./-]*)$/, ""));
    setAttachments((cur) => (cur.includes(path) ? cur : [...cur, path]));
    setMentionOpen(false);
    inputRef.current?.focus();
  }

  // Dropped from the file tree, which is always rooted at `workspace` — only
  // meaningful to attach when this chat's active project is that same folder
  // (attachments are read via `read_file` against `projectDir`).
  function onFileTreeDrop(e: React.DragEvent) {
    e.preventDefault();
    setFileDragOver(false);
    const payload = readFileDragData(e);
    if (!payload) return;
    if (payload.workspace !== projectDir) {
      toast(t("droppedWrongProject"), "err");
      return;
    }
    if (payload.isDir) {
      toast(t("cannotAttachFolder"), "err");
      return;
    }
    setAttachments((cur) => (cur.includes(payload.relPath) ? cur : [...cur, payload.relPath]));
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Downscales/recompresses a pasted image before it ever touches state:
  // a raw screen capture can be several MB, and this becomes part of the
  // conversation (persisted to localStorage, resent to the API) — a capped
  // JPEG keeps both bounded without visibly hurting the model's ability to
  // read a screenshot.
  async function fileToCompressedDataUrl(file: File, maxDim = 1568, quality = 0.72): Promise<string> {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if (width > maxDim || height > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas unavailable");
    ctx.drawImage(bitmap, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", quality);
  }

  async function onPasteInput(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(e.clipboardData.items).filter((it) => it.type.startsWith("image/"));
    if (!items.length) return; // let normal text paste proceed
    e.preventDefault();
    for (const item of items) {
      const file = item.getAsFile();
      if (!file) continue;
      try {
        const dataUrl = await fileToCompressedDataUrl(file);
        setPastedImages((cur) => [...cur, dataUrl]);
      } catch {
        toast(t("pasteImageError"), "err");
      }
    }
  }

  // Voice input: record with MediaRecorder, hand the clip to the same
  // transcribe_media/Whisper pipeline the "Transcribe" button uses (a real
  // file on disk, not a new code path), then append the transcript to
  // whatever's already typed rather than replacing it.
  async function startRecording() {
    if (!loadActiveAsrModel()) {
      toast(t("noAsrModel"), "err");
      return;
    }
    // Feedback the instant the button is pressed — getUserMedia (and the
    // OS's own mic-activation indicator) can take a visible moment, and
    // without this the button looked unresponsive for that whole gap.
    setMicConnecting(true);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = ["audio/mp4", "audio/webm", "audio/wav"].find((m) => MediaRecorder.isTypeSupported(m));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordedChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((tr) => tr.stop());
        void finishRecording(recorder.mimeType || mimeType || "audio/webm");
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setMicConnecting(false);
      setRecording(true);
    } catch (e) {
      setMicConnecting(false);
      toast(`${t("micError")}: ${String(e)}`, "err");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setRecording(false);
  }

  async function finishRecording(mimeType: string) {
    const blob = new Blob(recordedChunksRef.current, { type: mimeType });
    recordedChunksRef.current = [];
    if (blob.size === 0) return;
    setTranscribingMic(true);
    const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("wav") ? "wav" : "m4a";
    const recPath = `.mahi-mic/${Date.now()}.${ext}`;
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
      const base64Content = btoa(binary);
      await invoke("write_file_binary", { workspace: projectDir, path: recPath, base64Content });
      // Opt-in (Settings → Local AI Models): routes dictation through
      // ElevenLabs's cloud speech-to-text instead of the local Whisper
      // model. Falls back to local Whisper on any failure (bad/missing API
      // key, network error) rather than losing the recording — the mic
      // audio is already safely written to disk above either way.
      const result = isElevenLabsAsrEnabled()
        ? await (async () => {
            try {
              const r = await transcribeElevenLabs(blob);
              return { text: r.text, detected_language: r.languageCode };
            } catch (e) {
              toast(`${t("elevenLabsAsrFailed")}: ${String(e)}`, "err");
              return await invoke<{ text: string; detected_language: string | null }>("transcribe_media", {
                workspace: projectDir,
                path: recPath,
                modelId: loadActiveAsrModel(),
              });
            }
          })()
        : // No `language` sent — let whisper.cpp actually detect the spoken
          // language from the audio, instead of forcing whatever the UI
          // happens to be set to. Forcing was causing e.g. English dictation
          // to come back transcribed as Persian (whisper.cpp doesn't "listen
          // harder" for the forced language, it just transcribes into that
          // language/script regardless of what's actually spoken).
          await invoke<{ text: string; detected_language: string | null }>("transcribe_media", {
            workspace: projectDir,
            path: recPath,
            modelId: loadActiveAsrModel(),
          });
      const spokenLang = result.detected_language ?? getLang();
      // Opt-in (Settings → Local AI Models): falls back to the raw Whisper
      // output when off, or on any failure (no local model, timeout, etc.).
      // Provider/model is independently configurable in Settings →
      // Providers, same picker pattern as prompt-improve.
      let cleaned = result.text;
      if (isDictationCleanupEnabled()) {
        const dictationProviderId = loadDictationProviderId();
        const model = loadDictationModel();
        const runClean =
          dictationProviderId === LOCAL_PROVIDER_ID
            ? cleanDictation(result.text, spokenLang, model)
            : (() => {
                const provider = providers.find((p) => p.id === dictationProviderId);
                return provider ? cleanDictationWithCloudProvider(provider, model, result.text, spokenLang) : Promise.resolve(null);
              })();
        cleaned = (await runClean) ?? result.text;
      }
      setInput((cur) => (cur ? `${cur} ${cleaned}` : cleaned));
    } catch (e) {
      toast(`${t("transcribeError")}: ${String(e)}`, "err");
    } finally {
      setTranscribingMic(false);
      invoke("delete_file", { workspace: projectDir, path: recPath }).catch(() => {});
    }
  }

  function toggleRecording() {
    if (recording) stopRecording();
    else void startRecording();
  }

  // The tree text is resent as part of the system message on every single
  // API call within a turn (these APIs are stateless), so keep it small and
  // reuse one fetch per workspace instead of re-fetching every send.
  const treeCache = useRef<{ workspace: string; maxEntries: number; tree: string } | null>(null);
  async function buildSystemContent(): Promise<string> {
    let systemContent = active.systemPrompt;
    try {
      // Local models have far smaller context windows than the cloud
      // providers this tree size was tuned for — a large workspace's tree
      // alone can otherwise burn most (or all) of a small local model's
      // budget before any real conversation happens.
      const maxEntries = provider.id === LOCAL_PROVIDER_ID ? 40 : 120;
      if (treeCache.current?.workspace !== projectDir || treeCache.current?.maxEntries !== maxEntries) {
        const tree = await invoke<string>("project_tree", { workspace: projectDir, maxEntries });
        treeCache.current = { workspace: projectDir, maxEntries, tree };
      }
      systemContent += `\n\nWorkspace root: ${projectDir}\nProject files (partial listing; use glob_files/list_dir for more):\n${treeCache.current.tree}`;
    } catch {
      // proceed without tree
    }
    // Only meaningful when this chat's project is the folder actually open
    // in the IDE — otherwise these tabs belong to an unrelated project.
    if (projectDir === workspace && openTabs.length) {
      systemContent += `\n\nCurrently open tabs in the IDE's editor/preview panel (the user can see these on screen): ${openTabs.join(", ")}`;
      if (activeTabPath) systemContent += `\nActive/focused tab: ${activeTabPath}`;
    }
    return systemContent;
  }

  async function runTurn(
    history: Msg[],
    checkpointId: number | undefined,
    opts?: { isFirstTurn?: boolean; firstUserText?: string }
  ) {
    setBusy(true);
    turnStartRef.current = Date.now();
    setElapsedMs(0);
    setStreamingText("");
    setNotice("");
    setSuggestions([]); // stale suggestions from the previous turn no longer apply
    const controller = new AbortController();
    abortRef.current = controller;
    let lastAssistantText = "";
    let wasManualStop = false;
    let hadError = false;
    // Whatever the last user message driving this turn is — used for the
    // suggestion-chips call below; works for both send() and continueTurn()
    // without either needing to pass it explicitly.
    const lastUserMsg = [...history].reverse().find((m) => m.role === "user");

    // The local provider has no real baseURL until the sidecar for this
    // specific model is actually running — resolve it fresh each turn
    // (cheap once warm; local_llm_ensure's hot path just checks the process
    // is alive) rather than trusting whatever placeholder is on the object.
    let resolvedBaseURL = provider.baseURL;
    if (provider.id === LOCAL_PROVIDER_ID) {
      setNotice(t("localStarting"));
      try {
        resolvedBaseURL = await invoke<string>("local_llm_ensure", {
          modelId: model,
          ctx: loadLocalCtxOverride(model) ?? undefined,
        });
      } catch (e) {
        addMessage({ role: "assistant", content: t("localModelMissing") });
        toast(String(e), "err");
        onOpenModels();
        setBusy(false);
        setNotice("");
        abortRef.current = null;
        return;
      }
      setNotice("");
    }

    // Rebuild the client whenever the selected provider's endpoint/key
    // changed since the last turn.
    const clientSig = `${resolvedBaseURL}|${provider.apiKey}`;
    if (!clientRef.current || clientSigRef.current !== clientSig) {
      clientRef.current = makeClient(provider.apiKey, resolvedBaseURL);
      clientSigRef.current = clientSig;
    }

    try {
      await agentTurn(clientRef.current, model, projectDir, history, {
        // reasoning_effort is Sakana-specific; other providers may reject
        // unknown params, so only send it there.
        reasoningEffort: provider.id === "sakana" ? sanitizeEffort(active.reasoningEffort) : undefined,
        temperature: active.temperature,
        signal: controller.signal,
        checkpointId,
        contextBudget: gaugeBudget,
        onDelta: (t) => setStreamingText(t),
        onHeaders,
        onNotice: (t) => setNotice(t),
        onStep: (m) => {
          setStreamingText("");
          addMessage(m);
          if (m.role === "assistant" && m.content) lastAssistantText = m.content;
          if (
            m.role === "tool" &&
            TURN_MUTATION_TOOLS.has(m.toolName ?? "")
          ) {
            // Only refresh the IDE's own file tree/tabs when this chat's
            // project happens to be the folder currently open in the IDE —
            // a chat scoped to a different project shouldn't touch it.
            if (projectDir === workspace) {
              if (m.toolArgs?.path) onFileChanged(m.toolArgs.path);
              if (m.toolArgs?.from) onFileChanged(m.toolArgs.from);
              if (m.toolArgs?.to) onFileChanged(m.toolArgs.to);
            }
            if (TREE_MUTATION_TOOLS.has(m.toolName ?? "")) {
              treeCache.current = null; // structure changed; refetch next turn
            }
          }
        },
        onUsage: (u) => addUsage(u),
        requestApproval,
        chatProvider: provider,
        allProviders: providers,
        browserControl,
        onScreenshot,
        // Opening a tab only makes sense when this chat's project is the
        // folder actually open in the IDE — otherwise there's no tab strip
        // this could sensibly land in.
        openFile: projectDir === workspace ? onOpenFileForAgent : undefined,
      });
    } catch (e: any) {
      if (e?.name === "AbortError" || controller.signal.aborted) {
        wasManualStop = true;
        addMessage({ role: "assistant", content: t("stoppedMsg") });
      } else {
        hadError = true;
        addMessage({ role: "assistant", content: `${t("disconnectedPrefix")}: ${String(e?.message ?? e)}` });
        toast(t("disconnectToast"), "err");
      }
    } finally {
      setStreamingText("");
      setNotice("");
      setBusy(false);
      abortRef.current = null;
      // Skip the chime/notification on a manual Stop — the user is already
      // watching in that case and doesn't need to be told.
      if (!wasManualStop) {
        notifyTaskDone(t("taskDoneTitle"), lastAssistantText.slice(0, 180) || t("taskDoneBody"));
      }
      // Fire-and-forget: replace the provisional title (first 40 chars of
      // the user's message) with a real one once the first reply lands.
      // Guarded on the title still being the provisional one so this never
      // clobbers a title the user renamed by hand in the meantime.
      if (!wasManualStop && opts?.isFirstTurn && opts.firstUserText && lastAssistantText) {
        const sessionId = active.id;
        const provisionalTitle = opts.firstUserText.slice(0, 40);
        chatTitle(opts.firstUserText, lastAssistantText).then((title) => {
          if (!title) return;
          setSessions((cur) =>
            cur.map((s) => (s.id === sessionId && s.title === provisionalTitle ? { ...s, title } : s))
          );
        });
      }
      // Off by default (extra inference on every reply has a real
      // battery/thermal cost) — only fires on a clean, complete turn.
      if (!wasManualStop && !hadError && isSuggestionsEnabled() && lastUserMsg && lastAssistantText) {
        suggestReplies(lastUserMsg.content, lastAssistantText).then((s) => {
          if (s) setSuggestions(s);
        });
      }
      // Fire-and-forget background compaction — reads the session fresh via
      // the functional updater since this turn's own messages (added via
      // addMessage/setSessions above) aren't reflected in the `active`
      // closure captured when runTurn started.
      if (!wasManualStop && !hadError) {
        setSessions((cur) => {
          const fresh = cur.find((s) => s.id === active.id);
          if (fresh) maybeCompactHistory(fresh);
          return cur;
        });
      }
    }
  }

  // One-shot: replaces the draft with an improved version for review —
  // never auto-sends. Triggered by its own dedicated button rather than a
  // toggle on Send, so it's always a single, direct action.
  async function runImproveNow() {
    if (!input.trim() || improving) return;
    setImproving(true);
    const draft = input;
    const improveProviderId = loadImproveProviderId();
    const runImprove =
      improveProviderId === LOCAL_PROVIDER_ID
        ? improvePrompt(draft, getLang(), loadImproveModel())
        : (() => {
            const improveProvider = providers.find((p) => p.id === improveProviderId);
            return improveProvider
              ? improveWithCloudProvider(improveProvider, loadImproveModel(), draft, getLang())
              : Promise.resolve(null);
          })();
    const improved = await runImprove.finally(() => setImproving(false));
    if (improved) {
      setInput(improved);
      toast(t("promptImproved"));
    } else {
      toast(t("improveFailed"), "err");
    }
  }

  async function send() {
    if (!input.trim() || busy) return;
    if (!provider.apiKey) {
      toast(`${t("enterApiKeyFor")} ${provider.name}`, "err");
      return;
    }
    if (!projectDir) {
      toast(t("noProjectHint"), "err");
      return;
    }

    const firstUserText = input;
    // Build user message: attachments are inlined as context blocks.
    let userContent = input;
    for (const path of attachments) {
      try {
        let content = await invoke<string>("read_file", { workspace: projectDir, path });
        if (content.length > MAX_ATTACH_CHARS) {
          setPreparingAttachment(true);
          const summary = await summarizeAttachment(path, content).finally(() => setPreparingAttachment(false));
          content = summary
            ? `${summary}\n\n[First 1500 characters of the file, verbatim]\n${content.slice(0, 1500)}`
            : content.slice(0, MAX_ATTACH_CHARS) + "\n… (truncated)";
        }
        userContent += `\n\n[Attached file: ${path}]\n\`\`\`\n${content}\n\`\`\``;
      } catch {
        userContent += `\n\n[Attached file ${path} could not be read]`;
      }
    }

    // Take a checkpoint for this turn so all file mutations can be reverted.
    let checkpointId: number | undefined;
    try {
      checkpointId = await invoke<number>("checkpoint_begin");
    } catch {
      checkpointId = undefined;
    }

    const userMsg: Msg = {
      role: "user",
      content: userContent,
      checkpointId,
      images: pastedImages.length ? pastedImages : undefined,
    };
    const isFirst = !active.messages.some((m) => m.role === "user");
    const systemContent = await buildSystemContent();
    // Older turns' tool dumps get compacted before sending — they'd otherwise
    // be re-billed on every internal call of this turn. outgoingHistory also
    // substitutes any local-model-generated summary for the messages it
    // covers (see maybeCompactHistory).
    const history: Msg[] = sanitizeHistory([
      { role: "system", content: systemContent },
      ...outgoingHistory(active),
      userMsg,
    ]);

    setSessions((cur) =>
      cur.map((s) =>
        s.id === active.id
          ? { ...s, messages: [...s.messages, userMsg], title: isFirst ? input.slice(0, 40) : s.title }
          : s
      )
    );
    setInput("");
    setAttachments([]);
    setPastedImages([]);
    await runTurn(history, checkpointId, { isFirstTurn: isFirst, firstUserText });
  }

  // Resume an interrupted turn: rebuild the history from the saved session
  // (repairing any dangling tool calls) and let the model pick up where it
  // stopped, under a fresh checkpoint.
  async function continueTurn() {
    if (busy || !provider.apiKey || !projectDir) return;

    let checkpointId: number | undefined;
    try {
      checkpointId = await invoke<number>("checkpoint_begin");
    } catch {
      checkpointId = undefined;
    }

    const systemContent = await buildSystemContent();
    // Drop trailing local status notes (⏹/⚠️) so the model doesn't see them
    // as its own words; then repair dangling tool calls.
    const cleaned = active.messages.filter(
      (m, i) =>
        !(
          i === active.messages.length - 1 &&
          m.role === "assistant" &&
          (m.content.startsWith("⏹") || m.content.startsWith("⚠️"))
        )
    );
    const resumeMsg: Msg = {
      role: "user",
      content: "The previous work was interrupted (connection lost or stopped). Continue from where you left off and complete the task.",
      checkpointId,
    };
    const history: Msg[] = sanitizeHistory([
      { role: "system", content: systemContent },
      ...outgoingHistory({ ...active, messages: cleaned }),
      resumeMsg,
    ]);

    setSessions((cur) =>
      cur.map((s) => (s.id === active.id ? { ...s, messages: [...cleaned, resumeMsg] } : s))
    );
    await runTurn(history, checkpointId);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mentionOpen && (e.key === "Enter" || e.key === "Tab") && mentionMatches.length > 0) {
      e.preventDefault();
      pickMention(mentionMatches[0]);
      return;
    }
    if (e.key === "Escape") setMentionOpen(false);
    if (e.key === "Enter" && !e.shiftKey && !mentionOpen) {
      e.preventDefault();
      send();
    }
  }

  // Offer "resume" when the last turn visibly ended in a stop or a dropped
  // connection instead of a normal assistant reply.
  const canContinue = useMemo(() => {
    const last = active.messages[active.messages.length - 1];
    if (!last) return false;
    if (last.role === "tool") return true; // turn died between tool result and next model call
    return (
      last.role === "assistant" &&
      // "خطا:" is the prefix older builds used for connection errors.
      (last.content.startsWith("⏹") || last.content.startsWith("⚠️") || last.content.startsWith("خطا:"))
    );
  }, [active.messages]);

  // Does this turn (user msg with checkpointId) contain any file mutations after it?
  const turnHasMutations = useMemo(() => {
    const result = new Set<number>();
    let currentCp: number | undefined;
    for (const m of active.messages) {
      if (m.role === "user") currentCp = m.checkpointId;
      if (
        m.role === "tool" &&
        currentCp !== undefined &&
        TURN_MUTATION_TOOLS.has(m.toolName ?? "") &&
        !m.content.startsWith("error:") &&
        !m.content.startsWith("Rejected")
      ) {
        result.add(currentCp);
      }
    }
    return result;
  }, [active.messages]);

  return (
    <div
      className={`chat${fileDragOver ? " drag-over" : ""}`}
      dir={uiDir()}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return;
        e.preventDefault();
      }}
      onDragEnter={(e) => {
        if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return;
        e.preventDefault();
        setFileDragOver(true);
      }}
      onDragLeave={(e) => {
        if ((e.currentTarget as HTMLDivElement).contains(e.relatedTarget as Node)) return;
        setFileDragOver(false);
      }}
      onDrop={onFileTreeDrop}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "6px 10px",
          borderBottom: "1px solid var(--border-soft)",
          flexShrink: 0,
        }}
      >
        <Bot size={15} style={{ color: "var(--accent)" }} />
        <span style={{ fontWeight: 600, fontSize: 12.5, flex: 1 }}>{t("assistant")}</span>
        <button className="ghost" onClick={createChat} title={t("newChat")}>
          <Plus size={15} />
        </button>
        <button className="ghost" onClick={() => setShowHistory(!showHistory)} title={t("history")}>
          <History size={15} />
        </button>
        <button className="ghost" onClick={() => setShowSettings(true)} title={t("settings")}>
          <Settings2 size={15} />
        </button>
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          padding: "5px 10px",
          borderBottom: "1px solid var(--border-soft)",
          flexShrink: 0,
        }}
      >
        <Briefcase size={13} style={{ color: "var(--text-dim)", flexShrink: 0 }} />
        <select
          value={activeProjectId}
          onChange={(e) => setActiveProjectId(e.target.value)}
          title={activeProject?.directory || t("noFolder")}
          style={{ flex: 1, minWidth: 0, fontSize: 11.5, background: "transparent", border: "none", color: "var(--text)" }}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={pickProjectFolder} title={t("newProjectFolder")}>
          <FolderPlus size={13} />
        </button>
        {projects.length > 1 && (
          <button className="ghost" onClick={() => deleteProject(activeProjectId)} title={t("deleteProjectTooltip")}>
            <Trash2 size={13} />
          </button>
        )}
      </div>

      {showHistory && (
        <div style={{ maxHeight: 180, overflowY: "auto", borderBottom: "1px solid var(--border-soft)" }}>
          {sessions
            .filter((s) => s.projectId === activeProjectId)
            .slice()
            .sort((a, b) => b.createdAt - a.createdAt)
            .map((s) => (
              <div
                key={s.id}
                onClick={() => {
                  setActiveId(s.id);
                  setShowHistory(false);
                }}
                className="tree-node"
                style={{ background: s.id === activeId ? "var(--accent-soft)" : undefined }}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{s.title}</span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteChat(s.id);
                  }}
                  style={{ opacity: 0.5 }}
                >
                  ✕
                </span>
              </div>
            ))}
        </div>
      )}

      <div ref={scrollRef} className="chat-msgs">
        {active.messages.length === 0 && !streamingText && (
          <div style={{ opacity: 0.45, fontSize: 12.5, textAlign: "center", marginTop: 40, lineHeight: 2 }}>
            <Bot size={28} style={{ opacity: 0.5 }} />
            <br />
            {projectDir ? (
              <>
                {t("emptyChatHint")}
                <br />
                <span style={{ fontSize: 11.5 }}>{t("mentionHint")}</span>
              </>
            ) : (
              t("noProjectHint")
            )}
          </div>
        )}
        {active.messages.map((m, i) => (
          <div key={i}>
            <Message msg={m} workspace={projectDir} getScreenshot={getScreenshot} />
            {m.role === "user" && m.checkpointId !== undefined && turnHasMutations.has(m.checkpointId) && (
              <div style={{ textAlign: "start", marginTop: 4 }}>
                <button className="revert-btn" onClick={() => revertTo(m.checkpointId!)}>
                  <Undo2 size={11} /> {t("revertTurn")}
                </button>
              </div>
            )}
          </div>
        ))}
        {streamingText && (
          <div className="typing">
            <Message msg={{ role: "assistant", content: streamingText }} workspace={projectDir} />
          </div>
        )}
        {(busy || improving || preparingAttachment) && !streamingText && (
          <div
            style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-dim)", padding: "4px 4px" }}
          >
            <FishLoader size={56} />
            <span className="typing">
              {improving ? t("improving") : preparingAttachment ? t("summarizingAttachment") : notice || t("working")}
            </span>
            {!improving && !preparingAttachment && (
              <span dir="ltr" style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
                {formatElapsed(elapsedMs)}
              </span>
            )}
          </div>
        )}
        {!busy && canContinue && (
          <div style={{ textAlign: "center", marginTop: 4 }}>
            <button className="primary" onClick={continueTurn} style={{ gap: 7 }}>
              <RotateCw size={13} /> {t("continueHere")}
            </button>
          </div>
        )}
      </div>

      <div style={{ padding: 10, borderTop: "1px solid var(--border-soft)", position: "relative", flexShrink: 0 }}>
        {mentionOpen && mentionMatches.length > 0 && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              insetInlineStart: 10,
              insetInlineEnd: 10,
              background: "var(--bg-3)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              overflow: "hidden",
              zIndex: 10,
              boxShadow: "var(--shadow)",
            }}
          >
            {mentionMatches.map((f) => (
              <div key={f} className="tree-node" dir="ltr" onClick={() => pickMention(f)}>
                {f}
              </div>
            ))}
          </div>
        )}

        {(attachments.length > 0 || pastedImages.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 7 }}>
            {attachments.map((a) => (
              <span key={a} className="chip" dir="ltr">
                {a.split("/").pop()}
                <span className="x" onClick={() => setAttachments((cur) => cur.filter((x) => x !== a))}>
                  ✕
                </span>
              </span>
            ))}
            {pastedImages.map((img, i) => (
              <span key={i} className="chip" style={{ padding: 2, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <img src={img} alt="pasted" style={{ height: 22, width: 22, objectFit: "cover", borderRadius: 4 }} />
                <span className="x" onClick={() => setPastedImages((cur) => cur.filter((_, j) => j !== i))}>
                  ✕
                </span>
              </span>
            ))}
          </div>
        )}

        {suggestions.length > 0 && !busy && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 7 }}>
            {suggestions.map((s, i) => (
              <span
                key={i}
                className="chip"
                style={{ cursor: "pointer" }}
                onClick={() => {
                  setInput(s);
                  setSuggestions([]);
                  inputRef.current?.focus();
                }}
              >
                {s}
              </span>
            ))}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
          <button
            className="ghost"
            title={t("attachFile")}
            onClick={() => {
              setInput((c) => c + "@");
              setMentionOpen(true);
              setMentionQuery("");
              inputRef.current?.focus();
            }}
          >
            <AtSign size={15} />
          </button>
          <button className="ghost" title={t("promptLabButtonTitle")} onClick={() => setShowPromptLab(true)}>
            <FlaskConical size={15} />
          </button>
          <button
            className="ghost"
            title={t("improveNowTitle")}
            disabled={!input.trim() || improving || busy || preparingAttachment}
            onClick={runImproveNow}
          >
            <Wand2 size={15} className={improving ? "typing" : undefined} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            rows={3}
            dir="auto"
            value={input}
            disabled={busy || improving || preparingAttachment}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPasteInput}
            placeholder={projectDir ? t("inputPlaceholder") : t("noProjectHint")}
            style={{ flex: 1, resize: "none" }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            <button
              className={recording || micConnecting ? "danger" : "ghost"}
              title={
                transcribingMic
                  ? t("transcribing")
                  : micConnecting
                  ? t("micConnecting")
                  : recording
                  ? t("micStop")
                  : t("micStart")
              }
              disabled={transcribingMic || micConnecting || !projectDir}
              onClick={toggleRecording}
            >
              <Mic size={15} className={recording || micConnecting || transcribingMic ? "typing" : undefined} />
            </button>
            {busy ? (
              <button className="danger" onClick={stop} title={t("stop")}>
                <Square size={14} />
              </button>
            ) : (
              <button className="primary" onClick={send} disabled={improving || preparingAttachment} title={`${t("send")} (Enter)`}>
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
        {lastPromptTokens > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }} dir="ltr">
            <span style={{ fontSize: 10.5, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
              {t("contextWindow")}: {formatK(lastPromptTokens)}/{formatK(gaugeBudget)} (
              {Math.min(100, Math.round((lastPromptTokens / gaugeBudget) * 100))}%)
            </span>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--bg-3)", overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.min(100, (lastPromptTokens / gaugeBudget) * 100)}%`,
                  height: "100%",
                  background:
                    lastPromptTokens / gaugeBudget > 0.9
                      ? "var(--red)"
                      : lastPromptTokens / gaugeBudget > 0.7
                      ? "var(--amber)"
                      : "var(--accent)",
                }}
              />
            </div>
          </div>
        )}
        <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 6, display: "flex", gap: 10 }}>
          <span>{active.usage.total_tokens.toLocaleString()} {t("tokens")}</span>
          {(active.usage.cached_tokens ?? 0) > 0 && (
            <span style={{ color: "var(--green)" }}>
              {(active.usage.cached_tokens ?? 0).toLocaleString()} {t("cachedCheap")}
            </span>
          )}
          <span>{model}</span>
          <span>{sanitizeEffort(active.reasoningEffort)}</span>
          {active.autoApprove && <span style={{ color: "var(--amber)" }}>{t("autoApproveOn")}</span>}
        </div>
      </div>

      {pendingApproval && (
        <ApprovalModal
          pending={pendingApproval}
          onDecide={(ok) => {
            pendingApproval.resolve(ok);
            setPendingApproval(null);
          }}
        />
      )}
      {showSettings && (
        <SettingsModal
          settings={{
            systemPrompt: active.systemPrompt,
            reasoningEffort: sanitizeEffort(active.reasoningEffort),
            temperature: active.temperature,
            autoApprove: active.autoApprove,
            contextBudget: active.contextBudget || 200_000,
          }}
          onClose={() => setShowSettings(false)}
          onSave={(s: SessionSettings) => updateActive(s)}
        />
      )}
      {showPromptLab && (
        <PromptLabModal
          initialText={input}
          providers={providers}
          onClose={() => setShowPromptLab(false)}
          onInsert={(text) => setInput(text)}
        />
      )}
    </div>
  );
}
