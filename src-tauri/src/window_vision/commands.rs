use super::manager::WindowVisionManager;
use super::platform;
use super::types::{WindowInfo, WindowList};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

static PICKER_COUNTER: AtomicU64 = AtomicU64::new(1);

fn parse_windows(value: &Value) -> Result<Vec<WindowInfo>, String> {
    let parsed: WindowList =
        serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
    if parsed.status != "ok" {
        return Err(value
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Unable to list windows")
            .to_string());
    }
    Ok(parsed.windows)
}

fn filtered_windows(value: Value, allowed: Option<&BTreeSet<String>>) -> Result<Value, String> {
    let windows = parse_windows(&value)?
        .into_iter()
        .filter(|window| !WindowVisionManager::never_allowed(&window.bundle_id))
        .filter(|window| {
            allowed
                .map(|bundle_ids| bundle_ids.contains(&window.bundle_id))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "status": "ok",
        "windows": windows,
        "displays": value.get("displays").cloned().unwrap_or_else(|| json!([]))
    }))
}

fn bundle_matches(actual: &str, requested: &str) -> bool {
    actual == requested
        || (requested == "com.adobe.PremierePro"
            && actual.starts_with("com.adobe.PremierePro."))
}

fn require_global_permission() -> Result<(), String> {
    if platform::permission_granted() {
        Ok(())
    } else {
        Err("Screen Recording permission is required once in System Settings".into())
    }
}

fn choose_window(
    windows: impl IntoIterator<Item = WindowInfo>,
    bundle_id: &str,
    title_contains: Option<&str>,
    role: Option<&str>,
) -> Option<WindowInfo> {
    let title = title_contains.map(str::to_lowercase);
    let mut matches = windows
        .into_iter()
        .filter(|window| bundle_matches(&window.bundle_id, bundle_id))
        .filter(|window| {
            title
                .as_ref()
                .map(|needle| window.title.to_lowercase().contains(needle))
                .unwrap_or(true)
        })
        .filter(|window| role.map(|value| window.role == value).unwrap_or(true))
        .collect::<Vec<_>>();
    matches.sort_by_key(|window| std::cmp::Reverse(window.rank()));
    matches.into_iter().next()
}

async fn native<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(operation)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn window_vision_capabilities() -> Value {
    json!({
        "supported": platform::supported(),
        "permissionGranted": platform::permission_granted(),
        "pickerSupported": platform::picker_supported()
    })
}

#[tauri::command]
pub async fn window_vision_request_permission() -> Result<Value, String> {
    native(|| Ok(json!({"granted": platform::request_permission()}))).await
}

#[tauri::command]
pub fn window_vision_allowed_apps(
    app: AppHandle,
    state: State<'_, WindowVisionManager>,
) -> Result<Value, String> {
    Ok(json!({"bundleIds": state.allowed(&app)?}))
}

#[tauri::command]
pub async fn window_vision_present_picker(
    app: AppHandle,
    state: State<'_, WindowVisionManager>,
    capture_mode: Option<String>,
) -> Result<Value, String> {
    let _ = state.allowed(&app)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let session_id = format!(
        "picker_{timestamp}_{}",
        PICKER_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let display_mode = capture_mode.as_deref() == Some("display");
    native(move || platform::present_picker(&session_id, display_mode)).await
}

#[tauri::command]
pub async fn window_vision_picker_result(
    app: AppHandle,
    state: State<'_, WindowVisionManager>,
    session_id: String,
) -> Result<Value, String> {
    let picker_session_id = session_id.clone();
    let result = native(move || platform::picker_result(&picker_session_id)).await?;
    if matches!(
        result.get("pickerStatus").and_then(Value::as_str),
        Some("selected")
    ) {
        let added = state.add_from_picker(&app, &result)?;
        let mut result = result;
        let is_window_picker = result.pointer("/metadata/mode").and_then(Value::as_str)
            == Some("picker");
        if is_window_picker && added.is_empty() {
            let session_id = session_id.clone();
            let _ = native(move || platform::stop(&session_id)).await;
            if let Some(object) = result.as_object_mut() {
                object.insert("status".into(), json!("failed"));
                object.insert("pickerStatus".into(), json!("failed"));
                object.insert(
                    "error".into(),
                    json!("The selected window could not be identified securely; please select it again"),
                );
            }
        }
        if let Some(object) = result.as_object_mut() {
            object.insert("allowedBundleIdsAdded".into(), json!(added));
        }
        return Ok(result);
    }
    Ok(result)
}

#[tauri::command]
pub async fn window_vision_remove_allowed_app(
    app: AppHandle,
    state: State<'_, WindowVisionManager>,
    bundle_id: String,
) -> Result<Value, String> {
    state.remove(&app, &bundle_id)?;
    let sessions = native(platform::list_sessions).await?;
    if let Some(items) = sessions.get("sessions").and_then(Value::as_array) {
        for session in items {
            let belongs = session
                .pointer("/metadata/bundleId")
                .and_then(Value::as_str)
                == Some(&bundle_id)
                || session
                    .pointer("/metadata/bundleIds")
                    .and_then(Value::as_array)
                    .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(&bundle_id)));
            if belongs {
                if let Some(session_id) = session.get("sessionId").and_then(Value::as_str) {
                    let session_id = session_id.to_string();
                    let _ = native(move || platform::stop(&session_id)).await;
                }
            }
        }
    }
    Ok(json!({"status": "ok", "bundleId": bundle_id}))
}

