// MCP (Model Context Protocol) servers configured for use in chat: each
// enabled server's tools get discovered (see mcp.rs's mcp_list_tools) and
// merged into the model's tool list alongside MAHI's own built-in tools
// (see agent.ts's agentTurn), then dispatched back through mcp_call_tool
// when the model calls one. Two transports are supported — "http"
// (Streamable HTTP, Bearer auth) and "stdio" (a spawned local process, e.g.
// `npx some-mcp-server`) — matching what real MCP servers actually use.
import { invoke } from "@tauri-apps/api/core";
import type OpenAI from "openai";

export type McpTransport = "http" | "stdio";

export type McpServer = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  // http
  url?: string;
  apiKey?: string;
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpToolInfo = { name: string; description: string; inputSchema: any };

const MCP_SERVERS_KEY = "mahi_mcp_servers";
export const STUDIO_MCP_DIR_KEY = "mahi_studio_mcp_dir";
const MCP_MIGRATION_KEY = "mahi_mcp_migration";
const CURRENT_MCP_MIGRATION = 1;

const STUDIO_MCP_PRESETS: { id: string; name: string; entry: string; env?: Record<string, string> }[] = [
  { id: "studio-photoshop", name: "Photoshop", entry: "photoshop/index.mjs" },
  { id: "studio-afterfx", name: "After Effects", entry: "afterfx/index.mjs" },
  { id: "studio-premiere", name: "Premiere Pro", entry: "premiere/index.mjs" },
  { id: "studio-obs", name: "OBS", entry: "obs/index.mjs", env: { OBS_WS_PASSWORD: "" } },
];

export function mergeStudioMcpServers(servers: McpServer[], rawDir: string): McpServer[] {
  const dir = rawDir.trim().replace(/\/+$/, "");
  if (!dir) return servers;
  const next: McpServer[] = servers.map((server) => ({
    ...server,
    env: server.env ? { ...server.env } : undefined,
  }));
  for (const preset of STUDIO_MCP_PRESETS) {
    const server: McpServer = {
      id: preset.id,
      name: preset.name,
      enabled: true,
      transport: "stdio",
      command: "node",
      args: [`${dir}/${preset.entry}`],
      env: preset.env,
    };
    const existing = next.findIndex((item) => item.id === preset.id);
    // Refresh managed paths while preserving user choices and secrets.
    if (existing >= 0) {
      next[existing] = {
        ...server,
        enabled: next[existing].enabled,
        env: { ...(preset.env ?? {}), ...(next[existing].env ?? {}) },
      };
    } else {
      next.push(server);
    }
  }
  return next;
}

// Z.AI's devpack MCP servers (https://docs.z.ai/devpack/mcp/*) — vision,
// web search, web reader, and zread (GitHub repo docs/search). All four use
// the same Z.AI Open Platform API key already entered for the "zai" (GLM)
// chat provider, so that key is reused here rather than asking for it twice.
export function defaultMcpServers(zaiApiKey: string): McpServer[] {
  return [
    {
      id: "zai-vision",
      name: "Z.AI Vision",
      enabled: true,
      transport: "stdio",
      command: "npx",
      args: ["-y", "@z_ai/mcp-server"],
      env: { Z_AI_API_KEY: zaiApiKey, Z_AI_MODE: "ZAI" },
    },
    {
      id: "zai-search",
      name: "Z.AI Search",
      enabled: true,
      transport: "http",
      url: "https://api.z.ai/api/mcp/web_search_prime/mcp",
      apiKey: zaiApiKey,
    },
    {
      id: "zai-reader",
      name: "Z.AI Reader",
      enabled: true,
      transport: "http",
      url: "https://api.z.ai/api/mcp/web_reader/mcp",
      apiKey: zaiApiKey,
    },
    {
      id: "zai-zread",
      name: "Z.AI Zread",
      enabled: true,
      transport: "http",
      url: "https://api.z.ai/api/mcp/zread/mcp",
      apiKey: zaiApiKey,
    },
  ];
}

export function loadMcpServers(zaiApiKey: string): McpServer[] {
  let servers: McpServer[];
  try {
    const raw = localStorage.getItem(MCP_SERVERS_KEY);
    if (!raw) servers = defaultMcpServers(zaiApiKey);
    else {
    const parsed: McpServer[] = JSON.parse(raw);
      servers = parsed.length ? parsed : defaultMcpServers(zaiApiKey);
    }
  } catch {
    servers = defaultMcpServers(zaiApiKey);
  }

  // One-time migration for users who installed the Studio bundle in an
  // earlier version but whose saved MCP list still only contains Z.AI.
  const migration = Number(localStorage.getItem(MCP_MIGRATION_KEY) ?? "0");
  if (migration < CURRENT_MCP_MIGRATION) {
    const studioDir = localStorage.getItem(STUDIO_MCP_DIR_KEY) ?? "";
    if (studioDir) servers = mergeStudioMcpServers(servers, studioDir);
    localStorage.setItem(MCP_MIGRATION_KEY, String(CURRENT_MCP_MIGRATION));
    localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers));
  }
  return servers;
}

export function saveMcpServers(servers: McpServer[]) {
  localStorage.setItem(MCP_SERVERS_KEY, JSON.stringify(servers));
  invalidateMcpToolCache();
}

function serverArg(s: McpServer) {
  return {
    transport: s.transport,
    url: s.url,
    apiKey: s.apiKey,
    command: s.command,
    args: s.args,
    env: s.env,
  };
}

