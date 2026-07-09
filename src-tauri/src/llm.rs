// Local chat models via a spawned llama-server sidecar (llama.cpp), exposing
// an OpenAI-compatible API on localhost — the existing chat/tool-calling
// infrastructure in agent.ts talks to it exactly like Sakana/Z.AI, just with
// a different baseURL. One process per model on a fixed port; lazy spawn on
// first use, automatic idle-unload after ~5 minutes, killed on app exit.
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

struct LlamaProc {
    // None for an adopted orphan (a server we didn't spawn ourselves, found
    // already answering on its port after a crash/relaunch) — we can still
    // track and idle-kill it by pid, just can't reap it via Child::wait.
    child: Option<Child>,
    pid: u32,
    port: u16,
    last_used: Instant,
    // The -c value this process was actually started with. 0 is a sentinel
    // meaning "unknown" (used for adopted orphans, whose real ctx we have no
    // way to read back) — a specific requested ctx never matches 0, so an
    // orphan is never silently trusted to already satisfy it.
    ctx: u32,
}

#[derive(Default)]
pub struct LlamaManager {
    procs: Arc<Mutex<HashMap<String, LlamaProc>>>,
    janitor_started: AtomicBool,
}

fn port_for(model_id: &str) -> Option<u16> {
    match model_id {
        "qwen3-1.7b" => Some(17871),
        "qwen3-4b" => Some(17872),
        _ => None,
    }
}

// Qwen3's dense models (1.7B/4B included) are natively trained at 32768
// tokens — going higher requires YaRN rope-scaling config that this
// quantization doesn't carry, and would silently degrade output quality
// past the trained window rather than error, so the cap is enforced here
// rather than left to the user to discover the hard way.
const MIN_CTX: u32 = 2048;
const MAX_CTX: u32 = 32768;

fn ctx_for(model_id: &str, override_ctx: Option<u32>) -> u32 {
    let default = match model_id {
        "qwen3-4b" => 12288,
        // 4096 turned out too small in practice: the system prompt alone
        // (base instructions + project tree) can run ~5k tokens on a large
        // workspace, before any real conversation — leaving zero room even
        // for the first turn. 8192 costs little extra RAM for a 1.7B model.
        _ => 8192,
    };
    override_ctx.map(|c| c.clamp(MIN_CTX, MAX_CTX)).unwrap_or(default)
}

fn kill_proc(proc: &mut LlamaProc) {
    if let Some(child) = proc.child.as_mut() {
        let _ = child.kill();
    } else {
        kill_pid(proc.pid);
    }
}

#[derive(Clone, Serialize)]
struct StatusPayload {
    status: String, // "starting" | "ready" | "error"
    message: Option<String>,
}

fn emit_status(app: &AppHandle, model_id: &str, status: &str, message: Option<String>) {
    let _ = app.emit(
        &format!("local-llm://status/{model_id}"),
        StatusPayload {
            status: status.to_string(),
            message,
        },
    );
}

/// The runtime tarball extracts to a versioned subdirectory (e.g.
/// llama-b9877/) whose name changes with every release, so we search for the
/// binary instead of hardcoding a path — same reasoning as tts.rs's
/// find_onnx for sherpa-onnx's voice packages.
fn find_llama_server(dir: &Path) -> Result<PathBuf, String> {
    fn walk(dir: &Path, depth: u32) -> Option<PathBuf> {
        if depth > 4 {
            return None;
        }
        let rd = std::fs::read_dir(dir).ok()?;
        for entry in rd.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if let Some(found) = walk(&path, depth + 1) {
                    return Some(found);
                }
            } else if path
                .file_name()
                .map(|n| n == "llama-server")
                .unwrap_or(false)
            {
                return Some(path);
            }
        }
        None
    }
    walk(dir, 0)
        .ok_or_else(|| "llama-server binary not found in the downloaded runtime".to_string())
}

fn is_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // kill(pid, 0) checks existence/permission without actually signaling.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn kill_pid(pid: u32) {
    if pid == 0 {
        return;
    }
    unsafe {
        libc::kill(pid as i32, libc::SIGTERM);
    }
}

async fn health_ok(port: u16) -> bool {
    reqwest::get(format!("http://127.0.0.1:{port}/health"))
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

async fn any_slot_busy(port: u16) -> bool {
    let Ok(resp) = reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/slots"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
    else {
        // /slots unreachable is treated as "can't confirm idle" — skip this
        // janitor cycle rather than risk killing a server mid-generation.
        return true;
    };
    let Ok(text) = resp.text().await else {
        return true;
    };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else {
        return true;
    };
    fn has_busy_slot(v: &serde_json::Value) -> bool {
        match v {
            serde_json::Value::Array(items) => items.iter().any(has_busy_slot),
            serde_json::Value::Object(map) => {
                map.get("is_processing").and_then(|x| x.as_bool()) == Some(true)
                    || map.values().any(has_busy_slot)
            }
            _ => false,
        }
    }
    has_busy_slot(&json)
}

fn start_janitor(app: AppHandle, procs: Arc<Mutex<HashMap<String, LlamaProc>>>) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().expect("janitor runtime");
        loop {
            std::thread::sleep(Duration::from_secs(60));
            let idle_ids: Vec<(String, u16)> = {
                let map = procs.lock().unwrap();
                map.iter()
                    .filter(|(_, p)| p.last_used.elapsed() > Duration::from_secs(300))
                    .map(|(id, p)| (id.clone(), p.port))
                    .collect()
            };
            for (id, port) in idle_ids {
                let busy = rt.block_on(any_slot_busy(port));
                if busy {
                    continue;
                }
                let mut map = procs.lock().unwrap();
                if let Some(mut proc) = map.remove(&id) {
                    kill_proc(&mut proc);
                    emit_status(&app, &id, "stopped", Some("idle timeout".into()));
                }
            }
        }
    });
}

