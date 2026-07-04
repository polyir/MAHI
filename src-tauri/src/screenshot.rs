// Backs the agent's browser_screenshot tool. An embedded browser tab is a
// plain HTML iframe (see BrowserTabView.tsx), and cross-origin iframe pixels
// can't be read via <canvas> (tainted canvas) — the only way to actually see
// what's rendered is an OS-level window capture. We deliberately capture the
// WHOLE window rather than cropping to the browser tab's rect: translating
// between logical/physical coordinates and window frame offsets is fiddly
// and platform-specific (this app already hit exactly that class of bug with
// the old native-webview positioning code), so a full-window screenshot
// trades a bit of extra surrounding UI for something that's simply always
// correct.
use base64::Engine;
use std::io::Cursor;
use xcap::Window;

#[tauri::command]
pub fn window_screenshot() -> Result<String, String> {
    let windows = Window::all().map_err(|e| e.to_string())?;
    let win = windows
        .into_iter()
        .find(|w| w.title().map(|t| t == "MAHI").unwrap_or(false))
        .ok_or("MAHI window not found")?;
    let image = win.capture_image().map_err(|e| e.to_string())?;
    let mut buf = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}
