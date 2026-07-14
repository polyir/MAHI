use base64::Engine;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::{Cursor, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

const SOURCE_META_FILE: &str = ".mahi-source.json";
const GIT_LFS_VERSION: &str = "3.7.1";

#[cfg(target_arch = "aarch64")]
const GIT_LFS_ARCH: &str = "arm64";
#[cfg(target_arch = "aarch64")]
const GIT_LFS_SHA256: &str = "76260fb34f4ee622ff0a66b857e5954aa49c7e343a92e57a1ec4a760618c94b2";
#[cfg(target_arch = "x86_64")]
const GIT_LFS_ARCH: &str = "amd64";
#[cfg(target_arch = "x86_64")]
const GIT_LFS_SHA256: &str = "b5b1b641c0648c83661fa9eda991cd3eff945264dabc2cdf411a80dfe7ec0970";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    id: String,
    name: String,
    description: String,
    path: String,
    bundle_root: String,
    source_root: String,
    content: String,
    files: Vec<LibraryFile>,
    image_paths: Vec<String>,
    git: bool,
    source_kind: String,
    source_url: String,
    source_directory: String,
    revision: String,
    update_available: bool,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SkillSource {
    id: String,
    kind: String,
    url: String,
    directory: String,
    revision: String,
    source_hash: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryProgress {
    operation_id: String,
    phase: String,
    percent: Option<u8>,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitLfsStatus {
    installed: bool,
    version: String,
    managed: bool,
}

fn emit_progress(
    app: &AppHandle,
    operation_id: &str,
    phase: &str,
    percent: Option<u8>,
    message: &str,
) {
    let _ = app.emit(
        "skill://progress",
        LibraryProgress {
            operation_id: operation_id.to_string(),
            phase: phase.to_string(),
            percent,
            message: message.chars().take(500).collect(),
        },
    );
}

fn skill_id(seed: &str) -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hasher.update(stamp.to_le_bytes());
    format!("{:x}", hasher.finalize())[..20].to_string()
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryFile {
    name: String,
    path: String,
    size: u64,
    file_type: String,
}

fn kind_dir(app: &AppHandle, kind: &str) -> Result<PathBuf, String> {
    if kind != "skills" {
        return Err("invalid library kind".into());
    }
    let dir = app
        .path()
        .document_dir()
        .map_err(|e| e.to_string())?
        .join("MAHI Skills");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let legacy = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("library")
        .join("skills");
    if legacy.is_dir() {
        for entry in fs::read_dir(&legacy).map_err(|e| e.to_string())?.flatten() {
            if !entry.path().is_dir() {
                continue;
            }
            let mut source = read_source(&entry.path());
            if source.id.is_empty() {
                let manifest = primary_file(&entry.path());
                let mut hasher = Sha256::new();
                hasher.update(manifest.to_string_lossy().as_bytes());
                source.id = format!("{:x}", hasher.finalize())[..20].to_string();
                let _ = write_source(&entry.path(), &source);
            }
            let desired = dir.join(entry.file_name());
            let target = if desired.exists() {
                unique_dest(&dir, &entry.file_name().to_string_lossy())
            } else {
                desired
            };
            if fs::rename(entry.path(), &target).is_err() {
                copy_tree(&entry.path(), &target, true)?;
                fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
            }
        }
        if fs::read_dir(&legacy)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
        {
            let _ = fs::remove_dir_all(&legacy);
        }
    }
    Ok(dir)
}

fn slug(value: &str) -> String {
    let clean: String = value
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    clean
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
        .chars()
        .take(48)
        .collect()
}

fn unique_dest(base: &Path, hint: &str) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    base.join(format!("{}-{stamp}", slug(hint).trim_matches('-')))
}

fn copy_tree(source: &Path, dest: &Path, include_git: bool) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !include_git && entry.file_name() == ".git" {
            continue;
        }
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_symlink() {
            continue;
        }
        let target = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_tree(&entry.path(), &target, include_git)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn write_source(root: &Path, source: &SkillSource) -> Result<(), String> {
    fs::write(
        root.join(SOURCE_META_FILE),
        serde_json::to_vec_pretty(source).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn read_source(root: &Path) -> SkillSource {
    fs::read(root.join(SOURCE_META_FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn source_signature(root: &Path) -> String {
    let mut paths = Vec::new();
    bundle_files(root, root, &mut paths, 0);
    paths.sort();
    let mut hasher = Sha256::new();
    for path in paths {
        if path.file_name().and_then(|x| x.to_str()) == Some(SOURCE_META_FILE) {
            continue;
        }
        let relative = path.strip_prefix(root).unwrap_or(&path).to_string_lossy();
        let Ok(meta) = fs::metadata(&path) else {
            continue;
        };
        hasher.update(relative.as_bytes());
        hasher.update(meta.len().to_le_bytes());
        if let Ok(modified) = meta.modified().and_then(|time| {
            time.duration_since(UNIX_EPOCH)
                .map_err(std::io::Error::other)
        }) {
            hasher.update(modified.as_nanos().to_le_bytes());
        }
    }
    format!("{:x}", hasher.finalize())
}

fn metadata(content: &str, fallback: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    for line in content.lines().take(40) {
        let trimmed = line.trim();
        if name.is_empty() {
            if let Some(value) = trimmed.strip_prefix("name:") {
                name = value.trim().trim_matches(['\'', '"']).to_string();
            } else if let Some(value) = trimmed.strip_prefix("# ") {
                name = value.trim().to_string();
            }
        }
        if description.is_empty() {
            if let Some(value) = trimmed.strip_prefix("description:") {
                description = value.trim().trim_matches(['\'', '"']).to_string();
            }
        }
    }
    if name.is_empty() {
        name = fallback.to_string();
    }
    if description.is_empty() {
        description = content
            .lines()
            .map(str::trim)
            .find(|line| !line.is_empty() && !line.starts_with('#') && *line != "---")
            .unwrap_or("")
            .chars()
            .take(240)
            .collect();
    }
    (name, description)
}

fn bundle_files(root: &Path, dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    if depth > 32 || out.len() >= 10_000 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" || name == SOURCE_META_FILE {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            bundle_files(root, &path, out, depth + 1);
        } else if path.is_file() && path.starts_with(root) {
            out.push(path);
        }
    }
}

fn is_image_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|x| x.to_str())
            .map(|x| x.to_ascii_lowercase())
            .as_deref(),
        Some("png" | "jpg" | "jpeg" | "webp")
    )
}

fn primary_file(root: &Path) -> PathBuf {
    let manifest = root.join("SKILL.md");
    if manifest.is_file() {
        manifest
    } else {
        root.to_path_buf()
    }
}

fn folder_display_name(root: &Path) -> &str {
    let raw = root
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("Untitled");
    if let Some((name, suffix)) = raw.rsplit_once('-') {
        if suffix.len() >= 10 && suffix.chars().all(|c| c.is_ascii_digit()) {
            return name;
        }
    }
    raw
}

fn build_bundle(root: &Path) -> (String, Vec<LibraryFile>, Vec<String>) {
    let mut paths = Vec::new();
    bundle_files(root, root, &mut paths, 0);
    paths.sort();
    let mut files = Vec::new();
    let mut images = Vec::new();
    let mut text = String::new();
    let mut remaining = 100_000usize;
    text.push_str(&format!("Bundle root: {}\nFiles:\n", root.display()));
    for path in &paths {
        let relative = path
            .strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .to_string();
        let size = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
        let file_type = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("file")
            .to_ascii_lowercase();
        text.push_str(&format!("- {relative} ({size} bytes)\n"));
        if is_image_file(path) {
            images.push(path.to_string_lossy().to_string());
        }
        files.push(LibraryFile {
            name: relative,
            path: path.to_string_lossy().to_string(),
            size,
            file_type,
        });
    }
    for path in &paths {
        if remaining == 0
            || fs::metadata(path)
                .map(|m| m.len() > 2_000_000)
                .unwrap_or(true)
        {
            continue;
        }
        let Ok(bytes) = fs::read(path) else {
            continue;
        };
        let Ok(content) = String::from_utf8(bytes) else {
            continue;
        };
        let relative = path.strip_prefix(root).unwrap_or(path).to_string_lossy();
        let take = content.len().min(30_000).min(remaining);
        let mut safe_take = take;
        while safe_take > 0 && !content.is_char_boundary(safe_take) {
            safe_take -= 1;
        }
        text.push_str(&format!(
            "\n--- FILE: {relative} ---\n{}\n",
            &content[..safe_take]
        ));
        remaining = remaining.saturating_sub(safe_take);
    }
    (text, files, images)
}

#[tauri::command]
pub fn library_list(app: AppHandle, kind: String) -> Result<Vec<LibraryItem>, String> {
    let base = kind_dir(&app, &kind)?;
    let mut items = Vec::new();
    let mut roots: Vec<PathBuf> = fs::read_dir(&base)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    roots.sort();
    for source_root in roots {
        let bundle_root = source_root.clone();
        let manifest = primary_file(&bundle_root);
        let manifest_content = fs::read_to_string(&manifest).unwrap_or_default();
        let fallback = folder_display_name(&bundle_root);
        let (name, description) = metadata(&manifest_content, fallback);
        let (content, bundle_entries, image_paths) = build_bundle(&bundle_root);
        let mut source = read_source(&source_root);
        let git = source_root.join(".git").exists();
        if source.kind.is_empty() && git {
            source.kind = "git".into();
            source.url = std::process::Command::new("git")
                .arg("-C")
                .arg(&source_root)
                .args(["remote", "get-url", "origin"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .unwrap_or_default();
            source.revision = std::process::Command::new("git")
                .arg("-C")
                .arg(&source_root)
                .args(["rev-parse", "HEAD"])
                .output()
                .ok()
                .filter(|output| output.status.success())
                .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
                .unwrap_or_default();
            let _ = write_source(&source_root, &source);
        } else if source.kind.is_empty() {
            source.kind = "local".into();
            let _ = write_source(&source_root, &source);
        }
        let update_available = source.kind == "local"
            && !source.directory.is_empty()
            && Path::new(&source.directory).is_dir()
            && !source.source_hash.is_empty()
            && source_signature(Path::new(&source.directory)) != source.source_hash;
        if source.id.is_empty() {
            source.id = skill_id(&source_root.to_string_lossy());
            let _ = write_source(&source_root, &source);
        }
        let id = source.id.clone();
        items.push(LibraryItem {
            id,
            name,
            description,
            path: manifest.to_string_lossy().to_string(),
            bundle_root: bundle_root.to_string_lossy().to_string(),
            source_root: source_root.to_string_lossy().to_string(),
            content,
            files: bundle_entries,
            image_paths,
            git,
            source_kind: source.kind,
            source_url: source.url,
            source_directory: source.directory,
            revision: source.revision,
            update_available,
        });
    }
    items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(items)
}

#[tauri::command]
pub fn library_load_images(app: AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    let skill_base = kind_dir(&app, "skills")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut total = 0u64;
    for raw in paths.into_iter().take(6) {
        let path = PathBuf::from(raw)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !path.starts_with(&skill_base) || !is_image_file(&path) {
            continue;
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        if bytes.len() > 4_000_000 || total + bytes.len() as u64 > 12_000_000 {
            continue;
        }
        total += bytes.len() as u64;
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            _ => "image/png",
        };
        out.push(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        ));
    }
    Ok(out)
}

#[tauri::command]
pub fn library_copy_asset(
    app: AppHandle,
    workspace: String,
    source: String,
    path: String,
    allowed_roots: Vec<String>,
) -> Result<(), String> {
    let skill_base = kind_dir(&app, "skills")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let source = PathBuf::from(source)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !source.starts_with(&skill_base) || !source.is_file() {
        return Err("source is not a skill file".into());
    }
    let selected_root = allowed_roots
        .into_iter()
        .filter_map(|raw| PathBuf::from(raw).canonicalize().ok())
        .find(|root| root.starts_with(&skill_base) && source.starts_with(root))
        .ok_or("this skill was not selected for the current message")?;
    let selected_id = read_source(&selected_root).id;
    let enabled = read_skill_map(&workspace)?.into_values().any(|item| {
        if !item.enabled {
            return false;
        }
        if !selected_id.is_empty() && item.id == selected_id {
            return true;
        }
        PathBuf::from(item.directory)
            .canonicalize()
            .map(|root| source.starts_with(root))
            .unwrap_or(false)
    });
    if !enabled {
        return Err("skill access is disabled for this project".into());
    }
    let destination = crate::resolve(&workspace, &path)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::copy(source, destination).map_err(|e| e.to_string())?;
    Ok(())
}

fn progress_percent(line: &str) -> Option<u8> {
    let at = line.find('%')?;
    let digits: String = line[..at]
        .chars()
        .rev()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    digits.parse::<u8>().ok().filter(|value| *value <= 100)
}

fn progress_phase(line: &str) -> &str {
    let lower = line.to_ascii_lowercase();
    if lower.contains("counting") {
        "counting"
    } else if lower.contains("compressing") {
        "compressing"
    } else if lower.contains("receiving") {
        "receiving"
    } else if lower.contains("resolving") {
        "resolving"
    } else if lower.contains("checkout") || lower.contains("updating files") {
        "checkout"
    } else if lower.contains("lfs") || lower.contains("downloading") {
        "lfs"
    } else {
        "git"
    }
}

fn managed_git_lfs(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("tools")
        .join("git-lfs")
        .join("git-lfs"))
}

fn git_path(app: &AppHandle) -> String {
    let managed = managed_git_lfs(app)
        .ok()
        .and_then(|path| path.parent().map(Path::to_path_buf));
    let mut paths = managed.into_iter().collect::<Vec<_>>();
    paths.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(current) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&current));
    }
    std::env::join_paths(paths)
        .unwrap_or_default()
        .to_string_lossy()
        .to_string()
}

