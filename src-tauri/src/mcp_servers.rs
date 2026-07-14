// Downloads and installs the MAHI "studio" MCP servers (Photoshop, After
// Effects, Premiere Pro, OBS) into a hidden folder under the user's
// Documents directory, so users don't need the repo's (gitignored)
// mcp-servers/ folder to use them. Mirrors models.rs's download_inner
// (stream + hash + progress events, then shell out to system `tar` rather
// than pulling in a Rust tar/flate2 dependency) and library.rs's
// document_dir()-based hidden-folder convention.
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MANIFEST_URL: &str = "https://cnatorabi.com/mahi-updates/mahi-mcp-servers.json";
const VERSION_MARKER: &str = ".mahi-mcp-version";

#[derive(Deserialize)]
struct Manifest {
    version: String,
    url: String,
    sha256: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpServersProgress {
    phase: String,
    percent: Option<u8>,
    message: String,
}

fn emit_progress(app: &AppHandle, phase: &str, percent: Option<u8>, message: &str) {
    let _ = app.emit(
        "mcp-servers://progress",
        McpServersProgress {
            phase: phase.to_string(),
            percent,
            message: message.to_string(),
        },
    );
}

fn install_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("MAHI")
        .join(".mcp-servers");
    Ok(dir)
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct McpServersStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub dir: String,
}

#[tauri::command]
pub async fn mcp_servers_status(app: AppHandle) -> Result<McpServersStatus, String> {
    let dir = install_dir(&app)?;
    let marker = dir.join(VERSION_MARKER);
    let version = fs::read_to_string(&marker)
        .ok()
        .map(|s| s.trim().to_string());
    Ok(McpServersStatus {
        installed: version.is_some(),
        version,
        dir: dir.to_string_lossy().to_string(),
    })
}

#[derive(Default)]
pub struct McpServersInstallGuard(Mutex<bool>);

#[tauri::command]
pub async fn mcp_servers_install(
    app: AppHandle,
    state: tauri::State<'_, McpServersInstallGuard>,
) -> Result<McpServersStatus, String> {
    {
        let mut busy = state.0.lock().unwrap();
        if *busy {
            return Err("an install is already in progress".into());
        }
        *busy = true;
    }
    let result = install_inner(&app).await;
    *state.0.lock().unwrap() = false;
    result
}

async fn install_inner(app: &AppHandle) -> Result<McpServersStatus, String> {
    emit_progress(app, "manifest", None, "checking for the latest version…");
    let manifest_text = reqwest::get(MANIFEST_URL)
        .await
        .map_err(|e| format!("failed to reach the update server: {e}"))?
        .text()
        .await
        .map_err(|e| format!("bad manifest response: {e}"))?;
    let manifest: Manifest =
        serde_json::from_str(&manifest_text).map_err(|e| format!("malformed manifest: {e}"))?;

    let dir = install_dir(app)?;
    if let Some(parent) = dir.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp_path = dir
        .parent()
        .unwrap_or(&dir)
        .join("mahi-mcp-servers.tar.gz.part");

    emit_progress(app, "downloading", Some(0), "در حال دانلود…");
    let resp = reqwest::get(&manifest.url)
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);

    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();
    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() > 200 {
            let percent = if total > 0 {
                Some(((downloaded as f64 / total as f64) * 100.0) as u8)
            } else {
                None
            };
            emit_progress(app, "downloading", percent, "در حال دانلود…");
            last_emit = std::time::Instant::now();
        }
    }
    drop(file);

    let got = format!("{:x}", hasher.finalize());
    if got != manifest.sha256 {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!(
            "checksum mismatch — download may be corrupt (expected {}, got {got})",
            manifest.sha256
        ));
    }

    emit_progress(app, "extracting", None, "در حال استخراج…");
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let status = Command::new("tar")
        .arg("xf")
        .arg(&tmp_path)
        .arg("-C")
        .arg(&dir)
        .status()
        .map_err(|e| format!("failed to run tar: {e}"))?;
    let _ = fs::remove_file(&tmp_path);
    if !status.success() {
        let _ = fs::remove_dir_all(&dir);
        return Err("failed to extract the downloaded archive".into());
    }

    emit_progress(app, "npm-install", None, "در حال نصب پکیج‌ها…");
    let npm_cmd = format!(
        "cd {} && npm ci --omit=dev",
        shell_quote(&dir.to_string_lossy())
    );
    let npm_status = Command::new("bash")
        .arg("-lc")
        .arg(&npm_cmd)
        .status()
        .map_err(|e| format!("failed to run npm: {e}"))?;
    if !npm_status.success() {
        return Err(
            "npm install failed — the servers were downloaded but their dependencies could not be installed. Check that Node.js/npm is installed and reachable from a terminal, then retry."
                .into(),
        );
    }

    fs::write(dir.join(VERSION_MARKER), &manifest.version).map_err(|e| e.to_string())?;
    emit_progress(app, "done", Some(100), "نصب کامل شد");

    Ok(McpServersStatus {
        installed: true,
        version: Some(manifest.version),
        dir: dir.to_string_lossy().to_string(),
    })
}
