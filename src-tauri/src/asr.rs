// Local speech-to-text via whisper.cpp (through the whisper-rs bindings).
// The selected model loads once and stays cached across calls in the same
// session (see AsrManager) — the JSON spec's own "lazy loading" philosophy,
// applied here as "load on first use, then reuse."
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize)]
pub struct Segment {
    pub start_ms: i64,
    pub end_ms: i64,
    pub text: String,
}

#[derive(Serialize)]
pub struct TranscriptionResult {
    pub text: String,
    pub segments: Vec<Segment>,
    // Only set when `language` was None (auto-detect) — the actual language
    // whisper.cpp settled on, as an ISO-639-1-ish code (e.g. "en", "fa"),
    // same convention as this app's own UI language codes. Callers use this
    // instead of assuming the UI's configured language, since it's what
    // caused the "English dictation transcribed as Persian" bug: forcing
    // whichever language the interface happened to be set to, rather than
    // asking whisper.cpp to actually detect what was spoken.
    pub detected_language: Option<String>,
}

#[derive(Default)]
pub struct AsrManager {
    loaded: Mutex<Option<(String, WhisperContext)>>,
}

/// whisper.cpp requires 16kHz mono PCM regardless of the source format, so
/// every input (audio or video) is normalized through ffmpeg unconditionally
/// rather than branching on "is this already the right format." Shelling out
/// to a system-installed ffmpeg (not a bundled static binary) avoids the
/// GPL-redistribution complications of bundling a `--enable-gpl` ffmpeg build.
/// GUI-launched macOS apps don't inherit the user's shell PATH (~/.zshrc,
/// ~/.zprofile etc. never get sourced — Finder/Dock launches start from a
/// minimal default PATH), so a plain `Command::new("ffmpeg")` fails to find
/// Homebrew's ffmpeg even though `ffmpeg -version` works fine from a
/// terminal. Check the well-known Homebrew install locations first, then
/// fall back to asking a real login shell (`bash -lc`) to resolve it —
/// matches the existing `run_command`'s use of a login shell for the same
/// reason.
fn resolve_ffmpeg() -> Result<PathBuf, String> {
    for candidate in [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
    ] {
        if Path::new(candidate).exists() {
            return Ok(PathBuf::from(candidate));
        }
    }
    let output = Command::new("bash")
        .arg("-lc")
        .arg("command -v ffmpeg")
        .output()
        .map_err(|e| e.to_string())?;
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && !path.is_empty() {
        return Ok(PathBuf::from(path));
    }
    Err("ffmpeg is required for transcription — install it with: brew install ffmpeg".into())
}

fn extract_pcm16k_mono(input: &Path) -> Result<Vec<f32>, String> {
    let ffmpeg = resolve_ffmpeg()?;

    let tmp = std::env::temp_dir().join(format!(
        "mahi-asr-{}-{}.wav",
        std::process::id(),
        TMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let output = Command::new(&ffmpeg)
        .arg("-y")
        .arg("-i")
        .arg(input)
        .args(["-ar", "16000", "-ac", "1", "-f", "wav"])
        .arg(&tmp)
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!(
            "ffmpeg failed to extract audio: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let samples = (|| -> Result<Vec<f32>, String> {
        let mut reader = hound::WavReader::open(&tmp).map_err(|e| e.to_string())?;
        Ok(reader
            .samples::<i16>()
            .map(|s| s.unwrap_or(0) as f32 / 32768.0)
            .collect())
    })();
    let _ = std::fs::remove_file(&tmp);
    samples
}

// This used to be a plain synchronous command: ffmpeg extraction, whisper
// model loading, and the actual whisper.cpp inference (CPU-bound, can run
// for real seconds depending on audio length/model size) all ran directly
// on the same thread Tauri uses to service the window's event loop — the
// exact same "spinning beachball" class of bug as the old synchronous
// run_command (see lib.rs). Unlike that fix, this work is CPU-bound rather
// than I/O-bound, so switching to an async subprocess API wouldn't help;
// `spawn_blocking` moves it onto Tokio's dedicated blocking-thread pool
// instead, keeping the async runtime's own worker threads (and therefore
// the UI) free for the whole transcription.
#[tauri::command]
pub async fn transcribe_media(
    app: AppHandle,
    workspace: String,
    path: String,
    model_id: String,
    language: Option<String>,
) -> Result<TranscriptionResult, String> {
    let abs_path = crate::resolve(&workspace, &path)?;
    tokio::task::spawn_blocking(move || {
        let samples = extract_pcm16k_mono(&abs_path)?;

        let model_path = crate::models::installed_path(&app, &model_id)?;
        let model_path_str = model_path.to_string_lossy().to_string();

        let state = app.state::<AsrManager>();
        let mut guard = state.loaded.lock().unwrap();
        let needs_load = !matches!(&*guard, Some((id, _)) if id == &model_id);
        if needs_load {
            let ctx = WhisperContext::new_with_params(
                &model_path_str,
                WhisperContextParameters::default(),
            )
            .map_err(|e| format!("failed to load Whisper model: {e}"))?;
            *guard = Some((model_id.clone(), ctx));
        }
        let (_, ctx) = guard.as_ref().unwrap();
        let mut wstate = ctx.create_state().map_err(|e| e.to_string())?;

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        // `language: None` means "let whisper.cpp actually detect the spoken
        // language" — whisper-rs's own doc for set_language: "For
        // auto-detection, set this to either 'auto' or None". Previously the
        // caller always forced a specific language (whatever the UI was set
        // to), which isn't detection at all — it just told whisper.cpp to
        // transcribe as that language regardless of what was actually
        // spoken, producing garbled/wrong-script output when the two
        // disagreed (e.g. English audio forced through as Persian).
        params.set_language(language.as_deref());
        params.set_print_progress(false);
        params.set_print_special(false);
        params.set_print_realtime(false);

        wstate
            .full(params, &samples)
            .map_err(|e| format!("transcription failed: {e}"))?;

        let n = wstate.full_n_segments();
        let mut segments = Vec::with_capacity(n.max(0) as usize);
        let mut text = String::new();
        for i in 0..n {
            if let Some(seg) = wstate.get_segment(i) {
                let t = seg.to_str().unwrap_or("").to_string();
                // whisper.cpp timestamps are in centiseconds (10ms units).
                segments.push(Segment {
                    start_ms: seg.start_timestamp() * 10,
                    end_ms: seg.end_timestamp() * 10,
                    text: t.clone(),
                });
                text.push_str(&t);
            }
        }
        let detected_language = language.is_none().then(|| {
            let lang_id = wstate.full_lang_id_from_state();
            whisper_rs::get_lang_str(lang_id).map(|s| s.to_string())
        }).flatten();
        Ok(TranscriptionResult { text, segments, detected_language })
    })
    .await
    .map_err(|e| format!("transcription task panicked: {e}"))?
}
