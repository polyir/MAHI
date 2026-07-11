import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  Files,
  Search,
  TerminalSquare,
  MessageSquare,
  BarChart3,
  KeyRound,
  FolderOpen,
  Command,
  Globe,
  HardDrive,
  Download,
  FlipHorizontal,
  FlipVertical,
} from "lucide-react";
import "./ide/monacoSetup";
import FileTree from "./components/FileTree";
import EditorArea from "./ide/EditorArea";
import TerminalPanel from "./ide/TerminalPanel";
import type { BrowserTab } from "./ide/BrowserTabView";
import ChatPanel from "./ide/ChatPanel";
import UsagePanel from "./ide/UsagePanel";
import CommandPalette from "./ide/CommandPalette";
import SearchPanel from "./ide/SearchPanel";
import { EditorTab, baseName } from "./ide/types";
import { kindForPath, isBinaryKind } from "./ide/fileKind";
import { getWindows, formatCountdown } from "./ide/limits";
import { Provider, loadProviders, saveProviders, loadActiveProviderId, saveActiveProviderId, defaultProviders, withLocalProvider } from "./ide/providers";
import { McpServer, loadMcpServers, saveMcpServers } from "./ide/mcp";
import { UpdateInfo, checkForUpdate, downloadUpdate, installDownloadedUpdate } from "./ide/updater";
import ProvidersModal from "./ide/ProvidersModal";
import ModelsModal from "./ide/ModelsModal";
import { t, useLang } from "./ide/i18n";
import { loadActiveAsrModel } from "./ide/models";
import mahiLogo from "./assets/mahi.png";
import "./App.css";

export type Toast = { id: number; text: string; kind: "ok" | "err" };
export type GotoTarget = { path: string; line: number; nonce: number };

const RECENTS_KEY = "vibe_recent_workspaces";

