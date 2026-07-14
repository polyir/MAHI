use base64::Engine;
use serde_json::Value;
use std::fs;

#[cfg(target_os = "macos")]
mod native {
    use serde_json::Value;
    use std::ffi::{c_char, CStr, CString};

    unsafe extern "C" {
        fn mahi_mic_start(path: *const c_char) -> *mut c_char;
        fn mahi_mic_level() -> *mut c_char;
        fn mahi_mic_stop() -> *mut c_char;
        fn mahi_mic_free_string(value: *mut c_char);
    }

    fn take_json(pointer: *mut c_char) -> Result<Value, String> {
        if pointer.is_null() {
            return Err("native microphone bridge returned no data".into());
        }
        let text = unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned();
        unsafe { mahi_mic_free_string(pointer) };
        let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
        if value.get("status").and_then(Value::as_str) == Some("failed") {
            return Err(value
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Microphone recording failed")
                .to_string());
        }
        Ok(value)
    }

    pub fn start(path: &str) -> Result<Value, String> {
        let path = CString::new(path).map_err(|_| "invalid microphone path")?;
        take_json(unsafe { mahi_mic_start(path.as_ptr()) })
    }

    pub fn stop() -> Result<Value, String> {
        take_json(unsafe { mahi_mic_stop() })
    }

    pub fn level() -> Result<Value, String> {
        take_json(unsafe { mahi_mic_level() })
    }
}

#[tauri::command]
pub async fn microphone_start(workspace: String, path: String) -> Result<Value, String> {
    let absolute = crate::resolve(&workspace, &path)?;
    crate::ensure_not_workspace_root(&workspace, &absolute)?;
    if let Some(parent) = absolute.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        let path = absolute.to_string_lossy().into_owned();
        return tokio::task::spawn_blocking(move || native::start(&path))
            .await
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native microphone recording is currently available on macOS only".into())
}

#[tauri::command]
pub async fn microphone_stop() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        return tokio::task::spawn_blocking(native::stop)
            .await
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native microphone recording is currently available on macOS only".into())
}

#[tauri::command]
pub fn microphone_level() -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        return native::level();
    }
    #[cfg(not(target_os = "macos"))]
    Err("Native microphone metering is currently available on macOS only".into())
}

#[tauri::command]
pub fn microphone_read(workspace: String, path: String) -> Result<String, String> {
    let absolute = crate::resolve(&workspace, &path)?;
    let bytes = fs::read(absolute).map_err(|error| error.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}
