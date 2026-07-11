// Embedded, agent-controllable browser tabs: each tab is a real child
// webview positioned inside the main window (not a separate OS window), so
// the user can see a live page and the agent can read/screenshot/act on the
// same session. Multiple tabs are supported by giving each its own labeled
// webview; only the active tab's webview is shown, the rest stay hidden
// (not destroyed) so switching back preserves their state.
// Physical (not Logical) position/size: on a Retina display, Tauri's
// add_child/set_position/set_size for child webviews did not apply the
// window's scale-factor conversion that LogicalPosition/LogicalSize expect
// (confirmed empirically — a webview requested at a given logical height
// rendered at roughly half that on a 2x display), so the frontend now does
// that multiplication itself (see BrowserTabView.tsx) and sends raw
// physical pixels here.
use base64::Engine;
use std::collections::HashMap;
use std::io::Cursor;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewBuilder, WebviewUrl};

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
        wv.set_position(PhysicalPosition::new(x, y))
            .map_err(|e| e.to_string())?;
        wv.set_size(PhysicalSize::new(width, height))
            .map_err(|e| e.to_string())?;
        wv.show().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed));
    main.add_child(
        builder,
        PhysicalPosition::new(x, y),
        PhysicalSize::new(width, height),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_reposition(app: AppHandle, tab_id: String, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("browser not open")?;
    wv.set_position(PhysicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    wv.set_size(PhysicalSize::new(width, height)).map_err(|e| e.to_string())?;
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
pub fn browser_close(app: AppHandle, state: tauri::State<PickerManager>, tab_id: String) -> Result<(), String> {
    stop_picker_task(&state, &tab_id);
    if let Some(wv) = app.get_webview(&label_for(&tab_id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

// "Inspect element" mode: hover-highlights whatever's under the cursor and,
// on click, captures a lightweight description of that element so the user
// can attach a comment to it for the agent — a quicker way to point at a
// specific thing on the page than describing it in words.
//
// Getting data back OUT of a webview is the interesting part here. This is
// an external, potentially untrusted page (any URL the user navigates to),
// so exposing Tauri's normal IPC/invoke bridge to its own script context
// would let that page's own JS call arbitrary commands — not acceptable.
// Instead: eval() injects a plain listener with no access to Tauri at all,
// it just stashes the last click on `window.__mahiPending`; a polling task
// on the Rust side reads that back via eval_with_callback (a one-shot
// "evaluate this expression and give me the JSON result" primitive, not a
// live channel) every few hundred ms and clears it. The page never touches
// anything but its own `window` object.
#[derive(Default)]
pub struct PickerManager {
    tasks: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

fn stop_picker_task(state: &tauri::State<PickerManager>, tab_id: &str) {
    if let Some(handle) = state.tasks.lock().unwrap().remove(tab_id) {
        handle.abort();
    }
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PickedElement {
    tab_id: String,
    tag: String,
    text: String,
    selector: String,
    // The clicked element's own getBoundingClientRect(), in CSS px relative
    // to the page's viewport (not our app window) — lets the frontend ask
    // browser_capture_element_screenshot for a cropped screenshot of just
    // this element, without the picker script itself touching pixels.
    rect_x: f64,
    rect_y: f64,
    rect_w: f64,
    rect_h: f64,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawPicked {
    tag: String,
    text: String,
    selector: String,
    rect_x: f64,
    rect_y: f64,
    rect_w: f64,
    rect_h: f64,
}

// `true` re-attach guard lets browser_start_picker be called again on the
// same page (e.g. after a re-navigation re-runs init scripts) without
// double-registering listeners.
const PICKER_INJECT_SCRIPT: &str = r##"(function() {
  if (window.__mahiPickerActive) return;
  window.__mahiPickerActive = true;
  window.__mahiPending = null;
  let lastEl = null;
  function clearHighlight() {
    if (lastEl) { lastEl.style.outline = lastEl.__mahiPrevOutline || ""; lastEl = null; }
  }
  function onOver(e) {
    clearHighlight();
    const el = e.target;
    el.__mahiPrevOutline = el.style.outline;
    el.style.outline = "2px solid #6d5efc";
    lastEl = el;
  }
  function cssPath(start) {
    let el = start;
    const parts = [];
    while (el && el.nodeType === 1 && parts.length < 5) {
      let sel = el.tagName.toLowerCase();
      if (el.id) { parts.unshift(sel + "#" + el.id); break; }
      if (typeof el.className === "string" && el.className.trim()) {
        sel += "." + el.className.trim().split(/\s+/).slice(0, 2).join(".");
      }
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName);
        if (siblings.length > 1) sel += ":nth-of-type(" + (siblings.indexOf(el) + 1) + ")";
      }
      parts.unshift(sel);
      el = parent;
    }
    return parts.join(" > ");
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target;
    const r = el.getBoundingClientRect();
    window.__mahiPending = {
      tag: el.tagName.toLowerCase(),
      text: ((el.innerText || el.value || "") + "").trim().slice(0, 120),
      selector: cssPath(el),
      rectX: r.x,
      rectY: r.y,
      rectW: r.width,
      rectH: r.height
    };
  }
  document.addEventListener("mouseover", onOver, true);
  document.addEventListener("click", onClick, true);
  window.__mahiPickerCleanup = function() {
    document.removeEventListener("mouseover", onOver, true);
    document.removeEventListener("click", onClick, true);
    clearHighlight();
    window.__mahiPickerActive = false;
  };
})();"##;

const PICKER_STOP_SCRIPT: &str = "if (window.__mahiPickerCleanup) window.__mahiPickerCleanup();";

const PICKER_POLL_SCRIPT: &str =
    "(function(){ const p = window.__mahiPending; window.__mahiPending = null; return p; })()";

#[tauri::command]
pub fn browser_start_picker(app: AppHandle, state: tauri::State<PickerManager>, tab_id: String) -> Result<(), String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("browser not open")?;
    wv.eval(PICKER_INJECT_SCRIPT).map_err(|e| e.to_string())?;

    stop_picker_task(&state, &tab_id);

    let app_handle = app.clone();
    let tid = tab_id.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(400));
        loop {
            interval.tick().await;
            let Some(wv) = app_handle.get_webview(&label_for(&tid)) else {
                break;
            };
            let app_for_cb = app_handle.clone();
            let tid_for_cb = tid.clone();
            let dispatched = wv.eval_with_callback(PICKER_POLL_SCRIPT, move |result: String| {
                if let Ok(Some(picked)) = serde_json::from_str::<Option<RawPicked>>(&result) {
                    let _ = app_for_cb.emit(
                        "browser-element-picked",
                        PickedElement {
                            tab_id: tid_for_cb.clone(),
                            tag: picked.tag,
                            text: picked.text,
                            selector: picked.selector,
                            rect_x: picked.rect_x,
                            rect_y: picked.rect_y,
                            rect_w: picked.rect_w,
                            rect_h: picked.rect_h,
                        },
                    );
                }
            });
            if dispatched.is_err() {
                break;
            }
        }
    });
    state.tasks.lock().unwrap().insert(tab_id, handle);
    Ok(())
}

#[tauri::command]
pub fn browser_stop_picker(app: AppHandle, state: tauri::State<PickerManager>, tab_id: String) -> Result<(), String> {
    stop_picker_task(&state, &tab_id);
    if let Some(wv) = app.get_webview(&label_for(&tab_id)) {
        let _ = wv.eval(PICKER_STOP_SCRIPT);
    }
    Ok(())
}

// Crops a screenshot down to just the picked element, so the user can attach
// a visual (not just the tag/selector reference) for models that support
// vision. Same OS-level window capture as window_screenshot (see
// screenshot.rs) rather than a <canvas> read of the page — a canvas read
// would be tainted for any cross-origin content and can't see into an
// iframe anyway. rect_x/y/w/h are the element's own getBoundingClientRect()
// (CSS px, already scaled to physical pixels by the frontend to match
// wv.position()'s units) relative to the *page's* viewport; this adds the
// webview's own position within the app window, plus the window's frame
// thickness (inner_position - outer_position, i.e. the title bar height),
// to land on a crop rect within the full-window capture.
#[tauri::command]
pub fn browser_capture_element_screenshot(
    app: AppHandle,
    tab_id: String,
    rect_x: f64,
    rect_y: f64,
    rect_w: f64,
    rect_h: f64,
) -> Result<String, String> {
    let wv = app.get_webview(&label_for(&tab_id)).ok_or("browser not open")?;
    let wv_pos = wv.position().map_err(|e| e.to_string())?;
    let main = app.get_window("main").ok_or("no main window")?;
    let inner = main.inner_position().map_err(|e| e.to_string())?;
    let outer = main.outer_position().map_err(|e| e.to_string())?;

    let abs_x = wv_pos.x as f64 + rect_x + (inner.x - outer.x) as f64;
    let abs_y = wv_pos.y as f64 + rect_y + (inner.y - outer.y) as f64;

    let windows = xcap::Window::all().map_err(|e| e.to_string())?;
    let win = windows
        .into_iter()
        .find(|w| w.title().map(|t| t == "MAHI").unwrap_or(false))
        .ok_or("MAHI window not found")?;
    let image = win.capture_image().map_err(|e| e.to_string())?;

    let img_w = image.width() as f64;
    let img_h = image.height() as f64;
    let crop_x = abs_x.clamp(0.0, img_w);
    let crop_y = abs_y.clamp(0.0, img_h);
    let crop_w = rect_w.min(img_w - crop_x).max(0.0);
    let crop_h = rect_h.min(img_h - crop_y).max(0.0);
    if crop_w < 1.0 || crop_h < 1.0 {
        return Err("element is off-screen".into());
    }

    let cropped = image::imageops::crop_imm(
        &image,
        crop_x as u32,
        crop_y as u32,
        crop_w as u32,
        crop_h as u32,
    )
    .to_image();
    let mut buf = Vec::new();
    cropped
        .write_to(&mut Cursor::new(&mut buf), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}
