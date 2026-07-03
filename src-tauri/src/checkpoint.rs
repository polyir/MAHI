use std::collections::HashMap;
use std::fs;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::State;

/// Snapshot of one file before a mutation: its previous content, or None if
/// the file did not exist yet (revert then deletes it).
type Snapshot = (String, Option<String>);

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
    let content = fs::read_to_string(&abs).ok();
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
            Some(c) => {
                if let Some(parent) = abs.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::write(&abs, c).map_err(|e| e.to_string())?;
            }
            None => {
                let _ = fs::remove_file(&abs);
            }
        }
        restored.push(path.clone());
    }
    Ok(restored)
}
