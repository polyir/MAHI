// Persisted library for Prompt Lab's "Saved Prompts" — separate from the
// per-session version history (which lives only in PromptLabModal's own
// state and resets each time the modal is reopened, same as its message
// trail). Saved prompts are explicit, named, and survive across sessions.
export type SavedPrompt = { id: string; name: string; content: string; createdAt: number };

const SAVED_PROMPTS_KEY = "mahi_saved_prompts";

export function loadSavedPrompts(): SavedPrompt[] {
  try {
    return JSON.parse(localStorage.getItem(SAVED_PROMPTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveSavedPrompts(prompts: SavedPrompt[]): void {
  localStorage.setItem(SAVED_PROMPTS_KEY, JSON.stringify(prompts));
}
