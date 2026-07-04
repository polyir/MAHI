mod browser;
mod checkpoint;
mod media;
mod pty;

use regex::Regex;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const IGNORED_DIRS: [&str; 5] = [".git", "node_modules", "target", "dist", ".next"];

fn is_ignored(name: &str) -> bool {
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
    let candidate = base.join(rel);
    let candidate = if candidate.exists() {
        candidate.canonicalize().map_err(|e| e.to_string())?
    } else {
        candidate
    };
    if !candidate.starts_with(&base) {
        return Err("path escapes workspace".into());
    }
    Ok(candidate)
}

#[tauri::command]
fn read_file(workspace: String, path: String) -> Result<String, String> {
    let p = resolve(&workspace, &path)?;
    fs::read_to_string(p).map_err(|e| e.to_string())
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
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(p, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn edit_file(
    workspace: String,
    path: String,
    old_string: String,
    new_string: String,
    replace_all: bool,
) -> Result<(), String> {
    let p = resolve(&workspace, &path)?;
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
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::rename(src, dst).map_err(|e| e.to_string())
}

#[derive(Serialize)]
struct CmdOutput {
    stdout: String,
    stderr: String,
    code: i32,
}

#[tauri::command]
fn run_command(workspace: String, cmd: String) -> Result<CmdOutput, String> {
    let base = Path::new(&workspace)
        .canonicalize()
        .map_err(|e| format!("invalid workspace: {e}"))?;
    let output = Command::new("bash")
        .arg("-lc")
        .arg(&cmd)
        .current_dir(&base)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(CmdOutput {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        code: output.status.code().unwrap_or(-1),
    })
}

#[tauri::command]
fn search_files(
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
        let content = match fs::read_to_string(&f) {
            Ok(c) => c,
            Err(_) => continue, // skip binary/unreadable files
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
fn glob_files(
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
fn project_tree(workspace: String, max_entries: Option<usize>) -> Result<String, String> {
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
}

/// Open a provider's own console page (billing/usage) in an in-app window.
/// The webview keeps its login session between opens, so the user signs in
/// once and can check real usage anytime. Host-allowlisted so arbitrary URLs
/// can't be opened through this command.
#[tauri::command]
async fn open_console_window(app: tauri::AppHandle, url: String, title: String) -> Result<(), String> {
    use tauri::Manager;
    let parsed: tauri::Url = url.parse().map_err(|e| format!("invalid url: {e}"))?;
    let host = parsed.host_str().unwrap_or_default();
    const ALLOWED: [&str; 4] = ["console.sakana.ai", "sakana.ai", "z.ai", "console.z.ai"];
    if parsed.scheme() != "https" || !ALLOWED.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))) {
        return Err(format!("host not allowed: {host}"));
    }
    if let Some(w) = app.get_webview_window("provider-console") {
        let _ = w.eval(&format!("window.location.replace({})", serde_json::to_string(&url).unwrap()));
        let _ = w.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(&app, "provider-console", tauri::WebviewUrl::External(parsed))
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
        .manage(pty::PtyManager::default())
        .manage(checkpoint::CheckpointManager::default())
        .invoke_handler(tauri::generate_handler![
            read_file,
            register_asset_scope,
            browser::browser_open,
            browser::browser_reposition,
            browser::browser_navigate,
            browser::browser_hide,
            browser::browser_close,
            write_file,
            media::write_file_binary,
            edit_file,
            delete_file,
            move_file,
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
            open_console_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