async fn git_lfs_version(app: &AppHandle) -> Option<(String, bool)> {
    let managed = managed_git_lfs(app).ok()?;
    if managed.is_file() {
        let output = Command::new(&managed).arg("version").output().await.ok()?;
        if output.status.success() {
            return Some((
                String::from_utf8_lossy(&output.stdout).trim().to_string(),
                true,
            ));
        }
    }
    let output = Command::new("git")
        .args(["lfs", "version"])
        .env("PATH", git_path(app))
        .output()
        .await
        .ok()?;
    output.status.success().then(|| {
        (
            String::from_utf8_lossy(&output.stdout).trim().to_string(),
            false,
        )
    })
}

#[tauri::command]
pub async fn git_lfs_status(app: AppHandle) -> Result<GitLfsStatus, String> {
    let status = git_lfs_version(&app).await;
    Ok(GitLfsStatus {
        installed: status.is_some(),
        version: status
            .as_ref()
            .map(|value| value.0.clone())
            .unwrap_or_default(),
        managed: status.map(|value| value.1).unwrap_or(false),
    })
}

#[tauri::command]
pub async fn git_lfs_install(app: AppHandle, operation_id: String) -> Result<GitLfsStatus, String> {
    if git_lfs_version(&app).await.is_some() {
        return git_lfs_status(app).await;
    }
    let tools = managed_git_lfs(&app)?;
    let parent = tools.parent().ok_or("invalid Git LFS install directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let url = format!(
        "https://github.com/git-lfs/git-lfs/releases/download/v{0}/git-lfs-darwin-{1}-v{0}.zip",
        GIT_LFS_VERSION, GIT_LFS_ARCH
    );
    emit_progress(
        &app,
        &operation_id,
        "downloading",
        Some(0),
        "Downloading official Git LFS package",
    );
    let response = reqwest::Client::new()
        .get(url)
        .header("User-Agent", "MAHI Git LFS installer")
        .send()
        .await
        .map_err(|e| format!("Git LFS download failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Git LFS download failed: HTTP {}",
            response.status()
        ));
    }
    let total = response.content_length().filter(|size| *size <= 50_000_000);
    if response.content_length().is_some() && total.is_none() {
        return Err("Git LFS package is unexpectedly large".into());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("Git LFS download failed: {e}"))?;
        if bytes.len() + chunk.len() > 50_000_000 {
            return Err("Git LFS package is unexpectedly large".into());
        }
        bytes.extend_from_slice(&chunk);
        let percent = total.map(|size| ((bytes.len() as u64 * 100 / size).min(99)) as u8);
        emit_progress(
            &app,
            &operation_id,
            "downloading",
            percent,
            "Downloading official Git LFS package",
        );
    }
    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != GIT_LFS_SHA256 {
        return Err("Git LFS package verification failed; nothing was installed".into());
    }
    emit_progress(
        &app,
        &operation_id,
        "installing",
        None,
        "Verifying and installing Git LFS",
    );
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| e.to_string())?;
    let mut binary = Vec::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| e.to_string())?;
        if entry.name().ends_with("/git-lfs") && !entry.is_dir() {
            entry.read_to_end(&mut binary).map_err(|e| e.to_string())?;
            break;
        }
    }
    if binary.is_empty() {
        return Err("Git LFS binary was not found in the verified package".into());
    }
    let temp = parent.join("git-lfs.installing");
    fs::write(&temp, binary).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temp, fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    if tools.exists() {
        fs::remove_file(&tools).map_err(|e| e.to_string())?;
    }
    fs::rename(&temp, &tools).map_err(|e| e.to_string())?;
    let install = Command::new(&tools)
        .args(["install", "--skip-repo"])
        .env("PATH", git_path(&app))
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !install.status.success() {
        let _ = fs::remove_file(&tools);
        return Err(String::from_utf8_lossy(&install.stderr).trim().to_string());
    }
    emit_progress(
        &app,
        &operation_id,
        "complete",
        Some(100),
        "Git LFS installed",
    );
    git_lfs_status(app).await
}

