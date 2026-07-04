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
} from "lucide-react";
import { agentTurn, makeClient, Msg, Usage, sanitizeEffort, sanitizeHistory, compactHistory, BrowserControl } from "../agent";
import FishLoader from "./FishLoader";
import { recordUsage } from "./limits";
import { notifyTaskDone } from "./completion";
import Message from "../components/Message";
import ApprovalModal, { PendingApproval } from "../components/ApprovalModal";
import SettingsModal, { SessionSettings } from "../components/SettingsModal";
import type { Session } from "./sessions";
import { loadSessions, newSession, SESSIONS_KEY, ACTIVE_KEY } from "./sessions";
import type { Project } from "./projects";
import { loadProjects, saveProjects, loadActiveProjectId, saveActiveProjectId, newProject } from "./projects";
import type { Provider } from "./providers";
import { t, useLang, dir as uiDir } from "./i18n";

const MAX_ATTACH_CHARS = 8000;

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
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const [pastedImages, setPastedImages] = useState<string[]>([]);
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
  useEffect(() => {
    try {
      localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
    } catch (e) {
      // Quota exceeded or similar — without this catch, an uncaught error
      // here (there's no error boundary anywhere in the app) unmounts the
      // whole React tree, which looks like the entire window going blank.
      toast(`${t("saveError")}: ${String(e)}`, "err");
    }
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

  // The tree text is resent as part of the system message on every single
  // API call within a turn (these APIs are stateless), so keep it small and
  // reuse one fetch per workspace instead of re-fetching every send.
  const treeCache = useRef<{ workspace: string; tree: string } | null>(null);
  async function buildSystemContent(): Promise<string> {
    let systemContent = active.systemPrompt;
    try {
      if (treeCache.current?.workspace !== projectDir) {
        const tree = await invoke<string>("project_tree", { workspace: projectDir, maxEntries: 120 });
        treeCache.current = { workspace: projectDir, tree };
      }
      systemContent += `\n\nWorkspace root: ${projectDir}\nProject files (partial listing; use glob_files/list_dir for more):\n${treeCache.current.tree}`;
    } catch {
      // proceed without tree
    }
    return systemContent;
  }

  async function runTurn(history: Msg[], checkpointId: number | undefined) {
    // Rebuild the client whenever the selected provider's endpoint/key
    // changed since the last turn.
    const clientSig = `${provider.baseURL}|${provider.apiKey}`;
    if (!clientRef.current || clientSigRef.current !== clientSig) {
      clientRef.current = makeClient(provider.apiKey, provider.baseURL);
      clientSigRef.current = clientSig;
    }
    setBusy(true);
    turnStartRef.current = Date.now();
    setElapsedMs(0);
    setStreamingText("");
    setNotice("");
    const controller = new AbortController();
    abortRef.current = controller;
    let lastAssistantText = "";
    let wasManualStop = false;

    try {
      await agentTurn(clientRef.current, model, projectDir, history, {
        // reasoning_effort is Sakana-specific; other providers may reject
        // unknown params, so only send it there.
        reasoningEffort: provider.id === "sakana" ? sanitizeEffort(active.reasoningEffort) : undefined,
        temperature: active.temperature,
        signal: controller.signal,
        checkpointId,
        contextBudget: active.contextBudget || 200_000,
        onDelta: (t) => setStreamingText(t),
        onHeaders,
        onNotice: (t) => setNotice(t),
        onStep: (m) => {
          setStreamingText("");
          addMessage(m);
          if (m.role === "assistant" && m.content) lastAssistantText = m.content;
          if (
            m.role === "tool" &&
            ["write_file", "edit_file", "delete_file", "move_file"].includes(m.toolName ?? "")
          ) {
            // Only refresh the IDE's own file tree/tabs when this chat's
            // project happens to be the folder currently open in the IDE —
            // a chat scoped to a different project shouldn't touch it.
            if (projectDir === workspace) {
              if (m.toolArgs?.path) onFileChanged(m.toolArgs.path);
              if (m.toolArgs?.from) onFileChanged(m.toolArgs.from);
              if (m.toolArgs?.to) onFileChanged(m.toolArgs.to);
            }
            if (["write_file", "delete_file", "move_file"].includes(m.toolName ?? "")) {
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
      });
    } catch (e: any) {
      if (e?.name === "AbortError" || controller.signal.aborted) {
        wasManualStop = true;
        addMessage({ role: "assistant", content: t("stoppedMsg") });
      } else {
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

    // Build user message: attachments are inlined as context blocks.
    let userContent = input;
    for (const path of attachments) {
      try {
        let content = await invoke<string>("read_file", { workspace: projectDir, path });
        if (content.length > MAX_ATTACH_CHARS) {
          content = content.slice(0, MAX_ATTACH_CHARS) + "\n… (truncated)";
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
    // be re-billed on every internal call of this turn.
    const history: Msg[] = [
      { role: "system", content: systemContent },
      ...compactHistory(active.messages),
      userMsg,
    ];

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
    await runTurn(history, checkpointId);
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
      ...compactHistory(cleaned),
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
        ["write_file", "edit_file", "delete_file", "move_file"].includes(m.toolName ?? "") &&
        !m.content.startsWith("error:") &&
        !m.content.startsWith("Rejected")
      ) {
        result.add(currentCp);
      }
    }
    return result;
  }, [active.messages]);

  return (
    <div className="chat" dir={uiDir()}>
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
        {busy && !streamingText && (
          <div
            style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12, color: "var(--text-dim)", padding: "4px 4px" }}
          >
            <FishLoader size={56} />
            <span className="typing">{notice || t("working")}</span>
            <span dir="ltr" style={{ opacity: 0.7, fontVariantNumeric: "tabular-nums" }}>
              {formatElapsed(elapsedMs)}
            </span>
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

        <div style={{ display: "flex", gap: 6, alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            rows={3}
            dir="auto"
            value={input}
            disabled={busy}
            onChange={onInputChange}
            onKeyDown={onKeyDown}
            onPaste={onPasteInput}
            placeholder={projectDir ? t("inputPlaceholder") : t("noProjectHint")}
            style={{ flex: 1, resize: "none" }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
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
            {busy ? (
              <button className="danger" onClick={stop} title={t("stop")}>
                <Square size={14} />
              </button>
            ) : (
              <button className="primary" onClick={send} title={`${t("send")} (Enter)`}>
                <Send size={14} />
              </button>
            )}
          </div>
        </div>
        {lastPromptTokens > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }} dir="ltr">
            <span style={{ fontSize: 10.5, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
              {t("contextWindow")}: {formatK(lastPromptTokens)}/{formatK(active.contextBudget || 200_000)} (
              {Math.min(100, Math.round((lastPromptTokens / (active.contextBudget || 200_000)) * 100))}%)
            </span>
            <div style={{ flex: 1, height: 4, borderRadius: 2, background: "var(--bg-3)", overflow: "hidden" }}>
              <div
                style={{
                  width: `${Math.min(100, (lastPromptTokens / (active.contextBudget || 200_000)) * 100)}%`,
                  height: "100%",
                  background:
                    lastPromptTokens / (active.contextBudget || 200_000) > 0.9
                      ? "var(--red)"
                      : lastPromptTokens / (active.contextBudget || 200_000) > 0.7
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
    </div>
  );
}