#[tauri::command]
pub async fn window_vision_list_allowed_windows(
    _app: AppHandle,
    _state: State<'_, WindowVisionManager>,
) -> Result<Value, String> {
    require_global_permission()?;
    let value = native(platform::list_windows).await?;
    filtered_windows(value, None)
}

#[tauri::command]
pub async fn window_vision_observe_app(
    _app: AppHandle,
    _state: State<'_, WindowVisionManager>,
    session_id: String,
    bundle_id: String,
    window_id: Option<u32>,
    title_contains: Option<String>,
    role: Option<String>,
    include_cursor: Option<bool>,
    fps: Option<f64>,
    threshold: Option<f64>,
) -> Result<Value, String> {
    require_global_permission()?;
    if WindowVisionManager::never_allowed(&bundle_id) {
        return Ok(json!({
            "status": "not_allowed",
            "bundleId": bundle_id,
            "error": "MAHI never observes this protected application"
        }));
    }
    let value = native(platform::list_windows).await?;
    let windows = parse_windows(&value)?;
    let window = if let Some(window_id) = window_id {
        windows
            .into_iter()
            .find(|window| {
                window.window_id == window_id && bundle_matches(&window.bundle_id, &bundle_id)
            })
    } else {
        choose_window(
            windows,
            &bundle_id,
            title_contains.as_deref(),
            role.as_deref(),
        )
    }
    .ok_or_else(|| format!("No matching window found for {bundle_id}"))?;
    native(move || {
        platform::start_window(
            &session_id,
            window.window_id,
            include_cursor.unwrap_or(false),
            fps.unwrap_or(1.0).clamp(0.5, 10.0),
            threshold.unwrap_or(0.03).clamp(0.001, 1.0),
        )
    })
    .await
}

#[tauri::command]
pub async fn window_vision_start_group(
    _app: AppHandle,
    _state: State<'_, WindowVisionManager>,
    session_id: String,
    display_id: u32,
    window_ids: Vec<u32>,
    include_cursor: Option<bool>,
    fps: Option<f64>,
    threshold: Option<f64>,
) -> Result<Value, String> {
    require_global_permission()?;
    if window_ids.is_empty() {
        return Err("windowIds cannot be empty".into());
    }
    let value = native(platform::list_windows).await?;
    let windows = parse_windows(&value)?;
    let requested = window_ids.iter().copied().collect::<HashSet<_>>();
    let matches = windows
        .iter()
        .filter(|window| requested.contains(&window.window_id))
        .collect::<Vec<_>>();
    if matches.len() != requested.len()
        || matches
            .iter()
            .any(|window| WindowVisionManager::never_allowed(&window.bundle_id))
    {
        return Err("Every grouped window must exist and must not be protected".into());
    }
    if matches
        .iter()
        .any(|window| window.display_id != Some(display_id))
    {
        return Err(
            "Group capture is display-bound; every window must be on the selected display".into(),
        );
    }
    native(move || {
        platform::start_group(
            &session_id,
            display_id,
            &window_ids,
            include_cursor.unwrap_or(false),
            fps.unwrap_or(1.0).clamp(0.5, 10.0),
            threshold.unwrap_or(0.03).clamp(0.001, 1.0),
        )
    })
    .await
}

#[tauri::command]
pub async fn window_vision_sessions() -> Result<Value, String> {
    native(platform::list_sessions).await
}

#[tauri::command]
pub async fn window_vision_capture(
    session_id: String,
    since_revision: Option<u64>,
) -> Result<Value, String> {
    native(move || platform::capture(&session_id, since_revision.unwrap_or(0))).await
}