function loadRecents(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export default function App() {
  useLang();
  const [providers, setProviders] = useState<Provider[]>(loadProviders);
  const [activeProviderId, setActiveProviderId] = useState<string>(loadActiveProviderId);
  const [mcpServers, setMcpServers] = useState<McpServer[]>(() =>
    loadMcpServers(loadProviders().find((p) => p.id === "zai")?.apiKey ?? "")
  );
  const [model, setModel] = useState(localStorage.getItem("sakana_model") ?? "fugu");
  const [showProviders, setShowProviders] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [workspace, setWorkspace] = useState(localStorage.getItem("vibe_workspace") ?? "");
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sideView, setSideView] = useState<"files" | "search" | null>(null);
  const [showTerminal, setShowTerminal] = useState(false);
  const [showChat, setShowChat] = useState(true);
  // Panel arrangement toggles — quick swap buttons rather than free-form
  // drag-and-drop (a deliberately smaller feature than a full docking
  // system): chatOnLeft flips chat/editor left-right, sidebarBottomSwapped
  // flips which content (files/search vs terminal) sits in the left-side
  // vertical slot vs the bottom-of-editor horizontal slot. Both content
  // sets stay independently toggleable either way.
  const [chatOnLeft, setChatOnLeft] = useState(() => localStorage.getItem("mahi_chat_on_left") === "1");
  const [sidebarBottomSwapped, setSidebarBottomSwapped] = useState(
    () => localStorage.getItem("mahi_sidebar_bottom_swapped") === "1"
  );
  useEffect(() => localStorage.setItem("mahi_chat_on_left", chatOnLeft ? "1" : "0"), [chatOnLeft]);
  useEffect(
    () => localStorage.setItem("mahi_sidebar_bottom_swapped", sidebarBottomSwapped ? "1" : "0"),
    [sidebarBottomSwapped]
  );
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [activeBrowserId, setActiveBrowserId] = useState<string | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [paletteMode, setPaletteMode] = useState<"files" | "actions" | null>(null);
  const [totalTokens, setTotalTokens] = useState(0);
  const [usageHeaders, setUsageHeaders] = useState<Record<string, string> | null>(null);
  const [goto, setGoto] = useState<GotoTarget | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [treeVersion, setTreeVersion] = useState(0);
  // Bumped per-path whenever the filesystem watcher reports that path
  // changed — used to cache-bust asset:// preview URLs (see fs-changed
  // listener below) so a deleted-and-recreated file's stale cached preview
  // doesn't linger.
  const [fileVersions, setFileVersions] = useState<Record<string, number>>({});
  const [limitWindows, setLimitWindows] = useState(() => getWindows());
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  // "idle" while still downloading, "ready" once the button should become
  // clickable, "error" if the download itself failed (install was never
  // reached). Deliberately separate from the install step below — see
  // updater.ts's comment for why these are split rather than one combined
  // call.
  const [downloadState, setDownloadState] = useState<"idle" | "downloading" | "ready" | "error">("idle");
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);
  const [installing, setInstalling] = useState(false);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const toastCounter = useRef(0);

  // Checked on launch, then every hour — so a release that goes out while
  // the app is already open (this can stay running for a long session) is
  // still caught without needing a manual restart. A failed check (offline,
  // server down) is silent and doesn't clear an already-found update: this
  // is a nice-to-have, not something that should ever interrupt work.
  useEffect(() => {
    checkForUpdate().then((u) => u && setUpdateInfo(u));
    const id = setInterval(() => {
      checkForUpdate().then((u) => u && setUpdateInfo(u));
    }, 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  // As soon as a release is found, download it in the background — no user
  // action needed for this part. The app keeps running normally throughout;
  // only the (separate, explicit) install step below ever closes it.
  useEffect(() => {
    if (!updateInfo || downloadState !== "idle") return;
    setDownloadState("downloading");
    downloadUpdate(updateInfo.update, (downloaded, total) => {
      setDownloadProgress(total ? Math.round((downloaded / total) * 100) : null);
    })
      .then(() => setDownloadState("ready"))
      .catch((e) => {
        console.warn("update download failed:", e);
        setDownloadState("error");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [updateInfo]);

  async function handleInstall() {
    if (!updateInfo || downloadState !== "ready" || installing) return;
    setInstalling(true);
    try {
      await installDownloadedUpdate(updateInfo.update);
      // Relaunches on success — this line only runs if that somehow didn't happen.
    } catch (e) {
      toast(String(e), "err");
      setInstalling(false);
    }
  }

  // Refresh the usage-window countdown in the status bar every 30s, and
  // whenever token totals change (a request just finished).
  useEffect(() => {
    const t = setInterval(() => setLimitWindows(getWindows()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setLimitWindows(getWindows()), [totalTokens]);

  useEffect(() => saveProviders(providers), [providers]);
  useEffect(() => saveMcpServers(mcpServers), [mcpServers]);
  useEffect(() => saveActiveProviderId(activeProviderId), [activeProviderId]);
  useEffect(() => localStorage.setItem("sakana_model", model), [model]);
  useEffect(() => localStorage.setItem("vibe_workspace", workspace), [workspace]);
  // Grants the asset:// protocol read access to this workspace so binary
  // previews (image/audio/video/PDF) can stream files via convertFileSrc
  // instead of round-tripping them through IPC as base64.
  useEffect(() => {
    if (workspace) invoke("register_asset_scope", { workspace }).catch(() => {});
  }, [workspace]);
  // Watches the workspace for changes MAHI didn't cause itself (Finder, a
  // shell command, another app, a file deleted and recreated under the same
  // name) — without this, the file tree and open previews only ever
  // refreshed on the specific agent tool calls MAHI already knew to track.
  useEffect(() => {
    if (workspace) invoke("watch_workspace", { workspace }).catch(() => {});
  }, [workspace]);
  useEffect(() => {
    const unlisten = listen<{ paths: string[] }>("fs-changed", (e) => {
      setTreeVersion((v) => v + 1);
      setFileVersions((cur) => {
        const next = { ...cur };
        for (const p of e.payload.paths) next[p] = (next[p] ?? 0) + 1;
        return next;
      });
    });
    return () => {
      unlisten.then((un) => un());
    };
  }, []);
  useEffect(() => localStorage.setItem(RECENTS_KEY, JSON.stringify(recents)), [recents]);

  const activeProvider =
    providers.find((p) => p.id === activeProviderId) ?? providers[0] ?? defaultProviders()[0];

  // Keep the selected model valid for the selected provider.
  useEffect(() => {
    if (!activeProvider.models.includes(model)) {
      setModel(activeProvider.models[0] ?? "");
    }
  }, [activeProviderId, providers]);

  const toast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    const id = ++toastCounter.current;
    setToasts((cur) => [...cur, { id, text, kind }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 3500);
  }, []);

  function addRecent(dir: string) {
    setRecents((cur) => [dir, ...cur.filter((d) => d !== dir)].slice(0, 6));
  }

  function openWorkspace(dir: string) {
    setWorkspace(dir);
    setTabs([]);
    setActiveIndex(0);
    addRecent(dir);
  }

  async function pickWorkspace() {
    const dir = await open({ directory: true, multiple: false });
    if (typeof dir === "string") openWorkspace(dir);
  }

  const openFile = useCallback(
    async (relPath: string, line?: number) => {
      setActiveBrowserId(null);
      const existing = tabsRef.current.findIndex((t) => t.path === relPath);
      if (existing >= 0) {
        setActiveIndex(existing);
      } else if (isBinaryKind(kindForPath(relPath))) {
        // Image/audio/video/PDF previews stream their own bytes via the
        // asset:// protocol; read_file (UTF-8 text) would just error on them.
        setTabs((cur) => {
          setActiveIndex(cur.length);
          return [...cur, { path: relPath, content: "", original: "" }];
        });
      } else {
        try {
          const content = await invoke<string>("read_file", { workspace, path: relPath });
          setTabs((cur) => {
            setActiveIndex(cur.length);
            return [...cur, { path: relPath, content, original: content }];
          });
        } catch (e) {
          toast(`${t("openError")}: ${relPath}`, "err");
          return;
        }
      }
      if (line) setGoto({ path: relPath, line, nonce: Date.now() });
    },
    [workspace, toast]
  );

  const transcribeFile = useCallback(
    async (relPath: string) => {
      const modelId = loadActiveAsrModel();
      if (!modelId) {
        toast(t("noAsrModel"), "err");
        return;
      }
      try {
        const result = await invoke<{ text: string }>("transcribe_media", {
          workspace,
          path: relPath,
          modelId,
          language: undefined,
        });
        const transcriptPath = `${relPath}.transcript.txt`;
        await invoke("write_file", { workspace, path: transcriptPath, content: result.text });
        setTreeVersion((v) => v + 1);
        await openFile(transcriptPath);
      } catch (e) {
        toast(`${t("transcribeError")}: ${String(e)}`, "err");
      }
    },
    [workspace, toast, openFile]
  );

  function selectFileTab(i: number) {
    setActiveBrowserId(null);
    setActiveIndex(i);
  }

  function newBrowserTab() {
    const id = crypto.randomUUID();
    setBrowserTabs((cur) => [...cur, { id, url: "https://example.com", title: "" }]);
    setActiveBrowserId(id);
  }

  function closeBrowserTab(id: string) {
    setBrowserTabs((cur) => {
      const idx = cur.findIndex((b) => b.id === id);
      const next = cur.filter((b) => b.id !== id);
      setActiveBrowserId((cur) => {
        if (cur !== id) return cur;
        if (next.length === 0) return null;
        return next[Math.max(0, idx - 1)].id;
      });
      return next;
    });
  }

  function navigateBrowserTab(id: string, url: string) {
    setBrowserTabs((cur) => cur.map((b) => (b.id === id ? { ...b, url } : b)));
  }

  function focusBrowser() {
    if (browserTabs.length === 0) newBrowserTab();
    else setActiveBrowserId((cur) => cur ?? browserTabs[browserTabs.length - 1].id);
  }

  // Mirrors of browser state for the agent's browser_* tools, which are
  // dispatched from agent.ts outside React's render cycle — reading through
  // a ref (rather than closing over the state variable) keeps them looking
  // at the current tabs even mid-turn.
  const browserTabsRef = useRef(browserTabs);
  browserTabsRef.current = browserTabs;
  const activeBrowserIdRef = useRef(activeBrowserId);
  activeBrowserIdRef.current = activeBrowserId;

  function agentBrowserOpen(url: string): string {
    const id = crypto.randomUUID();
    setBrowserTabs((cur) => [...cur, { id, url, title: "" }]);
    setActiveBrowserId(id);
    return id;
  }

  function agentBrowserNavigate(url: string, tabId?: string): string | null {
    const targetId = tabId || activeBrowserIdRef.current;
    if (!targetId || !browserTabsRef.current.some((b) => b.id === targetId)) return null;
    setBrowserTabs((cur) => cur.map((b) => (b.id === targetId ? { ...b, url } : b)));
    return targetId;
  }

  function agentBrowserClose(tabId?: string): boolean {
    const targetId = tabId || activeBrowserIdRef.current;
    if (!targetId || !browserTabsRef.current.some((b) => b.id === targetId)) return false;
    closeBrowserTab(targetId);
    return true;
  }

  async function agentBrowserScreenshot(): Promise<string> {
    return invoke<string>("window_screenshot");
  }

  function changeTab(path: string, content: string) {
    setTabs((cur) => cur.map((t) => (t.path === path ? { ...t, content } : t)));
  }

  function closeTab(i: number) {
    setTabs((cur) => {
      const next = cur.filter((_, idx) => idx !== i);
      setActiveIndex((ai) => Math.max(0, ai >= next.length ? next.length - 1 : ai > i ? ai - 1 : ai));
      return next;
    });
  }

  const saveTab = useCallback(
    async (path: string) => {
      const tab = tabsRef.current.find((t) => t.path === path);
      if (!tab) return;
      try {
        await invoke("write_file", { workspace, path, content: tab.content });
        setTabs((cur) => cur.map((t) => (t.path === path ? { ...t, original: t.content } : t)));
        toast(`${t("saved")}: ${baseName(path)}`);
      } catch (e) {
        toast(`${t("saveError")}: ${String(e)}`, "err");
      }
    },
    [workspace, toast]
  );

  const onFileChanged = useCallback(
    async (relPath: string) => {
      // A file was created/edited/deleted by the agent: refresh the tree, and
      // reload the file's tab if it's open.
      setTreeVersion((v) => v + 1);
      if (!tabsRef.current.some((t) => t.path === relPath)) return;
      try {
        const content = await invoke<string>("read_file", { workspace, path: relPath });
        setTabs((cur) => cur.map((t) => (t.path === relPath ? { ...t, content, original: content } : t)));
      } catch {
        // deleted by agent; keep tab content as-is
      }
    },
    [workspace]
  );

  // Global shortcuts: ⌘P files, ⌘K actions, ⌘B sidebar, ⌘J terminal
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.metaKey) return;
      const k = e.key.toLowerCase();
      if (k === "p") {
        e.preventDefault();
        setPaletteMode((m) => (m === "files" ? null : "files"));
      } else if (k === "k") {
        e.preventDefault();
        setPaletteMode((m) => (m === "actions" ? null : "actions"));
      } else if (k === "b") {
        e.preventDefault();
        setSideView((v) => (v ? null : "files"));
      } else if (k === "j") {
        e.preventDefault();
        setShowTerminal((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const activeTab = tabs[activeIndex];

  const paletteActions = [
    { label: t("palOpenFolder"), run: pickWorkspace, icon: "folder" },
    { label: t("palTerminal"), run: () => setShowTerminal((v) => !v), icon: "terminal" },
    { label: t("palChat"), run: () => setShowChat((v) => !v), icon: "chat" },
    { label: t("usageLimit"), run: () => setShowUsage(true), icon: "usage" },
    {
      label: t("palSave"),
      run: () => activeTab && saveTab(activeTab.path),
      icon: "save",
    },
  ];

  // Which content sits in the left-side vertical slot vs the
  // bottom-of-editor horizontal slot swaps as a pair (see
  // sidebarBottomSwapped) — each one's own visibility toggle
  // (sideView/showTerminal) still applies to whichever slot it currently
  // occupies.
  const sidebarVisible = sidebarBottomSwapped ? showTerminal : !!sideView;
  const bottomVisible = sidebarBottomSwapped ? !!sideView : showTerminal;
  const filesOrSearchContent =
    sideView === "files" ? (
      <>
        <div className="panel-header">
          <Files size={11} /> {t("files")}
        </div>
        <FileTree workspace={workspace} onOpenFile={openFile} version={treeVersion} toast={toast} />
      </>
    ) : (
      <SearchPanel workspace={workspace} onOpen={openFile} />
    );
  const terminalContent = (
    <>
      <div className="panel-header">
        <TerminalSquare size={11} /> {t("terminal")}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <TerminalPanel workspace={workspace} />
      </div>
    </>
  );
  const chatPanelNode = (
    <ChatPanel
      provider={activeProvider}
      providers={providers}
      mcpServers={mcpServers}
      onMcpServersChange={setMcpServers}
      model={model}
      workspace={workspace}
      onFileChanged={onFileChanged}
      onUsageChange={setTotalTokens}
      onHeaders={setUsageHeaders}
      toast={toast}
      openTabs={tabs.map((tb) => tb.path)}
      activeTabPath={tabs[activeIndex]?.path ?? null}
      onOpenFileForAgent={openFile}
      onOpenModels={() => setShowModels(true)}
      browserControl={{
        open: agentBrowserOpen,
        navigate: agentBrowserNavigate,
        close: agentBrowserClose,
        screenshot: agentBrowserScreenshot,
      }}
    />
  );

  return (
    <div className="ide-root">
      <div className="bg-glow-container">
        <div className="bg-glow bg-glow-1"></div>
        <div className="bg-glow bg-glow-2"></div>
        <div className="bg-glow bg-glow-3"></div>
      </div>
      <div className="titlebar">
        <span className="brand">
          <img src={mahiLogo} alt="MAHI" className="brand-logo" />
          <span className="brand-text">MAHI</span>
          <span className="brand-fish-swim"></span>
        </span>
        {workspace && (
          <button className="ghost" onClick={pickWorkspace} title={workspace}>
            <FolderOpen size={13} /> {baseName(workspace)}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="ghost" onClick={() => setPaletteMode("files")} title={t("quickOpenTitle")}>
          <Command size={13} /> ⌘P
        </button>
        <select
          value={activeProviderId}
          onChange={(e) => setActiveProviderId(e.target.value)}
          title={t("apiService")}
        >
          {providers.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.apiKey ? "" : ` (${t("noKey")})`}
            </option>
          ))}
        </select>
        <select value={model} onChange={(e) => setModel(e.target.value)} title={t("model")}>
          {activeProvider.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <button className="ghost" onClick={() => setShowProviders(true)} title={t("manageProviders")}>
          <KeyRound size={14} />
        </button>
        <button className="ghost" onClick={() => setShowModels(true)} title={t("manageModels")}>
          <HardDrive size={14} />
        </button>
        {updateInfo && downloadState !== "error" && (
          <button
            className="ghost"
            onClick={handleInstall}
            disabled={downloadState !== "ready" || installing}
            title={updateInfo.notes || ""}
            style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
          >
            <Download size={14} />
            {installing
              ? t("updating")
              : downloadState === "ready"
              ? `${t("installUpdate")} v${updateInfo.version}`
              : `${t("downloadingUpdate")}${downloadProgress != null ? ` ${downloadProgress}%` : ""}`}
          </button>
        )}
      </div>

      <div className="main">
        <div className="activitybar">
          <button
            className={`act-btn ${sideView === "files" ? "on" : ""}`}
            onClick={() => setSideView(sideView === "files" ? null : "files")}
            title={`${t("files")} (⌘B)`}
          >
            <Files size={19} />
          </button>
          <button
            className={`act-btn ${sideView === "search" ? "on" : ""}`}
            onClick={() => setSideView(sideView === "search" ? null : "search")}
            title={t("searchInProject")}
          >
            <Search size={19} />
          </button>
          <button
            className={`act-btn ${showTerminal ? "on" : ""}`}
            onClick={() => setShowTerminal(!showTerminal)}
            title={`${t("terminal")} (⌘J)`}
          >
            <TerminalSquare size={19} />
          </button>
          <button
            className={`act-btn ${showChat ? "on" : ""}`}
            onClick={() => setShowChat(!showChat)}
            title={t("aiChat")}
          >
            <MessageSquare size={19} />
          </button>
          <button
            className={`act-btn ${activeBrowserId !== null ? "on" : ""}`}
            onClick={focusBrowser}
            title={t("browserTitle")}
          >
            <Globe size={19} />
          </button>
          <div className="spacer" />
          <button className="act-btn" onClick={() => setChatOnLeft((v) => !v)} title={t("swapChatSideTitle")}>
            <FlipHorizontal size={17} />
          </button>
          <button
            className="act-btn"
            onClick={() => setSidebarBottomSwapped((v) => !v)}
            title={t("swapSidebarTerminalTitle")}
          >
            <FlipVertical size={17} />
          </button>
          <button className="act-btn" onClick={() => setShowUsage(true)} title={t("usageLimit")}>
            <BarChart3 size={19} />
          </button>
        </div>

        {!workspace ? (
          <div className="welcome panel-tazhib-decoration" style={{ flex: 1 }}>
            <div className="tazhib-bottom-corners"></div>
            <img src={mahiLogo} alt="MAHI" className="welcome-logo" />
            <h2>MAHI</h2>
            <div className="sub">{t("welcomeSub")}</div>
            <button className="primary" onClick={pickWorkspace}>
              <FolderOpen size={15} /> {t("openFolder")}
            </button>
            {recents.length > 0 && (
              <div className="recent">
                <div className="panel-header">{t("recentProjects")}</div>
                {recents.map((r) => (
                  <div key={r} className="recent-item" onClick={() => openWorkspace(r)}>
                    <FolderOpen size={14} /> {r}
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <PanelGroup direction="horizontal" style={{ flex: 1 }} autoSaveId="mahi-main-horizontal">
            {chatOnLeft && showChat && (
              <Panel key="chat" order={1} defaultSize={45} minSize={18}>
                {chatPanelNode}
              </Panel>
            )}
            {chatOnLeft && showChat && <PanelResizeHandle key="chat-h-left" className="resize-h" />}

            {sidebarVisible && (
              <Panel key="side" order={2} defaultSize={17} minSize={11}>
                <div className="sidebar">{sidebarBottomSwapped ? terminalContent : filesOrSearchContent}</div>
              </Panel>
            )}
            {sidebarVisible && <PanelResizeHandle key="side-h" className="resize-h" />}

            <Panel key="center" order={3} defaultSize={sidebarVisible ? 38 : 55} minSize={25}>
              <PanelGroup direction="vertical" autoSaveId="mahi-center-vertical">
                <Panel key="editor" order={1} defaultSize={bottomVisible ? 68 : 100} minSize={20}>
                  <EditorArea
                    workspace={workspace}
                    tabs={tabs}
                    activeIndex={activeIndex}
                    onSelect={selectFileTab}
                    onClose={closeTab}
                    onChange={changeTab}
                    onSave={saveTab}
                    goto={goto}
                    browserTabs={browserTabs}
                    activeBrowserId={activeBrowserId}
                    onSelectBrowser={setActiveBrowserId}
                    onCloseBrowser={closeBrowserTab}
                    onNavigateBrowser={navigateBrowserTab}
                    onNewBrowserTab={newBrowserTab}
                    onTranscribe={transcribeFile}
                    fileVersions={fileVersions}
                  />
                </Panel>
                {bottomVisible && <PanelResizeHandle key="term-h" className="resize-v" />}
                {bottomVisible && (
                  <Panel key="bottom" order={2} defaultSize={32} minSize={10}>
                    <div className="sidebar" style={{ background: "var(--bg-0)" }}>
                      {sidebarBottomSwapped ? filesOrSearchContent : terminalContent}
                    </div>
                  </Panel>
                )}
              </PanelGroup>
            </Panel>

            {!chatOnLeft && showChat && <PanelResizeHandle key="chat-h-right" className="resize-h" />}
            {!chatOnLeft && showChat && (
              <Panel key="chat" order={4} defaultSize={45} minSize={18}>
                {chatPanelNode}
              </Panel>
            )}
          </PanelGroup>
        )}
      </div>

      <div className="statusbar">
        <span>{workspace ? baseName(workspace) : t("noFolder")}</span>
        {activeTab && <span dir="ltr">{activeTab.path}</span>}
        <div style={{ flex: 1 }} />
        {limitWindows.fiveHour.resetAt && (
          <span className="clickable" onClick={() => setShowUsage(true)} title={t("window5h")}>
            ⏳ {t("reset5h")}: {formatCountdown(limitWindows.fiveHour.resetAt)}
            {limitWindows.fiveHour.pct !== null && ` · ${limitWindows.fiveHour.pct}%`}
          </span>
        )}
        {limitWindows.weekly.pct !== null && (
          <span className="clickable" onClick={() => setShowUsage(true)} title={t("weekly")}>
            {t("weekly")}: {limitWindows.weekly.pct}%
          </span>
        )}
        <span className="clickable" onClick={() => setShowUsage(true)}>
          <BarChart3 size={12} /> {totalTokens.toLocaleString()} {t("tokens")}
        </span>
        <span>{model}</span>
      </div>

      {paletteMode && (
        <CommandPalette
          mode={paletteMode}
          workspace={workspace}
          actions={paletteActions}
          onOpenFile={(p) => openFile(p)}
          onClose={() => setPaletteMode(null)}
        />
      )}

      {showUsage && (
        <UsagePanel
          headers={usageHeaders}
          consoleURL={activeProvider.consoleURL}
          providerName={activeProvider.name}
          onClose={() => setShowUsage(false)}
        />
      )}

      {showProviders && (
        <ProvidersModal
          providers={providers}
          onClose={() => setShowProviders(false)}
          onSave={(p) => {
            const withLocal = withLocalProvider(p);
            setProviders(withLocal);
            if (!withLocal.find((x) => x.id === activeProviderId) && withLocal[0]) setActiveProviderId(withLocal[0].id);
          }}
          mcpServers={mcpServers}
          onSaveMcp={setMcpServers}
        />
      )}

      {showModels && <ModelsModal onClose={() => setShowModels(false)} />}

      <div className="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
