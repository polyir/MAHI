// A "project" is a chat-side directory binding, deliberately separate from
// the IDE's own "open folder" — you can browse/edit one folder in the
// editor while a chat (or several chats, grouped by project) operates on a
// completely different directory.
export type Project = {
  id: string;
  name: string;
  directory: string;
  // Permanently-trusted flag for the call_model tool (cross-model
  // delegation) — set only via the confirmation popup's "keep enabled for
  // this project" checkbox, or directly in Project Settings. Missing/false
  // means: the per-session switch in ChatPanel can still turn call_model on
  // for one session, but sending a message with it on always asks for
  // confirmation first since the project hasn't been permanently trusted.
  allowModelRouting?: boolean;
  // Prepended to every chat's system prompt for this project (see
  // ChatPanel's buildSystemContent) — persistent, project-wide context/
  // rules, as opposed to SessionSettings.systemPrompt which is per-chat and
  // reset for each new session.
  instructions?: string;
};

const PROJECTS_KEY = "mahi_projects";
const ACTIVE_PROJECT_KEY = "mahi_active_project";

function baseName(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

export function loadProjects(): Project[] {
  try {
    const raw = localStorage.getItem(PROJECTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    // fall through to the seeded default below
  }
  // Back-compat: before projects existed, every chat used the IDE's open
  // workspace as its directory. Seed one project from that so existing
  // chats keep working without the user having to set anything up.
  const directory = localStorage.getItem("vibe_workspace") ?? "";
  return [{ id: "default", name: directory ? baseName(directory) : "Default", directory }];
}

export function saveProjects(projects: Project[]) {
  localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));
}

export function loadActiveProjectId(): string {
  return localStorage.getItem(ACTIVE_PROJECT_KEY) ?? "default";
}

export function saveActiveProjectId(id: string) {
  localStorage.setItem(ACTIVE_PROJECT_KEY, id);
}

export function newProject(directory: string): Project {
  return { id: crypto.randomUUID(), name: baseName(directory), directory };
}