async fn run_git_progress(
    app: &AppHandle,
    operation_id: &str,
    cwd: Option<&Path>,
    args: Vec<String>,
) -> Result<(), String> {
    let mut command = Command::new("git");
    if let Some(dir) = cwd {
        command.arg("-C").arg(dir);
    }
    command
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("PATH", git_path(app))
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("git could not start: {e}"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or("git progress stream unavailable")?;
    let mut segments = BufReader::new(stderr).split(b'\r');
    let mut tail: Vec<String> = Vec::new();
    while let Some(segment) = segments.next_segment().await.map_err(|e| e.to_string())? {
        for line in String::from_utf8_lossy(&segment).lines() {
            let clean = line.trim().to_string();
            if clean.is_empty() {
                continue;
            }
            emit_progress(
                app,
                operation_id,
                progress_phase(&clean),
                progress_percent(&clean),
                &clean,
            );
            tail.push(clean);
            if tail.len() > 12 {
                tail.remove(0);
            }
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        let useful = tail
            .into_iter()
            .filter(|line| !line.starts_with("Cloning into"))
            .collect::<Vec<_>>()
            .join("\n");
        Err(if useful.is_empty() {
            format!("git exited with {status}")
        } else {
            useful
        })
    }
}

async fn git_revision(root: &Path) -> String {
    Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_default()
}

async fn clone_into(
    app: &AppHandle,
    url: &str,
    dest: &Path,
    operation_id: &str,
) -> Result<String, String> {
    emit_progress(
        app,
        operation_id,
        "starting",
        Some(0),
        "Preparing repository",
    );
    run_git_progress(
        app,
        operation_id,
        None,
        vec![
            "clone".into(),
            "--progress".into(),
            "--no-checkout".into(),
            "--depth".into(),
            "1".into(),
            "--".into(),
            url.into(),
            dest.to_string_lossy().to_string(),
        ],
    )
    .await?;

    let attributes = Command::new("git")
        .arg("-C")
        .arg(dest)
        .args(["show", "HEAD:.gitattributes"])
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).to_string())
        .unwrap_or_default();
    if attributes.contains("filter=lfs") {
        if git_lfs_version(app).await.is_none() {
            return Err("This repository requires Git LFS. Install it from the Skill Library and retry; the existing skill library was not changed.".into());
        }
    }
    emit_progress(app, operation_id, "checkout", Some(0), "Checking out files");
    run_git_progress(
        app,
        operation_id,
        Some(dest),
        vec!["checkout".into(), "--progress".into(), "--force".into()],
    )
    .await?;
    if attributes.contains("filter=lfs") {
        emit_progress(app, operation_id, "lfs", None, "Downloading Git LFS files");
        run_git_progress(
            app,
            operation_id,
            Some(dest),
            vec!["lfs".into(), "pull".into()],
        )
        .await?;
    }
    Ok(git_revision(dest).await)
}

