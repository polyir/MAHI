import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, FolderOpen, FileText, Image, Music, Video } from "lucide-react";
import { t, useLang } from "../ide/i18n";
import { kindForPath } from "../ide/fileKind";

function FileIcon({ path }: { path: string }) {
  const kind = kindForPath(path);
  const style = { color: "var(--text-faint)", flexShrink: 0 } as const;
  if (kind === "image") return <Image size={14} style={style} />;
  if (kind === "audio") return <Music size={14} style={style} />;
  if (kind === "video") return <Video size={14} style={style} />;
  return <FileText size={14} style={style} />;
}

type Entry = { name: string; is_dir: boolean };

function sortEntries(entries: Entry[]): Entry[] {
  return [...entries].sort((a, b) =>
    a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1
  );
}

function Node({
  workspace,
  relPath,
  name,
  isDir,
  onOpenFile,
  depth,
  version,
}: {
  workspace: string;
  relPath: string;
  name: string;
  isDir: boolean;
  onOpenFile: (relPath: string) => void;
  depth: number;
  version: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);

  async function fetchChildren() {
    try {
      const entries = await invoke<Entry[]>("list_dir", { workspace, path: relPath });
      setChildren(sortEntries(entries));
    } catch {
      setChildren([]);
    }
  }

  // Re-fetch children of expanded dirs when the tree version bumps (agent
  // created/deleted files), so new files appear without collapsing the tree.
  useEffect(() => {
    if (isDir && expanded) fetchChildren();
  }, [version]);

  async function toggle() {
    if (!isDir) {
      onOpenFile(relPath);
      return;
    }
    if (!expanded && children === null) await fetchChildren();
    setExpanded(!expanded);
  }

  return (
    <div>
      <div
        onClick={toggle}
        className="tree-node"
        dir="ltr"
        style={{ paddingLeft: 8 + depth * 12 }}
        title={relPath}
      >
        {isDir ? (
          expanded ? (
            <FolderOpen size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
          ) : (
            <Folder size={14} style={{ color: "var(--text-faint)", flexShrink: 0 }} />
          )
        ) : (
          <FileIcon path={relPath} />
        )}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
      </div>
      {isDir &&
        expanded &&
        children?.map((c) => (
          <Node
            key={c.name}
            workspace={workspace}
            relPath={`${relPath}/${c.name}`}
            name={c.name}
            isDir={c.is_dir}
            onOpenFile={onOpenFile}
            depth={depth + 1}
            version={version}
          />
        ))}
    </div>
  );
}

export default function FileTree({
  workspace,
  onOpenFile,
  version = 0,
}: {
  workspace: string;
  onOpenFile: (relPath: string) => void;
  version?: number;
}) {
  useLang();
  const [rootEntries, setRootEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    if (!workspace) {
      setRootEntries(null);
      return;
    }
    invoke<Entry[]>("list_dir", { workspace, path: "." })
      .then((entries) => setRootEntries(sortEntries(entries)))
      .catch(() => setRootEntries([]));
  }, [workspace, version]);

  if (!workspace) {
    return <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>{t("noFolderSelected")}</div>;
  }
  if (rootEntries === null) {
    return <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>{t("loading")}</div>;
  }

  return (
    <div style={{ overflowY: "auto", flex: 1, paddingBottom: 8 }}>
      {rootEntries.map((e) => (
        <Node
          key={e.name}
          workspace={workspace}
          relPath={e.name}
          name={e.name}
          isDir={e.is_dir}
          onOpenFile={onOpenFile}
          depth={0}
          version={version}
        />
      ))}
    </div>
  );
}