#[tauri::command]
pub async fn local_llm_ensure(
    app: AppHandle,
    state: tauri::State<'_, LlamaManager>,
    model_id: String,
    ctx: Option<u32>,
) -> Result<String, String> {
    let port = port_for(&model_id).ok_or_else(|| format!("unknown local LLM model: {model_id}"))?;
    let requested_ctx = ctx_for(&model_id, ctx);

    if state
        .janitor_started
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
    {
        start_janitor(app.clone(), state.procs.clone());
    }

    // Hot path: already running and we're the ones tracking it.
    {
        let mut map = state.procs.lock().unwrap();
        if let Some(proc) = map.get_mut(&model_id) {
            let alive = match proc.child.as_mut() {
                Some(child) => matches!(child.try_wait(), Ok(None)),
                None => is_alive(proc.pid),
            };
            if alive && proc.ctx == requested_ctx {
                proc.last_used = Instant::now();
                return Ok(format!("http://127.0.0.1:{port}/v1"));
            }
            // Either dead, or alive but started with a different context
            // size than what's now requested — either way it needs to go
            // before falling through to adopt/spawn below.
            if alive {
                kill_proc(proc);
            }
            map.remove(&model_id);
        }
    }

    // Adopt an orphan: a server from a previous run (e.g. app crashed
    // without the exit hook firing) that's still answering on its port. Its
    // real ctx is unknowable from here, so it's recorded as the sentinel 0
    // — a later request with a specific ctx will never match it and will
    // correctly force a respawn instead of silently trusting a stale size.
    if health_ok(port).await {
        // Best-effort pid lookup so the janitor can still kill it later;
        // losing that ability just means this one instance outlives an
        // idle timeout until the app itself exits.
        let pid = Command::new("lsof")
            .args(["-ti", &format!("tcp:{port}")])
            .output()
            .ok()
            .and_then(|o| {
                String::from_utf8_lossy(&o.stdout)
                    .trim()
                    .lines()
                    .next()
                    .map(|s| s.to_string())
            })
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(0);
        state.procs.lock().unwrap().insert(
            model_id.clone(),
            LlamaProc {
                child: None,
                pid,
                port,
                last_used: Instant::now(),
                ctx: 0,
            },
        );
        return Ok(format!("http://127.0.0.1:{port}/v1"));
    }

    let model_path = crate::models::installed_path(&app, &model_id)?;
    let runtime_dir = crate::models::installed_path(&app, "llama-server")?;
    let binary = find_llama_server(&runtime_dir)?;

    emit_status(&app, &model_id, "starting", None);

    let logs_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|e| e.to_string())?;
    let log_path = logs_dir.join(format!("llama-{model_id}.log"));
    let log_file = std::fs::File::create(&log_path).map_err(|e| e.to_string())?;

    let child = Command::new(&binary)
        .arg("-m")
        .arg(&model_path)
        .args(["--port", &port.to_string()])
        .args(["--host", "127.0.0.1"])
        .arg("--jinja")
        .args(["-ngl", "99"])
        .args(["-np", "1"])
        .args(["-c", &requested_ctx.to_string()])
        .args(["--sleep-idle-seconds", "300"])
        .current_dir(binary.parent().unwrap_or(&runtime_dir))
        .stdout(Stdio::null())
        .stderr(Stdio::from(log_file))
        .spawn()
        .map_err(|e| format!("failed to start llama-server: {e}"))?;

    let pid = child.id();
    state.procs.lock().unwrap().insert(
        model_id.clone(),
        LlamaProc {
            child: Some(child),
            pid,
            port,
            last_used: Instant::now(),
            ctx: requested_ctx,
        },
    );

    let deadline = Instant::now() + Duration::from_secs(180);
    loop {
        if health_ok(port).await {
            emit_status(&app, &model_id, "ready", None);
            return Ok(format!("http://127.0.0.1:{port}/v1"));
        }
        // Early exit (bad model, port already taken by something else, etc.)
        let exited = {
            let mut map = state.procs.lock().unwrap();
            match map.get_mut(&model_id).and_then(|p| p.child.as_mut()) {
                Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                None => false,
            }
        };
        if exited || Instant::now() > deadline {
            state.procs.lock().unwrap().remove(&model_id);
            let tail = read_log_tail(&log_path);
            let msg = format!("local model failed to start — see log:\n{tail}");
            emit_status(&app, &model_id, "error", Some(msg.clone()));
            return Err(msg);
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

fn read_log_tail(path: &Path) -> String {
    let mut buf = String::new();
    if let Ok(mut f) = std::fs::File::open(path) {
        let _ = f.read_to_string(&mut buf);
    }
    let lines: Vec<&str> = buf.lines().rev().take(15).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("\n")
}

#[tauri::command]
pub fn local_llm_stop(state: tauri::State<LlamaManager>, model_id: String) -> Result<(), String> {
    if let Some(mut proc) = state.procs.lock().unwrap().remove(&model_id) {
        kill_proc(&mut proc);
    }
    Ok(())
}

/// Called on app exit so no llama-server process outlives MAHI itself.
pub fn kill_all(state: &LlamaManager) {
    let mut map = state.procs.lock().unwrap();
    for (_, mut proc) in map.drain() {
        kill_proc(&mut proc);
    }
}
