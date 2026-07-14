// Registry of external CLI tools MAHI can detect/install on the user's
// machine (starting with Graphify — github.com/Graphify-Labs/graphify, a
// code-to-knowledge-graph tool). Unlike models.rs's MODEL_REGISTRY (a fixed
// binary at a known URL, downloaded with byte-progress tracking), these are
// package-manager-installed CLIs — installation is a shell command with a
// fallback chain (uv, then pipx, then pip), not a file download. Once
// installed, the agent invokes the tool directly via the existing
// run_command tool (see ChatPanel.tsx's buildSystemContent) — no dedicated
// invoke/query command is needed here.
use serde::Serialize;
use tokio::process::Command;

pub struct ExternalToolSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub docs_url: &'static str,
    // Binary name checked via `command -v` to decide "installed or not".
    pub check_bin: &'static str,
    // Full shell command (with || fallbacks between package managers) run
    // through a login shell so it resolves the user's real PATH — GUI apps
    // don't inherit ~/.zshrc's PATH additions, the same reasoning already
    // documented for resolve_ffmpeg in asr.rs.
    pub install_shell_cmd: &'static str,
}

pub const EXTERNAL_TOOLS: &[ExternalToolSpec] = &[ExternalToolSpec {
    id: "graphify",
    name: "Graphify",
    description: "کدبیس رو به یک knowledge graph قابل‌کوئری تبدیل می‌کنه (تحلیل محلی با tree-sitter) — برای سوالات کلی درباره‌ی معماری و رابطه‌ی بین بخش‌های پروژه.",
    docs_url: "https://github.com/Graphify-Labs/graphify",
    check_bin: "graphify",
    install_shell_cmd: "uv tool install graphifyy || pipx install graphifyy || pip3 install --user graphifyy",
}];

#[derive(Serialize)]
pub struct ExternalToolInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub docs_url: String,
}

fn spec_by_id(id: &str) -> Result<&'static ExternalToolSpec, String> {
    EXTERNAL_TOOLS
        .iter()
        .find(|t| t.id == id)
        .ok_or_else(|| format!("unknown external tool id: {id}"))
}

#[tauri::command]
pub fn external_tools_list() -> Vec<ExternalToolInfo> {
    EXTERNAL_TOOLS
        .iter()
        .map(|t| ExternalToolInfo {
            id: t.id.to_string(),
            name: t.name.to_string(),
            description: t.description.to_string(),
            docs_url: t.docs_url.to_string(),
        })
        .collect()
}

#[tauri::command]
pub async fn external_tool_status(tool_id: String) -> Result<bool, String> {
    let spec = spec_by_id(&tool_id)?;
    let output = Command::new("bash")
        .arg("-lc")
        .arg(format!("command -v {}", spec.check_bin))
        .output()
        .await
        .map_err(|e| e.to_string())?;
    Ok(output.status.success())
}

#[tauri::command]
pub async fn external_tool_install(tool_id: String) -> Result<String, String> {
    let spec = spec_by_id(&tool_id)?;
    let output = Command::new("bash")
        .arg("-lc")
        .arg(spec.install_shell_cmd)
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if output.status.success() {
        Ok(format!("{stdout}\n{stderr}").trim().to_string())
    } else {
        Err(if stderr.trim().is_empty() { stdout } else { stderr })
    }
}
