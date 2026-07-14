mod asr;
mod browser;
mod checkpoint;
mod library;
mod llm;
mod mcp;
mod microphone;
mod mcp_servers;
mod media;
mod models;
mod pty;
mod screenshot;
mod sessions;
mod tts;
mod watcher;
mod window_vision;

use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tokio::process::Command;

const IGNORED_DIRS: [&str; 5] = [".git", "node_modules", "target", "dist", ".next"];

/// Files larger than this are skipped by content search: they are almost
/// never what the user is grepping for (bundles, lockfile blobs, media) and
/// reading them stalls the search on slow disks / cloud-synced placeholders.
const MAX_SEARCH_FILE_LEN: u64 = 1_500_000;

/// Read a file as text for searching, or None when it should be skipped:
/// too large, unreadable, binary (NUL bytes in the head), or not UTF-8.
/// The metadata check comes first so oversized files are never opened at all.
fn read_search_text(path: &Path) -> Option<String> {
    let meta = fs::metadata(path).ok()?;
    if meta.len() > MAX_SEARCH_FILE_LEN {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.iter().take(8192).any(|&b| b == 0) {
        return None;
    }
    String::from_utf8(bytes).ok()
}

pub(crate) fn is_ignored(name: &str) -> bool {
    name.starts_with('.') && name != "." || IGNORED_DIRS.contains(&name)
}

/// Recursively collect files under `dir`, skipping ignored/hidden directories,
/// stopping once `cap` files have been gathered.
fn walk_collect(dir: &Path, out: &mut Vec<PathBuf>, cap: usize) {
    if out.len() >= cap {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        if out.len() >= cap {
            return;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if is_ignored(&name) {
            continue;
        }
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => walk_collect(&path, out, cap),
            Ok(ft) if ft.is_file() => out.push(path),
            _ => {}
        }
    }
}

fn glob_to_regex(pattern: &str) -> String {
    let mut re = String::from("(?i)^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    if chars.peek() == Some(&'/') {
                        chars.next();
                    }
                    re.push_str(".*");
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            '.' | '+' | '(' | ')' | '|' | '[' | ']' | '{' | '}' | '^' | '$' | '\\' => {
                re.push('\\');
                re.push(c);
            }
            _ => re.push(c),
        }
    }
    re.push('$');
    re
}

