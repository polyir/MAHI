// Embedded, agent-controllable browser tabs: each tab is a real child
// webview positioned inside the main window (not a separate OS window), so
// the user can see a live page and the agent can read/screenshot/act on the
// same session. Multiple tabs are supported by giving each its own labeled
// webview; only the active tab's webview is shown, the rest stay hidden
// (not destroyed) so switching back preserves their state.
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

fn label_for(tab_id: &str) -> String {
    format!("agent-browser-{tab_id}")
}

fn parse_url(url: &str) -> Result<tauri::Url, String> {
    url.parse().map_err(|e| format!("invalid url: {e}"))
}

#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    let main = app.get_window("main").ok_or("no main window")?;
    let label = label_for(&tab_id);

    if let Some(wv) = app.get_webview(&label) {
        wv.set_position(LogicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(LogicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed));
    main.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(width, height),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_reposition(app: AppHandle, tab_id: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("browser not open")?;
    wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(width, height)).map_err(|e| e.to_string())?;
    // reportRect() (frontend) calls this whenever a tab becomes active again
    // after being hidden — show() here is what actually brings it back.
    wv.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("browser not open")?;
    wv.navigate(parsed).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&tab_id)) {
        wv.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn browser_close(app: AppHandle, tab_id: String) -> Result<(), String> {
    if let Some(wv) = app.get_webview(&label_for(&tab_id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
