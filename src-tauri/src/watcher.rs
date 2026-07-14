// Real filesystem watching for the open workspace. Without this, MAHI only
// ever learns about file changes it caused itself through its own tracked
// tool calls (write_file/edit_file/delete_file/move_file) — any change made
// outside that (Finder, a shell command, another app, or a file deleted and
// recreated under the same name) left the file tree and any open
// image/video/PDF preview showing stale state until the whole app was
// restarted. This watches the workspace root recursively and tells the
// frontend what actually changed on disk.
use notify::RecursiveMode;
use notify_debouncer_mini::{new_debouncer, DebouncedEventKind, Debouncer};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
pub struct WatcherManager {
    // Holding the Debouncer here is what keeps the watch alive — dropping it
    // (replacing with a new one when the workspace changes) stops the old
    // watch automatically.
    current: Mutex<Option<Debouncer<notify::RecommendedWatcher>>>,
}

#[derive(Clone, Serialize)]
struct FsChangedPayload {
    paths: Vec<String>,
}

/// True if any path component is something we already exclude from the file
/// tree/search (see crate::is_ignored) — skips noisy irrelevant churn from
/// .git/node_modules/target/etc. instead of refreshing the UI for it.
fn is_ignored_path(rel: &Path) -> bool {
    rel.components()
        .any(|c| crate::is_ignored(&c.as_os_str().to_string_lossy()))
}

#[tauri::command]
pub fn watch_workspace(
    app: AppHandle,
    state: tauri::State<WatcherManager>,
    workspace: String,
) -> Result<(), String> {
    let base = PathBuf::from(&workspace);
    let base_for_cb = base.clone();
    let app_for_cb = app.clone();

    let mut debouncer = new_debouncer(
        Duration::from_millis(400),
        move |res: notify_debouncer_mini::DebounceEventResult| {
            let Ok(events) = res else { return };
            let mut paths: Vec<String> = events
                .into_iter()
                .filter(|e| e.kind == DebouncedEventKind::Any)
                .filter_map(|e| {
                    e.path
                        .strip_prefix(&base_for_cb)
                        .ok()
                        .map(|p| p.to_path_buf())
                })
                .filter(|rel| !is_ignored_path(rel))
                .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                .collect();
            if paths.is_empty() {
                return;
            }
            paths.sort();
            paths.dedup();
            let _ = app_for_cb.emit("fs-changed", FsChangedPayload { paths });
        },
    )
    .map_err(|e| e.to_string())?;

    debouncer
        .watcher()
        .watch(&base, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;

    *state.current.lock().unwrap() = Some(debouncer);
    Ok(())
}
