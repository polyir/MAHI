import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FileText, FolderOpen, TerminalSquare, MessageSquare, BarChart3, Save, Zap } from "lucide-react";
import { t, useLang } from "./i18n";

export type PaletteAction = { label: string; run: () => void; icon: string };

// Simple subsequence fuzzy match; returns a score (higher = better) or -1.
function fuzzyScore(query: string, target: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      streak++;
      score += streak * 2;
      if (ti === 0 || t[ti - 1] === "/" || t[ti - 1] === "." || t[ti - 1] === "-" || t[ti - 1] === "_") {
        score += 6; // word-boundary bonus
      }
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) return -1;
  return score - Math.floor(t.length / 8); // prefer shorter paths
}

const ACTION_ICONS: Record<string, React.ReactNode> = {
  folder: <FolderOpen size={14} />,
  terminal: <TerminalSquare size={14} />,
  chat: <MessageSquare size={14} />,
  usage: <BarChart3 size={14} />,
  save: <Save size={14} />,
};

export default function CommandPalette({
  mode,
  workspace,
  actions,
  onOpenFile,
  onClose,
}: {
  mode: "files" | "actions";
  workspace: string;
  actions: PaletteAction[];
  onOpenFile: (relPath: string) => void;
  onClose: () => void;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (mode === "files" && workspace) {
      invoke<string>("project_tree", { workspace, maxEntries: 5000 })
        .then((tree) => setFiles(tree ? tree.split("\n").filter(Boolean) : []))
        .catch(() => setFiles([]));
    }
  }, [mode, workspace]);

  const items = useMemo(() => {
    if (mode === "actions") {
      return actions
        .map((a, i) => ({ key: String(i), label: a.label, score: fuzzyScore(query, a.label), action: a }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 12);
    }
    return files
      .map((f) => ({ key: f, label: f, score: fuzzyScore(query, f), action: undefined as PaletteAction | undefined }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14);
  }, [mode, query, files, actions]);

  useEffect(() => setSel(0), [query, mode]);

  function pick(i: number) {
    const item = items[i];
    if (!item) return;
    onClose();
    if (mode === "actions" && item.action) item.action.run();
    else if (mode === "files") onOpenFile(item.label);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(sel);
    }
  }

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${sel}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          dir="auto"
          placeholder={mode === "files" ? t("palFilePlaceholder") : t("palActionPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list" ref={listRef}>
          {items.map((item, i) => (
            <div
              key={item.key}
              data-idx={i}
              className={`palette-item ${i === sel ? "sel" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(i)}
            >
              {mode === "actions" ? (
                ACTION_ICONS[item.action!.icon] ?? <Zap size={14} />
              ) : (
                <FileText size={14} />
              )}
              <span dir="ltr" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.label}
              </span>
              {i === sel && <span className="hint">⏎</span>}
            </div>
          ))}
          {items.length === 0 && (
            <div className="palette-item" style={{ opacity: 0.5 }}>
              {t("noResults")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
