// Thin wrapper around src-tauri/src/external_tools.rs's three commands —
// same pattern as models.ts/localLlm.ts's invoke wrappers.
import { invoke } from "@tauri-apps/api/core";

export type ExternalTool = {
  id: string;
  name: string;
  description: string;
  docsUrl: string;
};

export async function listExternalTools(): Promise<ExternalTool[]> {
  const raw = await invoke<{ id: string; name: string; description: string; docs_url: string }[]>(
    "external_tools_list"
  );
  return raw.map((t) => ({ id: t.id, name: t.name, description: t.description, docsUrl: t.docs_url }));
}

export function checkExternalToolInstalled(toolId: string): Promise<boolean> {
  return invoke<boolean>("external_tool_status", { toolId });
}

export function installExternalTool(toolId: string): Promise<string> {
  return invoke<string>("external_tool_install", { toolId });
}

// Cached check for ChatPanel's buildSystemContent (see graphifySystemNote
// below) — checked once per app session rather than on every single turn,
// same reasoning as localLlm.ts's installedIds() cache.
let graphifyCache: { at: number; installed: boolean } | null = null;

export async function isGraphifyAvailable(): Promise<boolean> {
  if (graphifyCache && Date.now() - graphifyCache.at < 60_000) return graphifyCache.installed;
  const installed = await checkExternalToolInstalled("graphify").catch(() => false);
  graphifyCache = { at: Date.now(), installed };
  return installed;
}

export const GRAPHIFY_SYSTEM_NOTE = `Graphify (\`graphify\`) is installed and available via run_command. To build/update this project's knowledge graph: \`graphify extract .\` (add --force to fully rebuild). To query it: \`graphify query "..."\`, \`graphify path "A" "B"\`, \`graphify explain "X"\`. Output lives in graphify-out/ (graph.html can be opened for the user via open_file_in_editor). Prefer this over many manual greps for broad architecture/relationship questions about the codebase.`;
