import { useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Search } from "lucide-react";
import { t, useLang } from "./i18n";

type Hit = { path: string; line: number; text: string };

function parseResults(raw: string): Hit[] {
  if (raw === "No matches found.") return [];
  return raw
    .split("\n")
    .map((l) => {
      const m = l.match(/^(.+?):(\d+): (.*)$/);
      return m ? { path: m[1], line: Number(m[2]), text: m[3] } : null;
    })
    .filter((x): x is Hit => x !== null);
}

export default function SearchPanel({
  workspace,
  onOpen,
}: {
  workspace: string;
  onOpen: (relPath: string, line?: number) => void;
}) {
  useLang();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function search(q: string) {
    setQuery(q);
    clearTimeout(debounce.current);
    if (!q.trim()) {
      setHits(null);
      return;
    }
    debounce.current = setTimeout(async () => {
      setBusy(true);
      try {
        const raw = await invoke<string>("search_files", {
          workspace,
          query: q,
          isRegex: false,
          maxResults: 200,
        });
        setHits(parseResults(raw));
      } catch {
        setHits([]);
      } finally {
        setBusy(false);
      }
    }, 300);
  }

  // Group hits by file for a tidy tree-like result list.
  const groups = new Map<string, Hit[]>();
  for (const h of hits ?? []) {
    if (!groups.has(h.path)) groups.set(h.path, []);
    groups.get(h.path)!.push(h);
  }

  return (
    <>
      <div className="panel-header">
        <Search size={11} /> {t("searchInProject")}
      </div>
      <div style={{ padding: "0 8px 8px" }}>
        <input
          style={{ width: "100%" }}
          dir="auto"
          placeholder={t("searchPlaceholder")}
          value={query}
          onChange={(e) => search(e.target.value)}
        />
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0 4px" }}>
        {busy && <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>{t("searching")}</div>}
        {!busy && hits !== null && hits.length === 0 && (
          <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>{t("notFound")}</div>
        )}
        {!busy &&
          Array.from(groups.entries()).map(([path, fileHits]) => (
            <div key={path} style={{ marginBottom: 6 }}>
              <div
                dir="ltr"
                style={{
                  fontSize: 11.5,
                  fontWeight: 600,
                  color: "var(--accent)",
                  padding: "3px 8px",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={path}
              >
                {path} <span style={{ opacity: 0.55, fontWeight: 400 }}>({fileHits.length})</span>
              </div>
              {fileHits.map((h, i) => (
                <div
                  key={i}
                  className="tree-node"
                  dir="ltr"
                  onClick={() => onOpen(h.path, h.line)}
                  title={h.text}
                >
                  <span style={{ color: "var(--text-faint)", fontSize: 11 }}>{h.line}</span>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{h.text}</span>
                </div>
              ))}
            </div>
          ))}
      </div>
    </>
  );
}