export async function listMcpTools(server: McpServer): Promise<McpToolInfo[]> {
  return invoke<McpToolInfo[]>("mcp_list_tools", { server: serverArg(server) });
}

async function callMcpTool(server: McpServer, toolName: string, args: any): Promise<string> {
  return invoke<string>("mcp_call_tool", {
    server: serverArg(server),
    toolName,
    argsJson: JSON.stringify(args ?? {}),
  });
}

// Discovered tools are cached in memory per server id: re-listing means an
// extra HTTP handshake (or, for stdio, a Node cold-start) that no chat turn
// should have to pay for more than once. Settings' "list tools" button and
// any edit/save of the server list invalidate this.
const toolCache = new Map<string, McpToolInfo[]>();

export function invalidateMcpToolCache(serverId?: string) {
  if (serverId) toolCache.delete(serverId);
  else toolCache.clear();
}

const MCP_PREFIX = "mcp__";
const MAX_TOOL_NAME_LEN = 64;
const mcpNameRegistry = new Map<string, { serverId: string; toolName: string }>();

function encodeMcpPart(value: string): string {
  // Function names may only contain letters/numbers/underscore and must be
  // parsed back losslessly. Hex encoding is verbose but unambiguous and uses
  // only schema-safe characters; it also avoids the old brittle assumption
  // that server ids never contain underscores.
  return Array.from(new TextEncoder().encode(value))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeMcpPart(value: string): string | null {
  if (!value || value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return null;
  const bytes = new Uint8Array(value.match(/../g)!.map((h) => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}

function shortHash(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function safeMcpToolPart(toolName: string): string {
  return (toolName || "tool").replace(/[^A-Za-z0-9_-]/g, "_") || "tool";
}

function mcpFnName(serverId: string, toolName: string): string {
  const serverPart = encodeMcpPart(serverId);
  const suffix = `_${shortHash(`${serverId}\u0000${toolName}`)}`;
  const available = Math.max(1, MAX_TOOL_NAME_LEN - MCP_PREFIX.length - serverPart.length - 2 - suffix.length);
  const toolPart = safeMcpToolPart(toolName).slice(0, available);
  const fnName = `${MCP_PREFIX}${serverPart}__${toolPart}${suffix}`;
  mcpNameRegistry.set(fnName, { serverId, toolName });
  return fnName;
}

function parseMcpFnName(fnName: string): { serverId: string; toolName: string } | null {
  const registered = mcpNameRegistry.get(fnName);
  if (registered) return registered;
  if (!fnName.startsWith(MCP_PREFIX)) return null;
  const rest = fnName.slice(MCP_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep === -1) return null;
  const maybeEncodedId = rest.slice(0, sep);
  const toolName = rest.slice(sep + 2);
  const serverId = decodeMcpPart(maybeEncodedId) ?? maybeEncodedId;
  if (!serverId || !toolName) return null;
  return { serverId, toolName };
}

export function isMcpToolName(fnName: string): boolean {
  return fnName.startsWith(MCP_PREFIX);
}

export function mcpToolIdentity(fnName: string): { serverId: string; toolName: string } | null {
  return parseMcpFnName(fnName);
}

// Builds one function-tool entry per discovered tool across all enabled
// servers. A server whose discovery fails (bad key, npx missing, host
// unreachable) just contributes no tools to this turn instead of failing it
// — same "degrade, don't block" precedent as browser tools being entirely
// optional.
function asObjectSchema(schema: any): any {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { type: "object", properties: {} };
  const out = { ...schema };
  if (out.type && out.type !== "object") return { type: "object", properties: {} };
  out.type = "object";
  if (!out.properties || typeof out.properties !== "object" || Array.isArray(out.properties)) out.properties = {};
  return out;
}

export async function buildMcpTools(servers: McpServer[]): Promise<OpenAI.Chat.Completions.ChatCompletionTool[]> {
  const enabled = servers.filter((s) => s.enabled);
  const perServer = await Promise.all(
    enabled.map(async (s) => {
      let list = toolCache.get(s.id);
      if (!list) {
        try {
          list = await listMcpTools(s);
          toolCache.set(s.id, list);
        } catch (e) {
          console.warn(`MCP server "${s.name}" unavailable, skipping its tools this turn:`, e);
          return [];
        }
      }
      return list.map((tool) => ({
        type: "function" as const,
        function: {
          name: mcpFnName(s.id, tool.name),
          description: `[${s.name}] ${tool.description || tool.name}`,
          parameters: asObjectSchema(tool.inputSchema),
        },
      }));
    })
  );
  return perServer.flat();
}

export async function runMcpTool(servers: McpServer[], fnName: string, args: any): Promise<string> {
  const parsed = parseMcpFnName(fnName);
  if (!parsed) return "error: not an MCP tool";
  const server = servers.find((s) => s.id === parsed.serverId);
  if (!server) return `error: MCP server "${parsed.serverId}" not found (was it removed from Settings?)`;
  try {
    return await callMcpTool(server, parsed.toolName, args);
  } catch (e) {
    return `error: ${String(e)}`;
  }
}

export function newMcpServer(): McpServer {
  return {
    id: `custom-${Date.now()}`,
    name: "New MCP server",
    enabled: false,
    transport: "http",
    url: "https://",
    apiKey: "",
  };
}