fn replace_tree(current: &Path, replacement: &Path) -> Result<(), String> {
    let parent = current.parent().ok_or("invalid skill directory")?;
    let backup = unique_dest(parent, "backup");
    fs::rename(current, &backup).map_err(|e| format!("could not preserve current skill: {e}"))?;
    if let Err(error) = fs::rename(replacement, current) {
        let _ = fs::rename(&backup, current);
        return Err(format!("could not activate updated skill: {error}"));
    }
    let _ = fs::remove_dir_all(backup);
    Ok(())
}

#[tauri::command]
pub fn library_import_directory(
    app: AppHandle,
    kind: String,
    source: String,
    operation_id: String,
) -> Result<(), String> {
    let source = PathBuf::from(source)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !source.is_dir() {
        return Err("selected path is not a directory".into());
    }
    let base = kind_dir(&app, &kind)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if source.starts_with(&base) {
        return Err("this folder is already inside MAHI Skills".into());
    }
    let hint = source
        .file_name()
        .and_then(|x| x.to_str())
        .unwrap_or("import");
    let dest = unique_dest(&base, hint);
    let temp = unique_dest(&base, "importing");
    emit_progress(
        &app,
        &operation_id,
        "copying",
        None,
        "Copying local skill into MAHI Skills",
    );
    let result = (|| {
        copy_tree(&source, &temp, false)?;
        write_source(
            &temp,
            &SkillSource {
                id: skill_id(&source.to_string_lossy()),
                kind: "local".into(),
                directory: source.to_string_lossy().to_string(),
                source_hash: source_signature(&source),
                ..Default::default()
            },
        )?;
        fs::rename(&temp, &dest).map_err(|e| e.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    if result.is_ok() {
        emit_progress(
            &app,
            &operation_id,
            "complete",
            Some(100),
            "Local skill imported",
        );
    }
    result
}

#[tauri::command]
pub async fn library_clone(
    app: AppHandle,
    kind: String,
    url: String,
    operation_id: String,
) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("only HTTPS Git repository URLs are allowed".into());
    }
    let base = kind_dir(&app, &kind)?;
    let hint = url
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("repository")
        .trim_end_matches(".git");
    let dest = unique_dest(&base, hint);
    let temp = unique_dest(&base, "cloning");
    let result = async {
        let revision = clone_into(&app, &url, &temp, &operation_id).await?;
        write_source(
            &temp,
            &SkillSource {
                id: skill_id(&url),
                kind: "git".into(),
                url: url.clone(),
                revision,
                ..Default::default()
            },
        )?;
        fs::rename(&temp, &dest).map_err(|e| e.to_string())?;
        Ok(())
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    if result.is_ok() {
        emit_progress(
            &app,
            &operation_id,
            "complete",
            Some(100),
            "Repository cloned",
        );
    }
    result
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSkillInput {
    id: String,
    name: String,
    directory: String,
    enabled: bool,
    files: Vec<LibraryFile>,
}

fn skill_map_path(workspace: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| format!("invalid workspace: {e}"))?;
    Ok(root.join(".mahi").join("skills.yaml"))
}

fn read_skill_map(workspace: &str) -> Result<BTreeMap<String, ProjectSkillInput>, String> {
    let path = skill_map_path(workspace)?;
    let Ok(content) = fs::read_to_string(path) else {
        return Ok(BTreeMap::new());
    };
    let mut out = BTreeMap::new();
    for line in content.lines() {
        let Some(json) = line.trim().strip_prefix("- ") else {
            continue;
        };
        if let Ok(item) = serde_json::from_str::<ProjectSkillInput>(json) {
            out.insert(item.id.clone(), item);
        }
    }
    Ok(out)
}

fn ensure_mahi_ignored(workspace: &str) -> Result<(), String> {
    let root = PathBuf::from(workspace)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = root.join(".gitignore");
    let mut content = fs::read_to_string(&path).unwrap_or_default();
    if !content.lines().any(|line| line.trim() == ".mahi/") {
        if !content.is_empty() && !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(".mahi/\n");
        fs::write(path, content).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn library_save_project_map(
    workspace: String,
    skills: Vec<ProjectSkillInput>,
) -> Result<(), String> {
    let mut merged = read_skill_map(&workspace)?;
    for old in merged.values_mut() {
        old.enabled = false;
    }
    for item in skills {
        merged.insert(item.id.clone(), item);
    }
    let path = skill_map_path(&workspace)?;
    fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut yaml = String::from("version: 1\nskills:\n");
    for item in merged.values() {
        yaml.push_str("  - ");
        yaml.push_str(&serde_json::to_string(item).map_err(|e| e.to_string())?);
        yaml.push('\n');
    }
    fs::write(path, yaml).map_err(|e| e.to_string())?;
    ensure_mahi_ignored(&workspace)
}

fn checked_source_root(app: &AppHandle, kind: &str, source_root: &str) -> Result<PathBuf, String> {
    let base = kind_dir(app, kind)?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let path = PathBuf::from(source_root)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !path.starts_with(&base) || path == base {
        return Err("path is outside the library".into());
    }
    Ok(path)
}

#[tauri::command]
pub fn library_remove(app: AppHandle, kind: String, source_root: String) -> Result<(), String> {
    fs::remove_dir_all(checked_source_root(&app, &kind, &source_root)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn library_update(
    app: AppHandle,
    kind: String,
    source_root: String,
    source_override: Option<String>,
    operation_id: String,
) -> Result<(), String> {
    let root = checked_source_root(&app, &kind, &source_root)?;
    let mut source = read_source(&root);
    let parent = root.parent().ok_or("invalid skill directory")?;
    let temp = unique_dest(parent, "updating");
    let result = if source.kind == "git" || root.join(".git").exists() {
        let url = if !source.url.is_empty() {
            source.url.clone()
        } else {
            let output = Command::new("git")
                .arg("-C")
                .arg(&root)
                .args(["remote", "get-url", "origin"])
                .output()
                .await
                .map_err(|e| e.to_string())?;
            if !output.status.success() {
                return Err("the original repository URL is unavailable".into());
            }
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        async {
            let revision = clone_into(&app, &url, &temp, &operation_id).await?;
            source.kind = "git".into();
            source.url = url;
            source.revision = revision;
            write_source(&temp, &source)?;
            replace_tree(&root, &temp)
        }
        .await
    } else {
        let directory = source_override
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(source.directory.clone());
        if directory.is_empty() {
            return Err("the original local source folder is unknown; choose it again".into());
        }
        let local = PathBuf::from(&directory).canonicalize().map_err(|_| {
            "the original local source folder no longer exists; choose it again".to_string()
        })?;
        if !local.is_dir() {
            return Err("the selected local source is not a directory".into());
        }
        let library_base = kind_dir(&app, &kind)?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if local.starts_with(&library_base) {
            return Err("choose the original folder outside MAHI Skills".into());
        }
        emit_progress(
            &app,
            &operation_id,
            "copying",
            None,
            "Copying updated local skill",
        );
        source.kind = "local".into();
        source.directory = local.to_string_lossy().to_string();
        source.source_hash = source_signature(&local);
        (|| {
            copy_tree(&local, &temp, false)?;
            write_source(&temp, &source)?;
            replace_tree(&root, &temp)
        })()
    };
    if result.is_err() {
        let _ = fs::remove_dir_all(&temp);
    }
    if result.is_ok() {
        emit_progress(&app, &operation_id, "complete", Some(100), "Skill updated");
    }
    result
}
