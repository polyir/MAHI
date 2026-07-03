export type EditorTab = {
  path: string; // relative to workspace
  content: string;
  original: string; // last-saved content, to compute dirty state
};

export function isDirty(tab: EditorTab): boolean {
  return tab.content !== tab.original;
}

export function baseName(path: string): string {
  return path.split("/").pop() ?? path;
}
