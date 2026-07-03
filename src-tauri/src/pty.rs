use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

struct PtyInstance {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    #[allow(dead_code)]
    child: Box<dyn Child + Send + Sync>,
}

#[derive(Default)]
pub struct PtyManager {
    map: Mutex<HashMap<String, PtyInstance>>,
    counter: AtomicU64,
}

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<PtyManager>,
    workspace: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut cmd = CommandBuilder::new(shell);
    if !workspace.is_empty() {
        cmd.cwd(workspace);
    }
    cmd.env("TERM", "xterm-256color");

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = format!("pty-{}", state.counter.fetch_add(1, Ordering::SeqCst));

    let app_clone = app.clone();
    let id_clone = id.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                    let _ = app_clone.emit(&format!("pty://data/{id_clone}"), chunk);
                }
                Err(_) => break,
            }
        }
        let _ = app_clone.emit(&format!("pty://exit/{id_clone}"), ());
    });

    state.map.lock().unwrap().insert(
        id.clone(),
        PtyInstance {
            writer,
            master: pair.master,
            child,
        },
    );

    Ok(id)
}

#[tauri::command]
pub fn pty_write(state: State<PtyManager>, id: String, data: String) -> Result<(), String> {
    let mut map = state.map.lock().unwrap();
    if let Some(inst) = map.get_mut(&id) {
        inst.writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        inst.writer.flush().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: State<PtyManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.map.lock().unwrap();
    if let Some(inst) = map.get(&id) {
        inst.master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: State<PtyManager>, id: String) -> Result<(), String> {
    if let Some(mut inst) = state.map.lock().unwrap().remove(&id) {
        let _ = inst.child.kill();
    }
    Ok(())
}
