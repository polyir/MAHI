// Chat session history used to live entirely in the webview's localStorage
// (see src/ide/sessions.ts / ChatPanel.tsx), which has a ~5MB per-origin
// quota in WebKit. Long-running conversations eventually filled that quota,
// which silently broke every OTHER localStorage-backed setting in the app
// (any new small key's setItem throws QuotaExceededError once the quota is
// already exhausted) — confirmed via a debug probe during the settings-
// persistence bug investigation. Sessions are now persisted to a plain JSON
// file instead, which has no such ceiling; the frontend still owns
// serialization, this module just stores/returns the opaque JSON string.
use std::fs;
use tauri::{AppHandle, Manager};

fn sessions_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sessions.json"))
}

#[tauri::command]
pub fn sessions_load(app: AppHandle) -> Result<Option<String>, String> {
    let path = sessions_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn sessions_save(app: AppHandle, json: String) -> Result<(), String> {
    let path = sessions_path(&app)?;
    fs::write(path, json).map_err(|e| e.to_string())
}
