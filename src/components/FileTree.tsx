import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Folder, FolderOpen, FileText, Image, Music, Video } from "lucide-react";
import { t, useLang } from "../ide/i18n";
import { kindForPath } from "../ide/fileKind";
import {
  baseName,
  FILE_DRAG_MIME,
  joinRel,
  parentDir,
  readFileDragData,
  setFileDragData,
  uniqueDestName,
} from "../ide/fileOps";

type ContextMenuState = { x: number; y: number; workspace: string; relPath: string; isDir: boolean };
type ClipboardEntry = { relPath: string; isDir: boolean; mode: "copy" | "cut" };

function FileContextMenu({
  menu,
  clipboard,
  onClose,
  onCopy,
  onCut,
  onPaste,
}: {
  menu: ContextMenuState;
  clipboard: ClipboardEntry | null;
  onClose: () => void;
  onCopy: (relPath: string, isDir: boolean) => void;
  onCut: (relPath: string, isDir: boolean) => void;
  onPaste: (menu: ContextMenuState) => void;
}) {
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", (e) => e.key === "Escape" && onClose());
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
    onClose();
  }

  const isRoot = menu.relPath === ".";

  return (
    <div
      className="context-menu"
      style={{ position: "fixed", left: menu.x, top: menu.y, zIndex: 100 }}
      onClick={(e) => e.stopPropagation()}
    >
      {!isRoot && (
        <>
          <div className="tree-node" onClick={() => copy(`${menu.workspace}/${menu.relPath}`)}>
            {t("copyPath")}
          </div>
          <div className="tree-node" onClick={() => copy(menu.relPath)}>
            {t("copyRelativePath")}
          </div>
          <div
            className="tree-node"
            onClick={() => {
              onCopy(menu.relPath, menu.isDir);
              onClose();
            }}
          >
            {t("copyFile")}
          </div>
          <div
            className="tree-node"
            onClick={() => {
              onCut(menu.relPath, menu.isDir);
              onClose();
            }}
          >
            {t("cutFile")}
          </div>
        </>
      )}
      {clipboard && (
        <div
          className="tree-node"
          onClick={() => {
            onPaste(menu);
            onClose();
          }}
        >
          {t("pasteFile")}
        </div>
      )}
    </div>
  );
}

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
  onContextMenu,
  onDropInto,
  index,
}: {
  workspace: string;
  relPath: string;
  name: string;
  isDir: boolean;
  onOpenFile: (relPath: string) => void;
  depth: number;
  version: number;
  onContextMenu: (e: React.MouseEvent, relPath: string, isDir: boolean) => void;
  onDropInto: (targetRelPath: string, targetIsDir: boolean, payload: ReturnType<typeof readFileDragData>) => void;
  index: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<Entry[] | null>(null);
  const [dragOver, setDragOver] = useState(false);

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
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e, relPath, isDir);
        }}
        draggable
        onDragStart={(e) => setFileDragData(e, { workspace, relPath, isDir })}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setDragOver(false);
          onDropInto(relPath, isDir, readFileDragData(e));
        }}
        className="tree-node stagger-item"
        dir="ltr"
        style={{
          paddingLeft: 8 + depth * 12,
          background: dragOver ? "var(--accent-soft)" : undefined,
          "--i": index,
        } as React.CSSProperties}
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
        children?.map((c, idx) => (
          <Node
            key={c.name}
            workspace={workspace}
            relPath={`${relPath}/${c.name}`}
            name={c.name}
            isDir={c.is_dir}
            onOpenFile={onOpenFile}
            depth={depth + 1}
            version={version}
            onContextMenu={onContextMenu}
            onDropInto={onDropInto}
            index={idx}
          />
        ))}
    </div>
  );
}

export default function FileTree({
  workspace,
  onOpenFile,
  version = 0,
  toast,
}: {
  workspace: string;
  onOpenFile: (relPath: string) => void;
  version?: number;
  toast?: (text: string, kind?: "ok" | "err") => void;
}) {
  useLang();
  const [rootEntries, setRootEntries] = useState<Entry[] | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardEntry | null>(null);

  useEffect(() => {
    if (!workspace) {
      setRootEntries(null);
      return;
    }
    invoke<Entry[]>("list_dir", { workspace, path: "." })
      .then((entries) => setRootEntries(sortEntries(entries)))
      .catch(() => setRootEntries([]));
  }, [workspace, version]);

  async function moveOrCopy(mode: "copy" | "cut", srcRelPath: string, srcIsDir: boolean, targetDirRaw: string) {
    const targetDir = targetDirRaw === "." ? "" : targetDirRaw;
    if (srcIsDir && (targetDir === srcRelPath || targetDir.startsWith(`${srcRelPath}/`))) {
      toast?.(t("cannotMoveIntoSelf"), "err");
      return;
    }
    if (mode === "cut" && targetDir === parentDir(srcRelPath)) return; // already there
    try {
      const destName = await uniqueDestName(workspace, targetDir, baseName(srcRelPath));
      const destRel = joinRel(targetDir, destName);
      await invoke(mode === "copy" ? "copy_file" : "move_file", { workspace, from: srcRelPath, to: destRel });
    } catch (e) {
      toast?.(String(e), "err");
    }
  }

  function handlePaste(menu: ContextMenuState) {
    if (!clipboard) return;
    const targetDir = menu.isDir ? menu.relPath : parentDir(menu.relPath);
    moveOrCopy(clipboard.mode, clipboard.relPath, clipboard.isDir, targetDir);
    if (clipboard.mode === "cut") setClipboard(null);
  }

  function handleDropInto(targetRelPath: string, targetIsDir: boolean, payload: ReturnType<typeof readFileDragData>) {
    if (!payload || payload.workspace !== workspace) return;
    if (payload.relPath === targetRelPath) return; // dropped onto itself
    const targetDir = targetIsDir ? (targetRelPath === "." ? "" : targetRelPath) : parentDir(targetRelPath);
    if (targetDir === parentDir(payload.relPath)) return; // already there
    moveOrCopy("cut", payload.relPath, payload.isDir, targetDir);
  }

  if (!workspace) {
    return <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>{t("noFolderSelected")}</div>;
  }
  if (rootEntries === null) {
    return <div style={{ padding: 10, fontSize: 12, opacity: 0.6 }}>{t("loading")}</div>;
  }

  return (
    <div
      style={{ overflowY: "auto", flex: 1, paddingBottom: 8 }}
      onContextMenu={(e) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, workspace, relPath: ".", isDir: true });
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(FILE_DRAG_MIME)) return;
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        handleDropInto(".", true, readFileDragData(e));
      }}
    >
      {rootEntries.map((e, idx) => (
        <Node
          key={e.name}
          workspace={workspace}
          relPath={e.name}
          name={e.name}
          isDir={e.is_dir}
          onOpenFile={onOpenFile}
          depth={0}
          version={version}
          onContextMenu={(e2, relPath, isDir) => setContextMenu({ x: e2.clientX, y: e2.clientY, workspace, relPath, isDir })}
          onDropInto={handleDropInto}
          index={idx}
        />
      ))}
      {contextMenu && (
        <FileContextMenu
          menu={contextMenu}
          clipboard={clipboard}
          onClose={() => setContextMenu(null)}
          onCopy={(relPath, isDir) => setClipboard({ relPath, isDir, mode: "copy" })}
          onCut={(relPath, isDir) => setClipboard({ relPath, isDir, mode: "cut" })}
          onPaste={handlePaste}
        />
      )}
    </div>
  );
}
