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
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewBuilder, WebviewUrl,
};

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
pub fn browser_reposition(
    app: AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let wv = app
        .get_webview(&label_for(&tab_id))
        .ok_or("browser not open")?;
    wv.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    wv.set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    // reportRect() (frontend) calls this whenever a tab becomes active again
    // after being hidden — show() here is what actually brings it back.
    wv.show().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, tab_id: String, url: String) -> Result<(), String> {
    let parsed = parse_url(&url)?;
    let wv = app
        .get_webview(&label_for(&tab_id))
        .ok_or("browser not open")?;
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
pub fn browser_close(
    app: AppHandle,
    state: tauri::State<PickerManager>,
    tab_id: String,
) -> Result<(), String> {
    stop_picker_task(&state, &tab_id);
    if let Some(wv) = app.get_webview(&label_for(&tab_id)) {
        wv.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn eval_json(
    app: &AppHandle,
    tab_id: &str,
    script: String,
) -> Result<serde_json::Value, String> {
    let wv = app
        .get_webview(&label_for(tab_id))
        .ok_or("browser not open")?;
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    wv.eval_with_callback(&script, move |result| {
        if let Some(tx) = tx.lock().unwrap().take() {
            let _ = tx.send(result);
        }
    })
    .map_err(|e| e.to_string())?;
    let raw = tokio::time::timeout(Duration::from_secs(8), rx)
        .await
        .map_err(|_| "browser script timed out".to_string())?
        .map_err(|_| "browser script callback closed".to_string())?;
    serde_json::from_str(&raw).map_err(|e| format!("invalid browser script result: {e}"))
}

#[tauri::command]
pub async fn browser_dom_snapshot(
    app: AppHandle,
    tab_id: String,
) -> Result<serde_json::Value, String> {
    let script = r##"(function(){
      function path(el){
        if (!el || el.nodeType !== 1) return "";
        if (el.id) return el.tagName.toLowerCase() + "#" + CSS.escape(el.id);
        const out=[]; let cur=el;
        while(cur && cur.nodeType===1 && out.length<6){
          let p=cur.tagName.toLowerCase();
          const parent=cur.parentElement;
          if(parent){ const same=[...parent.children].filter(x=>x.tagName===cur.tagName); if(same.length>1)p+=`:nth-of-type(${same.indexOf(cur)+1})`; }
          out.unshift(p); cur=parent;
        }
        return out.join(" > ");
      }
      const visible=el=>{ const r=el.getBoundingClientRect(),s=getComputedStyle(el); return r.width>0&&r.height>0&&s.visibility!=="hidden"&&s.display!=="none"; };
      const nodes=[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"],[tabindex]')]
        .filter(visible).slice(0,250).map(el=>{
          const type=el.getAttribute('type')||'';
          return { tag:el.tagName.toLowerCase(), selector:path(el),
            text:String(el.innerText||el.getAttribute('aria-label')||el.getAttribute('placeholder')||'').trim().slice(0,180),
            type, role:el.getAttribute('role')||'', disabled:!!el.disabled,
            checked:typeof el.checked==='boolean'?el.checked:undefined };
        });
      return { url:location.href, title:document.title, text:String(document.body?.innerText||'').trim().slice(0,12000), elements:nodes };
    })()"##.to_string();
    eval_json(&app, &tab_id, script).await
}

fn js_arg(value: &str) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn browser_click(
    app: AppHandle,
    tab_id: String,
    selector: String,
) -> Result<serde_json::Value, String> {
    let selector = js_arg(&selector)?;
    let script = format!(
        r##"(function(){{
      const el=document.querySelector({selector}); if(!el)return {{ok:false,error:'element not found'}};
      const target=el.closest('button,input,a,[role="button"]')||el;
      const label=String(target.innerText||target.value||target.getAttribute('aria-label')||'').trim();
      const type=String(target.getAttribute('type')||'').toLowerCase();
      if(type==='submit'||type==='image'||(target.tagName==='BUTTON'&&target.closest('form')&&type!=='button')||/\b(delete|remove|purchase|buy|checkout|pay|send|post|confirm|sign in|log in|create account)\b/i.test(label))
        return {{ok:false,blocked:true,error:'sensitive action requires browser_submit',label}};
      target.scrollIntoView({{block:'center',inline:'center'}}); target.focus(); const r=target.getBoundingClientRect(); target.click();
      const dot=document.createElement('div'); Object.assign(dot.style,{{position:'fixed',zIndex:'2147483647',width:'18px',height:'18px',border:'2px solid #00ebd4',borderRadius:'50%',pointerEvents:'none',left:(r.left+r.width/2-9)+'px',top:(r.top+r.height/2-9)+'px',boxShadow:'0 0 14px #00ebd4'}}); document.documentElement.appendChild(dot); setTimeout(()=>dot.remove(),700);
      return {{ok:true,label,url:location.href}};
    }})()"##
    );
    eval_json(&app, &tab_id, script).await
}

