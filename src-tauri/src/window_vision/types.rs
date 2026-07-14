use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub window_id: u32,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub bundle_id: String,
    #[serde(default)]
    pub application_name: String,
    #[serde(default)]
    pub process_id: i32,
    pub display_id: Option<u32>,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub is_on_screen: bool,
    #[serde(default)]
    pub is_active: bool,
    #[serde(default)]
    pub layer: i64,
    pub frame: WindowFrame,
}

impl WindowInfo {
    pub fn rank(&self) -> i64 {
        let area = (self.frame.width.max(0.0) * self.frame.height.max(0.0)) as i64;
        area + if self.is_active { 10_000_000 } else { 0 }
            + if self.is_on_screen { 5_000_000 } else { 0 }
            + if self.role == "main" { 2_000_000 } else { 0 }
            - self.layer.abs() * 100_000
    }
}

#[derive(Debug, Deserialize)]
pub struct WindowList {
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub windows: Vec<WindowInfo>,
}
