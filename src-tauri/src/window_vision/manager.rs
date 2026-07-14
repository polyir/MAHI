use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

const NEVER_ALLOWED: [&str; 4] = [
    "com.sinatorabi.vibe-coder",
    "com.apple.keychainaccess",
    "com.apple.Passwords",
    "com.apple.MobileSMS",
];

#[derive(Default)]
struct AccessState {
    loaded: bool,
    allowed_bundle_ids: BTreeSet<String>,
}

#[derive(Default)]
pub struct WindowVisionManager {
    access: Mutex<AccessState>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessFile {
    allowed_bundle_ids: BTreeSet<String>,
}

impl WindowVisionManager {
    fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(app
            .path()
            .app_config_dir()
            .map_err(|error| error.to_string())?
            .join("window-vision.json"))
    }

    fn ensure_loaded(&self, app: &AppHandle) -> Result<(), String> {
        let mut access = self
            .access
            .lock()
            .map_err(|_| "Window Vision access lock poisoned")?;
        if access.loaded {
            return Ok(());
        }
        let path = Self::config_path(app)?;
        if let Ok(text) = fs::read_to_string(path) {
            if let Ok(file) = serde_json::from_str::<AccessFile>(&text) {
                access.allowed_bundle_ids = file
                    .allowed_bundle_ids
                    .into_iter()
                    .filter(|bundle_id| !Self::never_allowed(bundle_id))
                    .collect();
            }
        }
        access.loaded = true;
        Ok(())
    }

    fn persist(
        &self,
        app: &AppHandle,
        allowed_bundle_ids: &BTreeSet<String>,
    ) -> Result<(), String> {
        let path = Self::config_path(app)?;
        let parent = path.parent().ok_or("invalid Window Vision config path")?;
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        let temporary = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(&AccessFile {
            allowed_bundle_ids: allowed_bundle_ids.clone(),
        })
        .map_err(|error| error.to_string())?;
        fs::write(&temporary, text).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(|error| error.to_string())?;
        }
        fs::rename(temporary, path).map_err(|error| error.to_string())
    }

    pub fn never_allowed(bundle_id: &str) -> bool {
        NEVER_ALLOWED.contains(&bundle_id)
    }

    pub fn allowed(&self, app: &AppHandle) -> Result<BTreeSet<String>, String> {
        self.ensure_loaded(app)?;
        Ok(self
            .access
            .lock()
            .map_err(|_| "Window Vision access lock poisoned")?
            .allowed_bundle_ids
            .clone())
    }

    pub fn add_from_picker(&self, app: &AppHandle, result: &Value) -> Result<Vec<String>, String> {
        self.ensure_loaded(app)?;
        let mut found = BTreeSet::new();
        for location in [
            result.get("bundleIds"),
            result.pointer("/metadata/bundleIds"),
        ] {
            if let Some(values) = location.and_then(Value::as_array) {
                for value in values {
                    if let Some(bundle_id) = value.as_str() {
                        if !bundle_id.is_empty() && !Self::never_allowed(bundle_id) {
                            found.insert(bundle_id.to_string());
                        }
                    }
                }
            }
        }
        if found.is_empty() {
            return Ok(Vec::new());
        }
        let snapshot = {
            let mut access = self
                .access
                .lock()
                .map_err(|_| "Window Vision access lock poisoned")?;
            access.allowed_bundle_ids.extend(found.iter().cloned());
            access.allowed_bundle_ids.clone()
        };
        self.persist(app, &snapshot)?;
        Ok(found.into_iter().collect())
    }

    pub fn remove(&self, app: &AppHandle, bundle_id: &str) -> Result<(), String> {
        self.ensure_loaded(app)?;
        let snapshot = {
            let mut access = self
                .access
                .lock()
                .map_err(|_| "Window Vision access lock poisoned")?;
            access.allowed_bundle_ids.remove(bundle_id);
            access.allowed_bundle_ids.clone()
        };
        self.persist(app, &snapshot)
    }
}
