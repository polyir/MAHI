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
  Blocks,
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
import ProvidersModal from "./ide/ProvidersModal";
import ModelsModal from "./ide/ModelsModal";
import ExternalToolsModal from "./ide/ExternalToolsModal";
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
  const [model, setModel] = useState(localStorage.getItem("sakana_model") ?? "fugu");
  const [showProviders, setShowProviders] = useState(false);
  const [showModels, setShowModels] = useState(false);
  const [showExternalTools, setShowExternalTools] = useState(false);
  const [workspace, setWorkspace] = useState(localStorage.getItem("vibe_workspace") ?? "");
  const [recents, setRecents] = useState<string[]>(loadRecents);
  const [tabs, setTabs] = useState<EditorTab[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sideView, setSideView] = useState<"files" | "search" | null>("files");
  const [showTerminal, setShowTerminal] = useState(true);
  const [showChat, setShowChat] = useState(true);
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
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const toastCounter = useRef(0);

  // Refresh the usage-window countdown in the status bar every 30s, and
  // whenever token totals change (a request just finished).
  useEffect(() => {
    const t = setInterval(() => setLimitWindows(getWindows()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => setLimitWindows(getWindows()), [totalTokens]);

  useEffect(() => saveProviders(providers), [providers]);
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

  return (
    <div className="ide-root">
      <div className="titlebar">
        <span className="brand">
          <img src={mahiLogo} alt="MAHI" className="brand-logo" />
          MAHI
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
        <button className="ghost" onClick={() => setShowExternalTools(true)} title={t("manageExternalTools")}>
          <Blocks size={14} />
        </button>
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
          <button className="act-btn" onClick={() => setShowUsage(true)} title={t("usageLimit")}>
            <BarChart3 size={19} />
          </button>
        </div>

        {!workspace ? (
          <div className="welcome" style={{ flex: 1 }}>
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
          <PanelGroup direction="horizontal" style={{ flex: 1 }}>
            {sideView && (
              <Panel key="side" order={1} defaultSize={17} minSize={11}>
                <div className="sidebar">
                  {sideView === "files" ? (
                    <>
                      <div className="panel-header">
                        <Files size={11} /> {t("files")}
                      </div>
                      <FileTree workspace={workspace} onOpenFile={openFile} version={treeVersion} />
                    </>
                  ) : (
                    <SearchPanel workspace={workspace} onOpen={openFile} />
                  )}
                </div>
              </Panel>
            )}
            {sideView && <PanelResizeHandle key="side-h" className="resize-h" />}

            <Panel key="center" order={2} defaultSize={sideView ? 55 : 72} minSize={25}>
              <PanelGroup direction="vertical">
                <Panel key="editor" order={1} defaultSize={showTerminal ? 68 : 100} minSize={20}>
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
                {showTerminal && <PanelResizeHandle key="term-h" className="resize-v" />}
                {showTerminal && (
                  <Panel key="terminal" order={2} defaultSize={32} minSize={10}>
                    <div className="sidebar" style={{ background: "var(--bg-0)" }}>
                      <div className="panel-header">
                        <TerminalSquare size={11} /> {t("terminal")}
                      </div>
                      <div style={{ flex: 1, minHeight: 0 }}>
                        <TerminalPanel workspace={workspace} />
                      </div>
                    </div>
                  </Panel>
                )}
              </PanelGroup>
            </Panel>

            {showChat && <PanelResizeHandle key="chat-h" className="resize-h" />}
            {showChat && (
              <Panel key="chat" order={3} defaultSize={28} minSize={18}>
                <ChatPanel
                  provider={activeProvider}
                  providers={providers}
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
        />
      )}

      {showModels && <ModelsModal onClose={() => setShowModels(false)} />}
      {showExternalTools && <ExternalToolsModal onClose={() => setShowExternalTools(false)} />}

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
