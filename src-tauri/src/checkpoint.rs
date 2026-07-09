use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::State;

#[derive(Clone)]
enum SnapshotContent {
    Missing,
    File(Vec<u8>),
    Dir {
        dirs: Vec<PathBuf>,
        files: Vec<(PathBuf, Vec<u8>)>,
    },
}

/// Snapshot of one path before a mutation.
type Snapshot = (String, SnapshotContent);

#[derive(Default)]
pub struct CheckpointManager {
    groups: Mutex<HashMap<u64, Vec<Snapshot>>>,
    counter: AtomicU64,
}

#[tauri::command]
pub fn checkpoint_begin(state: State<CheckpointManager>) -> u64 {
    let id = state.counter.fetch_add(1, Ordering::SeqCst) + 1;
    state.groups.lock().unwrap().insert(id, Vec::new());
    id
}

/// Record the current state of `path` into checkpoint `id`, if not already
/// recorded (first snapshot per file wins, so revert returns to turn start).
#[tauri::command]
pub fn checkpoint_record(
    state: State<CheckpointManager>,
    workspace: String,
    id: u64,
    path: String,
) -> Result<(), String> {
    let abs = crate::resolve(&workspace, &path)?;
    crate::ensure_not_workspace_root(&workspace, &abs)?;
    let content = snapshot_path(&abs)?;
    let mut groups = state.groups.lock().unwrap();
    let group = groups.get_mut(&id).ok_or("unknown checkpoint id")?;
    if !group.iter().any(|(p, _)| p == &path) {
        group.push((path, content));
    }
    Ok(())
}

/// Restore every file recorded in checkpoint `id` to its snapshotted state.
/// Returns the list of restored paths. The checkpoint stays available so the
/// user can revert again after further changes if they want.
#[tauri::command]
pub fn checkpoint_revert(
    state: State<CheckpointManager>,
    workspace: String,
    id: u64,
) -> Result<Vec<String>, String> {
    let snapshots = {
        let groups = state.groups.lock().unwrap();
        groups.get(&id).ok_or("unknown checkpoint id")?.clone()
    };
    let mut restored = Vec::new();
    for (path, content) in snapshots.iter().rev() {
        let abs = crate::resolve(&workspace, path)?;
        match content {
            SnapshotContent::File(c) => {
                remove_existing(&abs)?;
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&abs, c).map_err(|e| e.to_string())?;
            }
            SnapshotContent::Dir { dirs, files } => {
                remove_existing(&abs)?;
                fs::create_dir_all(&abs).map_err(|e| e.to_string())?;
                for dir in dirs {
                    fs::create_dir_all(abs.join(dir)).map_err(|e| e.to_string())?;
                }
                for (rel, bytes) in files {
                    let dest = abs.join(rel);
                    if let Some(parent) = dest.parent() {
                        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                    }
                    fs::write(dest, bytes).map_err(|e| e.to_string())?;
                }
            }
            SnapshotContent::Missing => {
                remove_existing(&abs)?;
            }
        }
        restored.push(path.clone());
    }
    Ok(restored)
}

fn snapshot_path(abs: &Path) -> Result<SnapshotContent, String> {
    if !abs.exists() {
        return Ok(SnapshotContent::Missing);
    }
    if abs.is_dir() {
        let mut dirs = Vec::new();
        let mut files = Vec::new();
        collect_dir(abs, abs, &mut dirs, &mut files)?;
        return Ok(SnapshotContent::Dir { dirs, files });
    }
    Ok(SnapshotContent::File(
        fs::read(abs).map_err(|e| e.to_string())?,
    ))
}

fn collect_dir(
    root: &Path,
    dir: &Path,
    dirs: &mut Vec<PathBuf>,
    files: &mut Vec<(PathBuf, Vec<u8>)>,
) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let rel = path
            .strip_prefix(root)
            .map_err(|e| e.to_string())?
            .to_path_buf();
        if file_type.is_dir() {
            dirs.push(rel);
            collect_dir(root, &path, dirs, files)?;
        } else if file_type.is_file() {
            files.push((rel, fs::read(&path).map_err(|e| e.to_string())?));
        }
    }
    Ok(())
}

fn remove_existing(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())?;
    } else if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
