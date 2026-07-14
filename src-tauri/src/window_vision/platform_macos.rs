use serde_json::Value;
use std::ffi::{c_char, c_int, CStr, CString};

unsafe extern "C" {
    fn mahi_wv_supported() -> c_int;
    fn mahi_wv_picker_supported() -> c_int;
    fn mahi_wv_permission_granted() -> c_int;
    fn mahi_wv_request_permission() -> c_int;
    fn mahi_wv_list_windows() -> *mut c_char;
    fn mahi_wv_list_sessions() -> *mut c_char;
    fn mahi_wv_start_window(
        session_id: *const c_char,
        window_id: u32,
        include_cursor: c_int,
        fps: f64,
        threshold: f64,
    ) -> *mut c_char;
    fn mahi_wv_start_group(
        session_id: *const c_char,
        display_id: u32,
        window_ids_json: *const c_char,
        include_cursor: c_int,
        fps: f64,
        threshold: f64,
    ) -> *mut c_char;
    fn mahi_wv_capture(session_id: *const c_char, since_revision: u64) -> *mut c_char;
    fn mahi_wv_wait_for_change(
        session_id: *const c_char,
        after_revision: u64,
        timeout_ms: u32,
    ) -> *mut c_char;
    fn mahi_wv_stop(session_id: *const c_char) -> *mut c_char;
    fn mahi_wv_stop_all() -> *mut c_char;
    fn mahi_wv_present_picker(session_id: *const c_char, display_mode: c_int) -> *mut c_char;
    fn mahi_wv_picker_result(session_id: *const c_char) -> *mut c_char;
    fn mahi_wv_free_string(value: *mut c_char);
}

fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "value contains a null byte".to_string())
}

fn take_json(pointer: *mut c_char) -> Result<Value, String> {
    if pointer.is_null() {
        return Err("native Window Vision bridge returned no data".into());
    }
    let text = unsafe { CStr::from_ptr(pointer) }
        .to_string_lossy()
        .into_owned();
    unsafe { mahi_wv_free_string(pointer) };
    serde_json::from_str(&text).map_err(|error| format!("invalid native response: {error}"))
}

pub fn supported() -> bool {
    unsafe { mahi_wv_supported() != 0 }
}

pub fn permission_granted() -> bool {
    unsafe { mahi_wv_permission_granted() != 0 }
}

pub fn picker_supported() -> bool {
    unsafe { mahi_wv_picker_supported() != 0 }
}

pub fn request_permission() -> bool {
    unsafe { mahi_wv_request_permission() != 0 }
}

pub fn list_windows() -> Result<Value, String> {
    take_json(unsafe { mahi_wv_list_windows() })
}

pub fn list_sessions() -> Result<Value, String> {
    take_json(unsafe { mahi_wv_list_sessions() })
}

pub fn start_window(
    session_id: &str,
    window_id: u32,
    include_cursor: bool,
    fps: f64,
    threshold: f64,
) -> Result<Value, String> {
    let session_id = cstring(session_id)?;
    take_json(unsafe {
        mahi_wv_start_window(
            session_id.as_ptr(),
            window_id,
            include_cursor as c_int,
            fps,
            threshold,
        )
    })
}

pub fn start_group(
    session_id: &str,
    display_id: u32,
    window_ids: &[u32],
    include_cursor: bool,
    fps: f64,
    threshold: f64,
) -> Result<Value, String> {
    let session_id = cstring(session_id)?;
    let ids = cstring(&serde_json::to_string(window_ids).map_err(|error| error.to_string())?)?;
    take_json(unsafe {
        mahi_wv_start_group(
            session_id.as_ptr(),
            display_id,
            ids.as_ptr(),
            include_cursor as c_int,
            fps,
            threshold,
        )
    })
}

pub fn capture(session_id: &str, since_revision: u64) -> Result<Value, String> {
    let session_id = cstring(session_id)?;
    take_json(unsafe { mahi_wv_capture(session_id.as_ptr(), since_revision) })
}

pub fn wait_for_change(
    session_id: &str,
    after_revision: u64,
    timeout_ms: u32,
) -> Result<Value, String> {
    let session_id = cstring(session_id)?;
    take_json(unsafe { mahi_wv_wait_for_change(session_id.as_ptr(), after_revision, timeout_ms) })
}

pub fn stop(session_id: &str) -> Result<Value, String> {
    let session_id = cstring(session_id)?;
    take_json(unsafe { mahi_wv_stop(session_id.as_ptr()) })
}

pub fn stop_all() -> Result<Value, String> {
    take_json(unsafe { mahi_wv_stop_all() })
}

pub fn present_picker(session_id: &str, display_mode: bool) -> Result<Value, String> {
    let session_id = cstring(session_id)?;
    take_json(unsafe { mahi_wv_present_picker(session_id.as_ptr(), display_mode as c_int) })
}

pub fn picker_result(session_id: &str) -> Result<Value, String> {
    let session_id = cstring(session_id)?;
    take_json(unsafe { mahi_wv_picker_result(session_id.as_ptr()) })
}
