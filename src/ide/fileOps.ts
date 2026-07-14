// Shared helpers for the file tree's copy/cut/paste and drag-and-drop —
// including dragging a tree entry into ChatPanel as an attachment, which is
// why the drag payload format lives here rather than inside FileTree.tsx.
import { invoke } from "@tauri-apps/api/core";

export const FILE_DRAG_MIME = "application/x-mahi-file";

export type FileDragPayload = { workspace: string; relPath: string; isDir: boolean };

export function setFileDragData(e: React.DragEvent, payload: FileDragPayload) {
  e.dataTransfer.setData(FILE_DRAG_MIME, JSON.stringify(payload));
  e.dataTransfer.setData("text/plain", payload.relPath);
  e.dataTransfer.effectAllowed = "copyMove";
}

export function readFileDragData(e: React.DragEvent): FileDragPayload | null {
  const raw = e.dataTransfer.getData(FILE_DRAG_MIME);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as FileDragPayload;
  } catch {
    return null;
  }
}

export function parentDir(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? "" : relPath.slice(0, idx);
}

export function baseName(relPath: string): string {
  const idx = relPath.lastIndexOf("/");
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

// Finder/VS Code-style non-colliding name: "file.txt" -> "file copy.txt" ->
// "file copy 2.txt" ... Used so copy/paste and cross-folder moves never
// silently clobber an existing file with the same name.
export async function uniqueDestName(workspace: string, targetDir: string, name: string): Promise<string> {
  let existing: Set<string>;
  try {
    const entries = await invoke<{ name: string; is_dir: boolean }[]>("list_dir", {
      workspace,
      path: targetDir || ".",
    });
    existing = new Set(entries.map((e) => e.name));
  } catch {
    return name;
  }
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = `${stem} copy${ext}`;
  let n = 2;
  while (existing.has(candidate)) {
    candidate = `${stem} copy ${n}${ext}`;
    n++;
  }
  return candidate;
}
