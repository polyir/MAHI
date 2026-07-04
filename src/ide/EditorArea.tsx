import { useEffect, useReducer, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { X, Code, Eye, ArrowRightLeft, Globe, Plus, RotateCw } from "lucide-react";
import { langForPath } from "./monacoSetup";
import { kindForPath, isBinaryKind } from "./fileKind";
import { resolveDirection, setDirOverride } from "./textDirection";
import { EditorTab, isDirty, baseName } from "./types";
import type { GotoTarget } from "../App";
import mahiLogo from "../assets/mahi.png";
import { t, useLang } from "./i18n";
import MarkdownPreview from "./preview/MarkdownPreview";
import JsonPreview from "./preview/JsonPreview";
import TablePreview from "./preview/TablePreview";
import ImagePreview from "./preview/ImagePreview";
import MediaPreview from "./preview/MediaPreview";
import PdfPreview from "./preview/PdfPreview";
import BrowserTabView, { BrowserTab } from "./BrowserTabView";

const RENDERABLE = new Set(["markdown", "json", "csv", "tsv"]);

export default function EditorArea({
  workspace,
  tabs,
  activeIndex,
  onSelect,
  onClose,
  onChange,
  onSave,
  goto,
  browserTabs,
  activeBrowserId,
  onSelectBrowser,
  onCloseBrowser,
  onNavigateBrowser,
  onNewBrowserTab,
}: {
  workspace: string;
  tabs: EditorTab[];
  activeIndex: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  goto: GotoTarget | null;
  browserTabs: BrowserTab[];
  activeBrowserId: string | null;
  onSelectBrowser: (id: string) => void;
  onCloseBrowser: (id: string) => void;
  onNavigateBrowser: (id: string, url: string) => void;
  onNewBrowserTab: () => void;
}) {
  useLang();
  const active = tabs[activeIndex];
  const activeBrowserTab = browserTabs.find((b) => b.id === activeBrowserId) ?? null;
  const browserActive = activeBrowserTab !== null;
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const [previewMode, setPreviewMode] = useState<Record<string, "raw" | "rendered">>({});
  // Bumps to force a re-render after toggling a direction override, which
  // lives in localStorage (via textDirection.ts) rather than React state.
  const [, bumpDir] = useReducer((x: number) => x + 1, 0);
  const [addressInput, setAddressInput] = useState("");

  useEffect(() => {
    if (goto && active && goto.path === active.path && editorRef.current) {
      editorRef.current.revealLineInCenter(goto.line);
      editorRef.current.setPosition({ lineNumber: goto.line, column: 1 });
      editorRef.current.focus();
    }
  }, [goto, active?.path]);

  // Sync the address bar to whichever browser tab is active (not on every
  // navigation, so typing isn't clobbered mid-edit by our own updates).
  useEffect(() => {
    if (activeBrowserTab) setAddressInput(activeBrowserTab.url);
  }, [activeBrowserTab?.id]);

  function goAddress() {
    if (!activeBrowserTab) return;
    let next = addressInput.trim();
    if (!next) return;
    if (!/^[a-zA-Z]+:\/\//.test(next)) next = "https://" + next;
    setAddressInput(next);
    onNavigateBrowser(activeBrowserTab.id, next);
  }

  const kind = active ? kindForPath(active.path) : "text";
  const mode = active ? previewMode[active.path] ?? "rendered" : "rendered";
  const showModeToggle = !browserActive && RENDERABLE.has(kind);
  const showDirToggle = !browserActive && !!active && !isBinaryKind(kind);
  const resolvedDir = active ? resolveDirection(active.path, active.content) : "ltr";

  function toggleMode() {
    if (!active) return;
    setPreviewMode((cur) => ({ ...cur, [active.path]: mode === "rendered" ? "raw" : "rendered" }));
  }

  function toggleDirection() {
    if (!active) return;
    setDirOverride(active.path, resolvedDir === "rtl" ? "ltr" : "rtl");
    bumpDir();
  }

  function fallbackToRaw(path: string) {
    setPreviewMode((cur) => ({ ...cur, [path]: "raw" }));
  }

  let body: React.ReactNode = null;
  if (active) {
    if (kind === "image") {
      body = <ImagePreview workspace={workspace} path={active.path} />;
    } else if (kind === "audio" || kind === "video") {
      body = <MediaPreview workspace={workspace} path={active.path} kind={kind} />;
    } else if (kind === "pdf") {
      body = <PdfPreview workspace={workspace} path={active.path} />;
    } else if (kind === "markdown" && mode === "rendered") {
      body = <MarkdownPreview content={active.content} dir={resolvedDir} />;
    } else if (kind === "json" && mode === "rendered") {
      body = (
        <JsonPreview content={active.content} onParseError={() => fallbackToRaw(active.path)} />
      );
    } else if ((kind === "csv" || kind === "tsv") && mode === "rendered") {
      body = <TablePreview content={active.content} delimiter={kind === "csv" ? "," : "\t"} />;
    } else {
      body = (
        <Editor
          key={active.path}
          height="100%"
          theme="vs-dark"
          path={active.path}
          language={langForPath(active.path)}
          value={active.content}
          onChange={(v) => onChange(active.path, v ?? "")}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              saveRef.current(active.path);
            });
          }}
          options={{
            fontSize: 13,
            fontFamily: "SF Mono, Menlo, Monaco, monospace",
            minimap: { enabled: true, renderCharacters: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            tabSize: 2,
            renderWhitespace: "selection",
            smoothScrolling: true,
            cursorBlinking: "smooth",
            padding: { top: 8 },
          }}
        />
      );
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, background: "var(--bg-0)" }}>
      <div className="tabs">
        {tabs.map((tab, i) => {
          const dirty = isDirty(tab);
          return (
            <div
              key={tab.path}
              onClick={() => onSelect(i)}
              title={tab.path}
              className={`tab ${!browserActive && i === activeIndex ? "on" : ""}`}
            >
              <span dir="ltr">{baseName(tab.path)}</span>
              {dirty && <span className="dot">●</span>}
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(i);
                }}
              >
                <X size={12} />
              </span>
            </div>
          );
        })}
        {browserTabs.map((bt) => (
          <div
            key={bt.id}
            onClick={() => onSelectBrowser(bt.id)}
            title={bt.url}
            className={`tab ${bt.id === activeBrowserId ? "on" : ""}`}
          >
            <Globe size={12} />
            <span dir="ltr">{bt.title || bt.url}</span>
            <span
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                onCloseBrowser(bt.id);
              }}
            >
              <X size={12} />
            </span>
          </div>
        ))}
        <div className="tab" onClick={onNewBrowserTab} title={t("browserTitle")}>
          <Plus size={13} />
        </div>
      </div>

      {!browserActive && active && (showModeToggle || showDirToggle) && (
        <div className="preview-toolbar">
          {showModeToggle && (
            <button className="ghost" onClick={toggleMode} title={mode === "rendered" ? t("rawView") : t("renderedView")}>
              {mode === "rendered" ? <Code size={13} /> : <Eye size={13} />}
            </button>
          )}
          {showDirToggle && (
            <button className="ghost" onClick={toggleDirection} title={t("toggleDirection")}>
              <ArrowRightLeft size={13} /> {resolvedDir.toUpperCase()}
            </button>
          )}
        </div>
      )}

      {browserActive && (
        <div className="preview-toolbar" dir="ltr">
          <input
            dir="ltr"
            value={addressInput}
            onChange={(e) => setAddressInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && goAddress()}
            style={{ flex: 1 }}
            placeholder="https://…"
          />
          <button className="ghost" onClick={goAddress} title="Go">
            <RotateCw size={13} />
          </button>
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {!browserActive &&
          (active ? (
            body
          ) : (
            <div className="welcome">
              <img src={mahiLogo} alt="MAHI" className="welcome-logo" style={{ width: 84, height: 84 }} />
              <div className="sub">{t("editorEmpty")}</div>
            </div>
          ))}
        {browserTabs.map((bt) => (
          <BrowserTabView key={bt.id} tab={bt} isActive={bt.id === activeBrowserId} />
        ))}
      </div>
    </div>
  );
}
