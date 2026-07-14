// MCP (Model Context Protocol) client: lets externally configured MCP
// servers' tools be discovered and invoked from the agent loop, alongside
// MAHI's own built-in tools (see mcp.ts on the frontend for where these
// tools get merged into the model's tool list and dispatched back here).
//
// Two transports are supported — the two that actually show up among real
// MCP servers (e.g. Z.AI's devpack): "http" (Streamable HTTP: a POST per
// JSON-RPC message, response is either a plain JSON body or a short SSE
// stream — both are handled) and "stdio" (a spawned child process speaking
// newline-delimited JSON-RPC on stdin/stdout).
//
// Every call here does a fresh initialize -> notifications/initialized ->
// (tools/list | tools/call) handshake rather than keeping a persistent
// session across calls. That's simpler and more robust than managing
// long-lived process/session state through app reloads and restarts, at the
// cost of a bit of latency per call (a couple of extra request round-trips,
// plus a process cold-start for stdio servers e.g. `npx`).
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServerArg {
    pub transport: String, // "http" | "stdio"
    pub url: Option<String>,
    pub api_key: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<HashMap<String, String>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

const PROTOCOL_VERSION: &str = "2024-11-05";
const CALL_TIMEOUT: Duration = Duration::from_secs(45);

fn client_info() -> Value {
    json!({ "name": "MAHI", "version": "1.0.0" })
}

fn init_request() -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": client_info(),
        }
    })
}

fn initialized_notification() -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })
}

fn extract_result(resp: Value) -> Result<Value, String> {
    if let Some(err) = resp.get("error") {
        return Err(format!("MCP error: {err}"));
    }
    resp.get("result")
        .cloned()
        .ok_or_else(|| "malformed MCP response (no result)".to_string())
}

fn parse_tools(result: Value) -> Result<Vec<McpToolInfo>, String> {
    let arr = result
        .get("tools")
        .and_then(|t| t.as_array())
        .ok_or("malformed tools/list response")?;
    Ok(arr
        .iter()
        .map(|t| McpToolInfo {
            name: t.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            description: t
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            input_schema: t
                .get("inputSchema")
                .cloned()
                .unwrap_or_else(|| json!({ "type": "object", "properties": {} })),
        })
        .collect())
}

fn parse_call_result(result: Value) -> Result<String, String> {
    let content = result.get("content").and_then(|c| c.as_array());
    let text = content
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| result.to_string());
    if result.get("isError").and_then(|v| v.as_bool()).unwrap_or(false) {
        Ok(format!("error: {text}"))
    } else {
        Ok(text)
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// ---------- stdio transport ----------

// Spawned via `bash -lc` (not Command::new(program) directly) for the same
// reason asr.rs's ffmpeg lookup and lib.rs's run_command do: a macOS
// GUI-launched app doesn't inherit the user's shell PATH (~/.zshrc,
// ~/.zprofile never get sourced), so a bare `npx` would fail to resolve even
// though it works fine from a terminal. A login shell sources those files
// first, picking up nvm/homebrew/volta's PATH exports.
async fn stdio_exchange(server: &McpServerArg, steps: Vec<(Value, Option<i64>)>) -> Result<Vec<Value>, String> {
    let command = server.command.as_deref().ok_or("missing command")?;
    let args = server.args.clone().unwrap_or_default();
    let full_cmd = std::iter::once(shell_quote(command))
        .chain(args.iter().map(|a| shell_quote(a)))
        .collect::<Vec<_>>()
        .join(" ");

    let mut cmd = Command::new("bash");
    cmd.arg("-lc").arg(&full_cmd);
    if let Some(env) = &server.env {
        cmd.envs(env);
    }
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    cmd.kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start MCP server: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let mut lines = BufReader::new(stdout).lines();

    let mut responses = Vec::new();
    for (msg, want_id) in steps {
        let line = format!("{}\n", serde_json::to_string(&msg).map_err(|e| e.to_string())?);
        if stdin.write_all(line.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            let _ = child.start_kill();
            return Err("MCP server closed its input".into());
        }
        if let Some(id) = want_id {
            loop {
                let Some(raw) = lines.next_line().await.map_err(|e| e.to_string())? else {
                    let _ = child.start_kill();
                    return Err("MCP server closed its output before responding".into());
                };
                let raw = raw.trim();
                if raw.is_empty() {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(raw) else {
                    continue; // some servers print non-JSON startup logs to stdout
                };
                if v.get("id").and_then(|i| i.as_i64()) == Some(id) {
                    responses.push(v);
                    break;
                }
            }
        }
    }
    let _ = child.start_kill();
    Ok(responses)
}

async fn stdio_list_tools(server: &McpServerArg) -> Result<Vec<McpToolInfo>, String> {
    let steps = vec![
        (init_request(), Some(1)),
        (initialized_notification(), None),
        (json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }), Some(2)),
    ];
    let responses = timeout(CALL_TIMEOUT, stdio_exchange(server, steps))
        .await
        .map_err(|_| "MCP server timed out".to_string())??;
    let resp = responses.into_iter().last().ok_or("no response from MCP server")?;
    parse_tools(extract_result(resp)?)
}