pub(crate) fn resolve(workspace: &str, rel: &str) -> Result<PathBuf, String> {
    let base = Path::new(workspace)
        .canonicalize()
        .map_err(|e| format!("invalid workspace: {e}"))?;
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() {
        return Err("path escapes workspace".into());
    }
    let mut clean_rel = PathBuf::new();
    for component in rel_path.components() {
        match component {
            Component::Normal(part) => clean_rel.push(part),
            Component::CurDir => {}
            Component::ParentDir => {
                if !clean_rel.pop() {
                    return Err("path escapes workspace".into());
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err("path escapes workspace".into())
            }
        }
    }
    let candidate = base.join(clean_rel);
    let candidate = if candidate.exists() {
        candidate.canonicalize().map_err(|e| e.to_string())?
    } else {
        let mut ancestor = candidate.parent().unwrap_or(&base);
        while !ancestor.exists() {
            ancestor = ancestor.parent().unwrap_or(&base);
        }
        let ancestor = ancestor.canonicalize().map_err(|e| e.to_string())?;
        if !ancestor.starts_with(&base) {
            return Err("path escapes workspace".into());
        }
        candidate
    };
    if !candidate.starts_with(&base) {
        return Err("path escapes workspace".into());
    }
    Ok(candidate)
}

pub(crate) fn ensure_not_workspace_root(workspace: &str, path: &Path) -> Result<(), String> {
    let base = Path::new(workspace)
        .canonicalize()
        .map_err(|e| format!("invalid workspace: {e}"))?;
    let candidate = if path.exists() {
        path.canonicalize().map_err(|e| e.to_string())?
    } else {
        path.to_path_buf()
    };
    if candidate == base {
        return Err("refusing to mutate workspace root".into());
    }
    Ok(())
}

// async + spawn_blocking: sync commands are serviced on the main thread by
// the webview's custom-protocol handler, so a read that stalls (huge file,
// slow disk, an iCloud/File Provider placeholder that must download first)
// froze the entire UI. The blocking pool absorbs the wait instead.
#[tauri::command]
async fn read_file(workspace: String, path: String) -> Result<String, String> {
    let p = resolve(&workspace, &path)?;
    tauri::async_runtime::spawn_blocking(move || fs::read_to_string(p).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

/// Grant the asset:// protocol read access to a workspace directory, so the
/// frontend can preview binary files (images/audio/video/PDF) via
/// `convertFileSrc` — which streams straight from disk instead of round-
/// tripping the whole file through the IPC channel as base64 (which chokes
/// on anything more than a few MB).
#[tauri::command]
fn register_asset_scope(app: tauri::AppHandle, workspace: String) -> Result<(), String> {
    use tauri::Manager;
    app.asset_protocol_scope()
        .allow_directory(&workspace, true)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(workspace: String, path: String, content: String) -> Result<(), String> {
    let p = resolve(&workspace, &path)?;
    ensure_not_workspace_root(&workspace, &p)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn edit_file(
    workspace: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
) -> Result<(), String> {
    let p = resolve(&workspace, &path)?;
    tauri::async_runtime::spawn_blocking(move || edit_file_blocking(p, old_string, new_string, replace_all))
        .await
        .map_err(|e| e.to_string())?
}

fn edit_file_blocking(
    p: PathBuf,
    old_string: String,
    new_string: String,
    replace_all: bool,
) -> Result<(), String> {
    let content = fs::read_to_string(&p).map_err(|e| e.to_string())?;
    let count = content.matches(old_string.as_str()).count();
    if count == 0 {
        return Err("old_string not found in file".into());
    }
    if count > 1 && !replace_all {
        return Err(format!(
            "old_string is not unique ({count} matches); pass replace_all or include more context"
        ));
    }
    let updated = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };
    fs::write(p, updated).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct Entry {
    name: String,
    is_dir: bool,
}

#[tauri::command]
fn list_dir(workspace: String, path: String) -> Result<Vec<Entry>, String> {
    let p = resolve(&workspace, &path)?;
    let mut out = Vec::new();
    for entry in fs::read_dir(p).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        let is_dir = entry.file_type().map_err(|e| e.to_string())?.is_dir();
        out.push(Entry { name, is_dir });
    }
    Ok(out)
}

#[tauri::command]
fn delete_file(workspace: String, path: String) -> Result<(), String> {
    let p = resolve(&workspace, &path)?;
    ensure_not_workspace_root(&workspace, &p)?;
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn move_file(workspace: String, from: String, to: String) -> Result<(), String> {
    let src = resolve(&workspace, &from)?;
    let dst = resolve(&workspace, &to)?;
    ensure_not_workspace_root(&workspace, &src)?;
    ensure_not_workspace_root(&workspace, &dst)?;
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let dst_path = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_all(&entry.path(), &dst_path)?;
        } else {
            fs::copy(entry.path(), &dst_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn copy_file(workspace: String, from: String, to: String) -> Result<(), String> {
    let src = resolve(&workspace, &from)?;
    let dst = resolve(&workspace, &to)?;
    ensure_not_workspace_root(&workspace, &dst)?;
    if src.is_dir() && dst.starts_with(&src) {
        return Err("cannot copy a folder into itself".into());
    }
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if src.is_dir() {
        copy_dir_all(&src, &dst).map_err(|e| e.to_string())
    } else {
        fs::copy(&src, &dst).map(|_| ()).map_err(|e| e.to_string())
    }
}

#[derive(Serialize)]
struct CmdOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

// async: this used to run std::process::Command::output() synchronously,
// which blocks the same runtime that services the native window's event
// loop — a long shell command (a deploy, a build) froze the whole macOS UI
// (spinning beachball) for its entire duration. tokio::process::Command's
// awaited output() keeps that thread free to service the UI meanwhile.
#[tauri::command]
async fn run_command(workspace: String, cmd: String) -> Result<CmdOutput, String> {
    let base = Path::new(&workspace)
        .canonicalize()
        .map_err(|e| format!("invalid workspace: {e}"))?;
    let output = Command::new("bash")
        .arg("-lc")
        .arg(&cmd)
        .current_dir(&base)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}

// async + spawn_blocking: this walked and read every workspace file on the
// main thread — one stalled read() (huge file, slow volume, cloud-synced
// placeholder) beachballed the whole app for the duration of the search.
#[tauri::command]
async fn search_files(
    workspace: String,
    query: String,
    is_regex: Option<bool>,
    max_results: Option<usize>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_files_blocking(workspace, query, is_regex, max_results)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn search_files_blocking(
    workspace: String,
    query: String,
    is_regex: Option<bool>,
    max_results: Option<usize>,
) -> Result<String, String> {
    let base = Path::new(&workspace)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let max = max_results.unwrap_or(100);
    let re = if is_regex.unwrap_or(false) {
        Some(Regex::new(&query).map_err(|e| format!("invalid regex: {e}"))?)
    } else {
        None
    };

    let mut files = Vec::new();
    walk_collect(&base, &mut files, 8000);

    let mut results: Vec<String> = Vec::new();
    'outer: for f in files {
        let content = match read_search_text(&f) {
            Some(c) => c,
            None => continue, // skip oversized/binary/unreadable files
        };
        let rel = f
            .strip_prefix(&base)
            .unwrap_or(&f)
            .to_string_lossy()
            .to_string();
        for (i, line) in content.lines().enumerate() {
            let hit = match &re {
                Some(r) => r.is_match(line),
                None => line.contains(&query),
            };
            if hit {
                let trimmed: String = line.trim().chars().take(200).collect();
                results.push(format!("{}:{}: {}", rel, i + 1, trimmed));
                if results.len() >= max {
                    break 'outer;
                }
            }
        }
    }

    if results.is_empty() {
        Ok("No matches found.".into())
    } else {
        Ok(results.join("\n"))
    }
}

#[tauri::command]
async fn glob_files(
    workspace: String,
    pattern: String,
    max_results: Option<usize>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || glob_files_blocking(workspace, pattern, max_results))
        .await
        .map_err(|e| e.to_string())?
}

fn glob_files_blocking(
    workspace: String,
    pattern: String,
    max_results: Option<usize>,
) -> Result<String, String> {
    let base = Path::new(&workspace)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let max = max_results.unwrap_or(300);
    let re = Regex::new(&glob_to_regex(&pattern)).map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    walk_collect(&base, &mut files, 8000);

    let mut matched: Vec<String> = files
        .iter()
        .filter_map(|f| {
            let rel = f
                .strip_prefix(&base)
                .unwrap_or(f)
                .to_string_lossy()
                .to_string();
            if re.is_match(&rel) {
                Some(rel)
            } else {
                None
            }
        })
        .take(max)
        .collect();
    matched.sort();

    if matched.is_empty() {
        Ok("No files matched.".into())
    } else {
        Ok(matched.join("\n"))
    }
}

/// A flat, sorted list of the project's files (relative paths), capped so it
/// can be injected into the model's context as lightweight project awareness.
#[tauri::command]
async fn project_tree(workspace: String, max_entries: Option<usize>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let base = Path::new(&workspace)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let cap = max_entries.unwrap_or(250);
        let mut files = Vec::new();
        walk_collect(&base, &mut files, cap);
        let mut rels: Vec<String> = files
            .iter()
            .map(|f| {
                f.strip_prefix(&base)
                    .unwrap_or(f)
                    .to_string_lossy()
                    .to_string()
            })
            .collect();
        rels.sort();
        Ok(rels.join("\n"))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a provider's own console page (billing/usage) in an in-app window.
/// The webview keeps its login session between opens, so the user signs in
/// once and can check real usage anytime. Host-allowlisted so arbitrary URLs
/// can't be opened through this command.
#[tauri::command]
async fn open_console_window(
    app: tauri::AppHandle,
    url: String,
    title: String,
) -> Result<(), String> {
    use tauri::Manager;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let host = parsed.host_str().unwrap_or_default();
    const ALLOWED: [&str; 5] = ["console.sakana.ai", "sakana.ai", "z.ai", "console.z.ai", "github.com"];
    if parsed.scheme() != "https"
        || !ALLOWED
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")))
    {
        return Err(format!("host not allowed: {host}"));
    }
    if let Some(w) = app.get_webview_window("provider-console") {
        let _ = w.eval(format!(
            "window.location.replace({})",
            serde_json::to_string(&url).unwrap()
        ));
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "provider-console",
        tauri::WebviewUrl::External(parsed),
    )
    .title(&title)
    .inner_size(1050.0, 780.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty::PtyManager::default())
        .manage(checkpoint::CheckpointManager::default())
        .manage(models::ModelManager::default())
        .manage(mcp_servers::McpServersInstallGuard::default())
        .manage(asr::AsrManager::default())
        .manage(tts::TtsManager::default())
        .manage(watcher::WatcherManager::default())
        .manage(llm::LlamaManager::default())
        .manage(browser::PickerManager::default())
        .manage(window_vision::WindowVisionManager::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            register_asset_scope,
            screenshot::window_screenshot,
            write_file,
            media::write_file_binary,
            media::save_temp_image,
            media::delete_temp_image,
            edit_file,
            delete_file,
            move_file,
            copy_file,
            list_dir,
            run_command,
            search_files,
            glob_files,
            project_tree,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            checkpoint::checkpoint_begin,
            checkpoint::checkpoint_record,
            checkpoint::checkpoint_revert,
            models::model_download,
            models::model_list_status,
            models::model_delete,
            mcp_servers::mcp_servers_status,
            mcp_servers::mcp_servers_install,
            asr::transcribe_media,
            microphone::microphone_start,
            microphone::microphone_level,
            microphone::microphone_stop,
            microphone::microphone_read,
            tts::synthesize_speech,
            watcher::watch_workspace,
            llm::local_llm_ensure,
            llm::local_llm_stop,
            library::library_list,
            library::library_load_images,
            library::library_copy_asset,
            library::library_import_directory,
            library::library_clone,
            library::library_remove,
            library::library_update,
            library::library_save_project_map,
            library::git_lfs_status,
            library::git_lfs_install,
            sessions::sessions_load,
            sessions::sessions_save,
            browser::browser_open,
            browser::browser_reposition,
            browser::browser_navigate,
            browser::browser_hide,
            browser::browser_close,
            browser::browser_dom_snapshot,
            browser::browser_click,
            browser::browser_type,
            browser::browser_submit,
            browser::browser_scroll,
            browser::browser_key,
            browser::browser_start_picker,
            browser::browser_stop_picker,
            browser::browser_capture_element_screenshot,
            window_vision::window_vision_capabilities,
            window_vision::window_vision_request_permission,
            window_vision::window_vision_allowed_apps,
            window_vision::window_vision_present_picker,
            window_vision::window_vision_picker_result,
            window_vision::window_vision_remove_allowed_app,
            window_vision::window_vision_list_allowed_windows,
            window_vision::window_vision_observe_app,
            window_vision::window_vision_start_group,
            window_vision::window_vision_sessions,
            window_vision::window_vision_capture,
            window_vision::window_vision_wait_for_change,
            window_vision::window_vision_stop,
            window_vision::window_vision_stop_all,
            window_vision::window_vision_detect_dialogs,
            window_vision::window_vision_auto_prepare,
            mcp::mcp_list_tools,
            mcp::mcp_call_tool,
            open_console_window
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Without this, a llama-server sidecar spawned by local_llm_ensure
            // would keep running after MAHI itself quits — it has no parent
            // check of its own, so it'd sit there holding RAM/the port
            // forever until manually killed.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                llm::kill_all(app.state::<llm::LlamaManager>().inner());
                window_vision::stop_all();
            }
        });
}
