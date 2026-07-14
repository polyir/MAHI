// Local AI model registry + download/status/delete. Everything lives under
// the app's own data directory (never inside a user's project workspace,
// and never through crate::resolve()'s workspace sandboxing — that's for
// project files only). The registry is a fixed const, not user-editable or
// fetched from anywhere at runtime: fully offline/local, matching the
// no-cloud-fallback policy in docs/local-ai-stack.config.json.
use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Asr,
    Tts,
    Llm,
}

pub struct ModelSpec {
    pub id: &'static str,
    pub kind: ModelKind,
    pub label: &'static str,
    // ISO 639-1 code for TTS voices (which language this voice speaks);
    // empty for ASR models (Whisper is multilingual/auto-detecting).
    pub lang: &'static str,
    pub url: &'static str,
    // None = not yet verified against a known-good hash — download still
    // works (HTTPS itself guarantees transport integrity), it just skips
    // the extra content-integrity check. Filled in for entries this session
    // actually verified end-to-end.
    pub sha256: Option<&'static str>,
    pub size_bytes: u64,
    // true: `url` is a .tar.bz2 that must be extracted (sherpa-onnx's own
    // Piper voice packages ship as model + tokens.txt + espeak-ng-data/
    // bundled together this way).
    pub archive: bool,
}

pub const MODEL_REGISTRY: &[ModelSpec] = &[
    ModelSpec {
        id: "whisper-tiny-en",
        kind: ModelKind::Asr,
        label: "Whisper Tiny (English, fast — good for testing)",
        lang: "en",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
        sha256: Some("921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1"),
        size_bytes: 77_704_715,
        archive: false,
    },
    ModelSpec {
        id: "whisper-large-v3-turbo-q5",
        kind: ModelKind::Asr,
        label: "Whisper Large v3 Turbo (multilingual, recommended)",
        lang: "",
        url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin",
        sha256: Some("394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2"),
        size_bytes: 574_041_195,
        archive: false,
    },
    ModelSpec {
        id: "tts-en-lessac",
        kind: ModelKind::Tts,
        label: "English (Lessac)",
        lang: "en",
        url: "https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-lessac-medium.tar.bz2",
        sha256: Some("9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334"),
        size_bytes: 67_230_653,
        archive: true,
    },
    ModelSpec {
        id: "llama-server",
        kind: ModelKind::Llm,
        label: "Local LLM runtime (llama.cpp)",
        lang: "",
        url: "https://github.com/ggml-org/llama.cpp/releases/download/b9877/llama-b9877-bin-macos-arm64.tar.gz",
        sha256: Some("e64643367efefcf48c3f58125d8c5cae7bbac8805653075152df1bedfd7ea55d"),
        size_bytes: 11_141_346,
        archive: true,
    },
    ModelSpec {
        id: "qwen3-1.7b",
        kind: ModelKind::Llm,
        label: "Qwen3 1.7B (utility tasks — titles, cleanup, summaries)",
        lang: "",
        url: "https://huggingface.co/bartowski/Qwen_Qwen3-1.7B-GGUF/resolve/main/Qwen_Qwen3-1.7B-Q4_K_M.gguf",
        sha256: Some("72c5c3cb38fa32d5256e2fe30d03e7a64c6c79e668ad84057e3bd66e250b24fb"),
        size_bytes: 1_282_439_584,
        archive: false,
    },
    ModelSpec {
        id: "qwen3-4b",
        kind: ModelKind::Llm,
        label: "Qwen3 4B (prompt improvement / local chat)",
        lang: "",
        url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
        sha256: Some("7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5"),
        size_bytes: 2_497_280_256,
        archive: false,
    },
];

fn models_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn spec_by_id(id: &str) -> Result<&'static ModelSpec, String> {
    MODEL_REGISTRY
        .iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("unknown model id: {id}"))
}

/// Where a spec's installed content lives: a single file for plain downloads,
/// or a directory (named after the id) for extracted archives.
fn dest_path(root: &Path, spec: &ModelSpec) -> PathBuf {
    if spec.archive {
        root.join(spec.id)
    } else {
        root.join(format!("{}.bin", spec.id))
    }
}

#[derive(Default)]
pub struct ModelManager {
    // ids currently downloading, so a duplicate concurrent request for the
    // same model is rejected instead of racing two writers on one temp file.
    in_flight: Mutex<HashSet<String>>,
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
}

