import { useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";
import { X } from "lucide-react";
import { langForPath } from "./monacoSetup";
import { EditorTab, isDirty, baseName } from "./types";
import type { GotoTarget } from "../App";
import mahiLogo from "../assets/mahi.png";
import { t, useLang } from "./i18n";

export default function EditorArea({
  tabs,
  activeIndex,
  onSelect,
  onClose,
  onChange,
  onSave,
  goto,
}: {
  tabs: EditorTab[];
  activeIndex: number;
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onChange: (path: string, content: string) => void;
  onSave: (path: string) => void;
  goto: GotoTarget | null;
}) {
  useLang();
  const active = tabs[activeIndex];
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const saveRef = useRef(onSave);
  saveRef.current = onSave;

  useEffect(() => {
    if (goto && active && goto.path === active.path && editorRef.current) {
      editorRef.current.revealLineInCenter(goto.line);
      editorRef.current.setPosition({ lineNumber: goto.line, column: 1 });
      editorRef.current.focus();
    }
  }, [goto, active?.path]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minWidth: 0, background: "var(--bg-0)" }}>
      {tabs.length > 0 && (
        <div className="tabs">
          {tabs.map((t, i) => {
            const dirty = isDirty(t);
            return (
              <div
                key={t.path}
                onClick={() => onSelect(i)}
                title={t.path}
                className={`tab ${i === activeIndex ? "on" : ""}`}
              >
                <span dir="ltr">{baseName(t.path)}</span>
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
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {active ? (
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
        ) : (
          <div className="welcome">
            <img src={mahiLogo} alt="MAHI" className="welcome-logo" style={{ width: 84, height: 84 }} />
            <div className="sub">
              {t("editorEmpty")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
