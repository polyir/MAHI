// Local text-to-speech via sherpa-onnx (through the sherpa-rs bindings).
// Uses sherpa-onnx's own Piper-voice packaging (model .onnx + tokens.txt +
// espeak-ng-data/, all extracted from one archive by models.rs) rather than
// piper-rs directly — see the plan notes: piper-rs's own espeak-ng
// dependency crashed both at build time and at runtime on this machine,
// while sherpa-rs's bundled espeak-ng integration works cleanly.
use serde::Serialize;
use sherpa_rs::tts::{VitsTts, VitsTtsConfig};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct TtsManager {
    loaded: Mutex<Option<(String, VitsTts)>>,
}

fn find_onnx(dir: &Path) -> Result<PathBuf, String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.extension().map(|e| e == "onnx").unwrap_or(false) {
            return Ok(path);
        }
    }
    Err("no .onnx model file found in the installed voice directory".into())
}

#[derive(Serialize)]
pub struct SpeechResult {
    pub path: String,
}

// Same fix as transcribe_media in asr.rs: voice model loading and the
// actual sherpa-onnx synthesis are CPU-bound and used to run synchronously
// on the thread that also services the window's event loop, freezing the
// whole app for the duration. spawn_blocking moves it to Tokio's blocking
// thread pool instead.
#[tauri::command]
pub async fn synthesize_speech(
    app: AppHandle,
    workspace: String,
    text: String,
    voice_id: String,
    out_path: String,
) -> Result<SpeechResult, String> {
    tokio::task::spawn_blocking(move || {
        let voice_dir = crate::models::installed_path(&app, &voice_id)?;
        let onnx = find_onnx(&voice_dir)?;
        let tokens = voice_dir.join("tokens.txt");
        let data_dir = voice_dir.join("espeak-ng-data");

        let state = app.state::<TtsManager>();
        let mut guard = state.loaded.lock().unwrap();
        let needs_load = !matches!(&*guard, Some((id, _)) if id == &voice_id);
        if needs_load {
            let config = VitsTtsConfig {
                model: onnx.to_string_lossy().to_string(),
                tokens: tokens.to_string_lossy().to_string(),
                data_dir: data_dir.to_string_lossy().to_string(),
                lexicon: "".into(),
                length_scale: 1.0,
                ..Default::default()
            };
            *guard = Some((voice_id.clone(), VitsTts::new(config)));
        }
        let (_, tts) = guard.as_mut().unwrap();
        let audio = tts
            .create(&text, 0, 1.0)
            .map_err(|e| format!("speech synthesis failed: {e}"))?;

        let dest = crate::resolve(&workspace, &out_path)?;
        crate::ensure_not_workspace_root(&workspace, &dest)?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        sherpa_rs::write_audio_file(&dest.to_string_lossy(), &audio.samples, audio.sample_rate)
            .map_err(|e| e.to_string())?;
        Ok(SpeechResult { path: out_path })
    })
    .await
    .map_err(|e| format!("speech synthesis task panicked: {e}"))?
}
