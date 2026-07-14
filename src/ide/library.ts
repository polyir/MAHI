import { invoke } from "@tauri-apps/api/core";

export type LibraryItem = {
  id: string;
  name: string;
  description: string;
  path: string;
  bundleRoot: string;
  sourceRoot: string;
  content: string;
  files: Array<{ name: string; path: string; size: number; fileType: string }>;
  imagePaths: string[];
  git: boolean;
  sourceKind: "git" | "local";
  sourceUrl: string;
  sourceDirectory: string;
  revision: string;
  updateAvailable: boolean;
};

const key = (projectId: string) => `mahi_library_enabled:skills:${projectId}`;
const NAMES_KEY = "mahi_library_names";

function names(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(NAMES_KEY) ?? "{}"); } catch { return {}; }
}

export function libraryDisplayName(item: LibraryItem): string { return names()[item.id]?.trim() || item.name; }
export function setLibraryDisplayName(item: LibraryItem, value: string) {
  const current = names();
  if (value.trim() && value.trim() !== item.name) current[item.id] = value.trim(); else delete current[item.id];
  localStorage.setItem(NAMES_KEY, JSON.stringify(current));
}

export function enabledLibraryIds(projectId: string): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(key(projectId)) ?? "[]")); }
  catch { return new Set(); }
}

export function saveEnabledLibraryIds(projectId: string, ids: Set<string>) {
  localStorage.setItem(key(projectId), JSON.stringify([...ids]));
}

export function enabledLibraryCount(items: LibraryItem[], projectId: string): number {
  const enabled = enabledLibraryIds(projectId);
  return items.filter((item) => enabled.has(item.id)).length;
}

export async function listLibrary(): Promise<LibraryItem[]> {
  return invoke("library_list", { kind: "skills" });
}

export function activeLibraryItems(items: LibraryItem[], projectId: string): LibraryItem[] {
  const enabled = enabledLibraryIds(projectId);
  return items.filter((item) => enabled.has(item.id));
}

export async function loadLibraryImages(skills: LibraryItem[]): Promise<string[]> {
  const paths = skills.flatMap((item) => item.imagePaths);
  if (!paths.length) return [];
  return invoke("library_load_images", { paths });
}

export function libraryPrompt(active: LibraryItem[]): string {
  if (!active.length) return "";
  let remaining = 80_000;
  const blocks: string[] = [];
  for (const item of active) {
    if (remaining <= 0) break;
    const content = item.content.slice(0, Math.min(30_000, remaining));
    remaining -= content.length;
    blocks.push(`\n--- ${libraryDisplayName(item)} (bundle: ${item.bundleRoot}) ---\n${content}`);
  }
  return `\n\n<USER-SELECTED SKILLS>\nThe user selected these skill folders for this message and granted read access to them. Their directory maps include arbitrary reference files; use only these selected skills.${blocks.join("")}\n</USER-SELECTED SKILLS>`;
}

export async function saveProjectSkillMap(workspace: string, projectId: string, items: LibraryItem[], enabled: Set<string>) {
  await invoke("library_save_project_map", {
    workspace,
    skills: items.map((item) => ({
      id: item.id,
      name: libraryDisplayName(item),
      directory: item.bundleRoot,
      enabled: enabled.has(item.id),
      files: item.files,
    })),
  });
  saveEnabledLibraryIds(projectId, enabled);
}