async fn stdio_call_tool(server: &McpServerArg, tool_name: &str, args: Value) -> Result<String, String> {
    let steps = vec![
        (init_request(), Some(1)),
        (initialized_notification(), None),
        (
            json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": tool_name, "arguments": args } }),
            Some(2),
        ),
    ];
    let responses = timeout(CALL_TIMEOUT, stdio_exchange(server, steps))
        .await
        .map_err(|_| "MCP server timed out".to_string())??;
    let resp = responses.into_iter().last().ok_or("no response from MCP server")?;
    parse_call_result(extract_result(resp)?)
}

// ---------- http (Streamable HTTP) transport ----------

async fn http_post(
    client: &reqwest::Client,
    server: &McpServerArg,
    session: &Option<String>,
    body: &Value,
) -> Result<(Value, Option<String>), String> {
    let url = server.url.as_deref().ok_or("missing url")?;
    let mut req = client
        .post(url)
        .header("Content-Type", "application/json")
        .header("Accept", "application/json, text/event-stream");
    if let Some(key) = server.api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.header("Authorization", format!("Bearer {key}"));
    }
    if let Some(sid) = session {
        req = req.header("Mcp-Session-Id", sid);
    }
    let body_str = serde_json::to_string(body).map_err(|e| e.to_string())?;
    let resp = req.body(body_str).send().await.map_err(|e| e.to_string())?;
    let new_session = resp
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .or_else(|| session.clone());
    let status = resp.status();
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", text.chars().take(300).collect::<String>()));
    }
    // A bare notification (e.g. notifications/initialized) gets an empty
    // 202 body — nothing to parse, and no caller needs a value back for it.
    if text.trim().is_empty() {
        return Ok((Value::Null, new_session));
    }
    if content_type.contains("text/event-stream") {
        let mut last: Option<Value> = None;
        for line in text.lines() {
            if let Some(data) = line.strip_prefix("data:") {
                if let Ok(v) = serde_json::from_str::<Value>(data.trim()) {
                    last = Some(v);
                }
            }
        }
        Ok((last.ok_or("no data in SSE response")?, new_session))
    } else {
        Ok((
            serde_json::from_str(&text).map_err(|e| format!("invalid JSON response: {e}"))?,
            new_session,
        ))
    }
}

async fn http_handshake(client: &reqwest::Client, server: &McpServerArg) -> Result<Option<String>, String> {
    let (_r, session) = timeout(CALL_TIMEOUT, http_post(client, server, &None, &init_request()))
        .await
        .map_err(|_| "MCP server timed out".to_string())??;
    let (_r, session) = timeout(
        CALL_TIMEOUT,
        http_post(client, server, &session, &initialized_notification()),
    )
    .await
    .map_err(|_| "MCP server timed out".to_string())??;
    Ok(session)
}

async fn http_list_tools(server: &McpServerArg) -> Result<Vec<McpToolInfo>, String> {
    let client = reqwest::Client::new();
    let session = http_handshake(&client, server).await?;
    let list = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} });
    let (resp, _s) = timeout(CALL_TIMEOUT, http_post(&client, server, &session, &list))
        .await
        .map_err(|_| "MCP server timed out".to_string())??;
    parse_tools(extract_result(resp)?)
}

async fn http_call_tool(server: &McpServerArg, tool_name: &str, args: Value) -> Result<String, String> {
    let client = reqwest::Client::new();
    let session = http_handshake(&client, server).await?;
    let call = json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": { "name": tool_name, "arguments": args } });
    let (resp, _s) = timeout(CALL_TIMEOUT, http_post(&client, server, &session, &call))
        .await
        .map_err(|_| "MCP server timed out".to_string())??;
    parse_call_result(extract_result(resp)?)
}

// ---------- Tauri commands ----------

#[tauri::command]
pub async fn mcp_list_tools(server: McpServerArg) -> Result<Vec<McpToolInfo>, String> {
    match server.transport.as_str() {
        "http" => http_list_tools(&server).await,
        "stdio" => stdio_list_tools(&server).await,
        other => Err(format!("unknown MCP transport: {other}")),
    }
}

#[tauri::command]
pub async fn mcp_call_tool(server: McpServerArg, tool_name: String, args_json: String) -> Result<String, String> {
    let args: Value = if args_json.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&args_json).map_err(|e| format!("invalid tool arguments: {e}"))?
    };
    match server.transport.as_str() {
        "http" => http_call_tool(&server, &tool_name, args).await,
        "stdio" => stdio_call_tool(&server, &tool_name, args).await,
        other => Err(format!("unknown MCP transport: {other}")),
    }
}
