// Thin wrappers around the Rust mcp_servers commands that download the
// studio MCP servers (Photoshop/After Effects/Premiere/OBS) into a hidden
// folder under the user's Documents directory (see src-tauri/src/
// mcp_servers.rs). Progress arrives as "mcp-servers://progress" events —
// there's only ever one install running at a time, so unlike LibraryModal's
// per-operation-id events, callers just subscribe for the duration of the call.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type StudioMcpStatus = { installed: boolean; version: string | null; dir: string };
export type StudioMcpProgress = { phase: string; percent: number | null; message: string };

export function checkStudioMcpStatus(): Promise<StudioMcpStatus> {
  return invoke<StudioMcpStatus>("mcp_servers_status");
}

export async function installStudioMcp(onProgress?: (p: StudioMcpProgress) => void): Promise<StudioMcpStatus> {
  let unlisten: (() => void) | undefined;
  if (onProgress) {
    unlisten = await listen<StudioMcpProgress>("mcp-servers://progress", (e) => onProgress(e.payload));
  }
  try {
    return await invoke<StudioMcpStatus>("mcp_servers_install");
  } finally {
    unlisten?.();
  }
}