#[tauri::command]
pub async fn window_vision_wait_for_change(
    session_id: String,
    after_revision: u64,
    timeout_ms: Option<u32>,
) -> Result<Value, String> {
    native(move || {
        platform::wait_for_change(
            &session_id,
            after_revision,
            timeout_ms.unwrap_or(3000).min(30_000),
        )
    })
    .await
}

#[tauri::command]
pub async fn window_vision_stop(session_id: String) -> Result<Value, String> {
    native(move || platform::stop(&session_id)).await
}

#[tauri::command]
pub async fn window_vision_stop_all() -> Result<Value, String> {
    native(platform::stop_all).await
}

#[tauri::command]
pub async fn window_vision_detect_dialogs(
    _app: AppHandle,
    _state: State<'_, WindowVisionManager>,
    bundle_id: String,
    known_window_ids: Vec<u32>,
) -> Result<Value, String> {
    require_global_permission()?;
    if WindowVisionManager::never_allowed(&bundle_id) {
        return Ok(json!({"status": "not_allowed", "windows": []}));
    }
    let known = known_window_ids.into_iter().collect::<HashSet<_>>();
    let value = native(platform::list_windows).await?;
    let windows = parse_windows(&value)?
        .into_iter()
        .filter(|window| bundle_matches(&window.bundle_id, &bundle_id))
        .filter(|window| !known.contains(&window.window_id))
        .filter(|window| window.role == "dialog" || window.role == "panel")
        .collect::<Vec<_>>();
    Ok(json!({"status": "ok", "windows": windows}))
}

#[tauri::command]
pub async fn window_vision_auto_prepare(
    _app: AppHandle,
    _state: State<'_, WindowVisionManager>,
    bundle_id: String,
) -> Result<Value, String> {
    require_global_permission()?;
    if WindowVisionManager::never_allowed(&bundle_id) {
        return Ok(json!({"status": "not_allowed", "bundleId": bundle_id}));
    }
    let sessions = native(platform::list_sessions).await?;
    if let Some(session) = sessions
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|sessions| {
            sessions.iter().find(|session| {
                session
                    .pointer("/metadata/bundleId")
                    .and_then(Value::as_str)
                    .is_some_and(|actual| bundle_matches(actual, &bundle_id))
                    && matches!(
                        session.get("status").and_then(Value::as_str),
                        Some("active" | "stale")
                    )
            })
        })
    {
        return Ok(session.clone());
    }
    let value = native(platform::list_windows).await?;
    let window =
        choose_window(parse_windows(&value)?, &bundle_id, None, Some("main")).or_else(|| {
            choose_window(
                parse_windows(&value).unwrap_or_default(),
                &bundle_id,
                None,
                None,
            )
        });
    let Some(window) = window else {
        return Ok(json!({"status": "window_not_found", "bundleId": bundle_id}));
    };
    let safe_bundle = bundle_id
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    native(move || {
        platform::start_window(
            &format!("auto_{safe_bundle}"),
            window.window_id,
            false,
            2.0,
            0.03,
        )
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_vision::types::WindowFrame;

    fn window(id: u32, title: &str, active: bool, role: &str, width: f64) -> WindowInfo {
        WindowInfo {
            window_id: id,
            title: title.into(),
            bundle_id: "com.test.App".into(),
            application_name: "App".into(),
            process_id: 1,
            display_id: Some(1),
            role: role.into(),
            is_on_screen: true,
            is_active: active,
            layer: 0,
            frame: WindowFrame {
                x: 0.0,
                y: 0.0,
                width,
                height: 600.0,
            },
        }
    }

    #[test]
    fn chooses_active_matching_window() {
        let selected = choose_window(
            vec![
                window(1, "Project", false, "main", 1200.0),
                window(2, "Project", true, "main", 800.0),
            ],
            "com.test.App",
            Some("project"),
            Some("main"),
        )
        .unwrap();
        assert_eq!(selected.window_id, 2);
    }

    #[test]
    fn excludes_windows_outside_allowlist() {
        let value = json!({"status": "ok", "windows": [window(1, "Project", true, "main", 800.0)]});
        let filtered = filtered_windows(value, Some(&BTreeSet::new())).unwrap();
        assert_eq!(filtered["windows"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn matches_versioned_premiere_bundle() {
        assert!(bundle_matches(
            "com.adobe.PremierePro.25",
            "com.adobe.PremierePro"
        ));
    }
}
