use serde_json::{json, Value};

fn unsupported() -> Result<Value, String> {
    Ok(
        json!({"status": "unsupported_platform", "error": "Window Vision is currently available on macOS only"}),
    )
}

pub fn supported() -> bool {
    false
}
pub fn picker_supported() -> bool {
    false
}
pub fn permission_granted() -> bool {
    false
}
pub fn request_permission() -> bool {
    false
}
pub fn list_windows() -> Result<Value, String> {
    unsupported()
}
pub fn list_sessions() -> Result<Value, String> {
    unsupported()
}
pub fn start_window(_: &str, _: u32, _: bool, _: f64, _: f64) -> Result<Value, String> {
    unsupported()
}
pub fn start_group(_: &str, _: u32, _: &[u32], _: bool, _: f64, _: f64) -> Result<Value, String> {
    unsupported()
}
pub fn capture(_: &str, _: u64) -> Result<Value, String> {
    unsupported()
}
pub fn wait_for_change(_: &str, _: u64, _: u32) -> Result<Value, String> {
    unsupported()
}
pub fn stop(_: &str) -> Result<Value, String> {
    unsupported()
}
pub fn stop_all() -> Result<Value, String> {
    unsupported()
}
pub fn present_picker(_: &str, _: bool) -> Result<Value, String> {
    unsupported()
}
pub fn picker_result(_: &str) -> Result<Value, String> {
    unsupported()
}