#[tauri::command]
pub async fn model_download(
    app: AppHandle,
    state: tauri::State<'_, ModelManager>,
    model_id: String,
) -> Result<(), String> {
    let spec = spec_by_id(&model_id)?;
    {
        let mut set = state.in_flight.lock().unwrap();
        if !set.insert(model_id.clone()) {
            return Err("this model is already downloading".into());
        }
    }
    let result = download_inner(&app, spec).await;
    state.in_flight.lock().unwrap().remove(&model_id);
    result
}

async fn download_inner(app: &AppHandle, spec: &'static ModelSpec) -> Result<(), String> {
    let root = models_root(app)?;
    let final_path = dest_path(&root, spec);
    let tmp_path = root.join(format!("{}.part", spec.id));

    let resp = reqwest::get(spec.url).await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(spec.size_bytes);

    let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    let mut stream = resp.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;
        if last_emit.elapsed().as_millis() > 200 {
            let _ = app.emit(
                &format!("model-download://progress/{}", spec.id),
                DownloadProgress { downloaded, total },
            );
            last_emit = std::time::Instant::now();
        }
    }
    let _ = app.emit(
        &format!("model-download://progress/{}", spec.id),
        DownloadProgress { downloaded, total },
    );
    drop(file);

    if let Some(expected) = spec.sha256 {
        let got = format!("{:x}", hasher.finalize());
        if got != expected {
            let _ = fs::remove_file(&tmp_path);
            return Err(format!(
                "checksum mismatch — download may be corrupt (expected {expected}, got {got})"
            ));
        }
    }

    if spec.archive {
        let _ = fs::remove_dir_all(&final_path);
        fs::create_dir_all(&final_path).map_err(|e| e.to_string())?;
        // Shelling out to the system `tar` (bsdtar on macOS auto-detects the
        // compression format from content, so plain "xf" handles both the
        // .tar.bz2 TTS voice packages and the .tar.gz llama.cpp runtime)
        // avoids adding a bzip2/gzip decoding dependency — same "require a
        // system tool" pattern already used for ffmpeg.
        let status = Command::new("tar")
            .arg("xf")
            .arg(&tmp_path)
            .arg("-C")
            .arg(&final_path)
            .status()
            .map_err(|e| format!("failed to run tar: {e}"))?;
        let _ = fs::remove_file(&tmp_path);
        if !status.success() {
            let _ = fs::remove_dir_all(&final_path);
            return Err("failed to extract downloaded archive".into());
        }
    } else {
        // Atomic swap: a half-downloaded file is never visible as "installed".
        fs::rename(&tmp_path, &final_path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct ModelStatus {
    pub id: String,
    pub kind: ModelKind,
    pub label: String,
    pub lang: String,
    pub size_bytes: u64,
    pub installed: bool,
    pub size_on_disk: u64,
}

fn dir_size(path: &Path) -> u64 {
    if path.is_file() {
        return fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    let mut total = 0u64;
    if let Ok(rd) = fs::read_dir(path) {
        for entry in rd.flatten() {
            let p = entry.path();
            total += if p.is_dir() {
                dir_size(&p)
            } else {
                fs::metadata(&p).map(|m| m.len()).unwrap_or(0)
            };
        }
    }
    total
}

/// The truth is always the disk, never a cached flag — a manually deleted
/// file (or one removed outside the app) is reflected immediately.
#[tauri::command]
pub fn model_list_status(app: AppHandle) -> Result<Vec<ModelStatus>, String> {
    let root = models_root(&app)?;
    Ok(MODEL_REGISTRY
        .iter()
        .map(|spec| {
            let path = dest_path(&root, spec);
            let installed = path.exists();
            let size_on_disk = if installed { dir_size(&path) } else { 0 };
            ModelStatus {
                id: spec.id.to_string(),
                kind: spec.kind,
                label: spec.label.to_string(),
                lang: spec.lang.to_string(),
                size_bytes: spec.size_bytes,
                installed,
                size_on_disk,
            }
        })
        .collect())
}

#[tauri::command]
pub fn model_delete(app: AppHandle, model_id: String) -> Result<(), String> {
    let spec = spec_by_id(&model_id)?;
    let root = models_root(&app)?;
    let path = dest_path(&root, spec);
    if path.is_dir() {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    } else if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Resolves an installed model's on-disk path for asr.rs/tts.rs. Errors with
/// a clear message (not a panic) if the model was never downloaded.
pub fn installed_path(app: &AppHandle, model_id: &str) -> Result<PathBuf, String> {
    let spec = spec_by_id(model_id)?;
    let root = models_root(app)?;
    let path = dest_path(&root, spec);
    if !path.exists() {
        return Err(format!(
            "model '{model_id}' is not installed — open Settings → Local AI Models to download it"
        ));
    }
    Ok(path)
}