#[tauri::command]
pub async fn browser_type(
    app: AppHandle,
    tab_id: String,
    selector: String,
    text: String,
    clear: bool,
) -> Result<serde_json::Value, String> {
    let selector = js_arg(&selector)?;
    let text = js_arg(&text)?;
    let script = format!(
        r##"(function(){{
      const el=document.querySelector({selector}); if(!el)return {{ok:false,error:'element not found'}};
      const type=String(el.getAttribute('type')||'').toLowerCase(), ac=String(el.getAttribute('autocomplete')||'').toLowerCase();
      if(type==='password'||type==='hidden'||type==='file'||ac.startsWith('cc-'))return {{ok:false,blocked:true,error:'sensitive field is not available to automatic typing'}};
      el.scrollIntoView({{block:'center'}}); el.focus();
      const next={clear}?{text}:String(el.value||'')+{text};
      if('value' in el){{ const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set; setter?setter.call(el,next):(el.value=next); }} else el.textContent=next;
      el.dispatchEvent(new InputEvent('input',{{bubbles:true,inputType:'insertText',data:{text}}})); el.dispatchEvent(new Event('change',{{bubbles:true}}));
      el.style.outline='2px solid #00ebd4'; setTimeout(()=>{{el.style.outline='';}},700);
      return {{ok:true,valueLength:next.length}};
    }})()"##
    );
    eval_json(&app, &tab_id, script).await
}

#[tauri::command]
pub async fn browser_submit(
    app: AppHandle,
    tab_id: String,
    selector: String,
) -> Result<serde_json::Value, String> {
    let selector = js_arg(&selector)?;
    let script = format!(
        r##"(function(){{
      const el=document.querySelector({selector}); if(!el)return {{ok:false,error:'element not found'}};
      el.scrollIntoView({{block:'center'}}); el.focus();
      const form=el.closest('form'); if(form) form.requestSubmit(); else el.click();
      return {{ok:true,url:location.href}};
    }})()"##
    );
    eval_json(&app, &tab_id, script).await
}

#[tauri::command]
pub async fn browser_scroll(
    app: AppHandle,
    tab_id: String,
    selector: Option<String>,
    x: f64,
    y: f64,
) -> Result<serde_json::Value, String> {
    let selector = js_arg(selector.as_deref().unwrap_or(""))?;
    let script = format!(
        r##"(function(){{ const el={selector}?document.querySelector({selector}):window; if(!el)return {{ok:false,error:'element not found'}}; el.scrollBy({{left:{x},top:{y},behavior:'smooth'}}); return {{ok:true,scrollX:window.scrollX,scrollY:window.scrollY}}; }})()"##
    );
    eval_json(&app, &tab_id, script).await
}

#[tauri::command]
pub async fn browser_key(
    app: AppHandle,
    tab_id: String,
    selector: Option<String>,
    key: String,
) -> Result<serde_json::Value, String> {
    const ALLOWED: &[&str] = &[
        "Tab",
        "Escape",
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "PageUp",
        "PageDown",
        "Home",
        "End",
    ];
    if !ALLOWED.contains(&key.as_str()) {
        return Err("key not allowed; use browser_submit for Enter/submission".into());
    }
    let selector = js_arg(selector.as_deref().unwrap_or(""))?;
    let key = js_arg(&key)?;
    let script = format!(
        r##"(function(){{ let el={selector}?document.querySelector({selector}):document.activeElement; if(!el)return {{ok:false,error:'element not found'}}; el.focus(); if({key}==='Tab'){{ const items=[...document.querySelectorAll('a,button,input,textarea,select,[tabindex],[contenteditable="true"]')].filter(x=>!x.disabled&&x.tabIndex>=0&&x.getBoundingClientRect().width>0); const i=items.indexOf(el); el=items[(i+1+items.length)%items.length]||el; el.focus(); }} else for(const type of ['keydown','keyup'])el.dispatchEvent(new KeyboardEvent(type,{{key:{key},bubbles:true}})); return {{ok:true,key:{key}}}; }})()"##
    );
    eval_json(&app, &tab_id, script).await
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
pub fn browser_start_picker(
    app: AppHandle,
    state: tauri::State<PickerManager>,
    tab_id: String,
) -> Result<(), String> {
    let wv = app
        .get_webview(&label_for(&tab_id))
        .ok_or("browser not open")?;
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
pub fn browser_stop_picker(
    app: AppHandle,
    state: tauri::State<PickerManager>,
    tab_id: String,
) -> Result<(), String> {
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
    let wv = app
        .get_webview(&label_for(&tab_id))
        .ok_or("browser not open")?;
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
