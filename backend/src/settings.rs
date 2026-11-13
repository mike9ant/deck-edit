//! Agent settings + Claude Code CLI status and model discovery.
//!
//! - `GET/PUT /api/settings` — how the agent runs by default: which `claude`
//!   binary, subscription vs API key, default approval mode / model / effort /
//!   fast mode, and a per-turn budget cap. Persisted in `<data_dir>/settings.json`.
//! - `PUT /api/settings/api-key` — an Anthropic key kept in
//!   `<data_dir>/credentials.json` (0600); never sent back to the browser.
//! - `GET /api/agent/status` — is the CLI installed (path, version), who is it
//!   logged in as (`claude auth status`), is a key available, is the Python env
//!   for python-pptx present.
//! - `GET /api/agent/models` — the model picker: each family alias
//!   (fable/opus/sonnet/haiku) labelled with the version the CLI resolves it
//!   to, plus which one is the CLI's default. Probed by starting the CLI and
//!   reading its `init` event, killed before any model call (no token cost).
//!   Ported from ma-code-navigator's `routes/agent.rs`.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::routing::{get, put};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};

use crate::error::{AppError, Result};
use crate::state::AppState;

/// Approval modes, Claude Code-style (see `permissions.rs` for what each allows).
pub const MODES: [&str; 4] = ["manual", "acceptEdits", "plan", "auto"];
pub const EFFORTS: [&str; 5] = ["low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentSettings {
    /// Path to the `claude` binary; empty = find `claude` on PATH.
    pub claude_path: String,
    /// "subscription" (the CLI's own `claude login`) or "key" (ANTHROPIC_API_KEY).
    pub auth: String,
    /// Approval mode for new chats.
    pub default_mode: String,
    /// Model alias for new chats; empty = the CLI's default.
    pub default_model: String,
    /// Reasoning effort for new chats; empty = the model's own.
    pub default_effort: String,
    /// Fast mode for new chats (Opus only).
    pub fast: bool,
    /// Hard cap on one turn's API spend (`--max-budget-usd`); None = no cap.
    pub max_budget_usd: Option<f64>,
}

impl Default for AgentSettings {
    fn default() -> Self {
        Self {
            claude_path: String::new(),
            auth: "subscription".into(),
            default_mode: "auto".into(),
            default_model: String::new(),
            default_effort: String::new(),
            fast: false,
            max_budget_usd: None,
        }
    }
}

pub struct SettingsStore {
    file: PathBuf,
    creds: PathBuf,
    current: Mutex<AgentSettings>,
}

impl SettingsStore {
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("settings.json");
        let current = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { file, creds: data_dir.join("credentials.json"), current: Mutex::new(current) }
    }

    pub fn get(&self) -> AgentSettings {
        self.current.lock().unwrap().clone()
    }

    fn save(&self, s: &AgentSettings) -> Result<()> {
        crate::files::write_atomic(&self.file, serde_json::to_string_pretty(s)?.as_bytes())?;
        Ok(())
    }

    /// The Anthropic key the agent may use: one saved in Settings wins over the
    /// environment's.
    pub fn api_key(&self) -> Option<String> {
        std::fs::read_to_string(&self.creds)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("anthropicApiKey").and_then(|k| k.as_str()).map(str::to_string))
            .filter(|k| !k.trim().is_empty())
            .or_else(|| std::env::var("ANTHROPIC_API_KEY").ok().filter(|k| !k.trim().is_empty()))
    }

    fn stored_key(&self) -> bool {
        std::fs::read_to_string(&self.creds)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("anthropicApiKey").and_then(|k| k.as_str()).map(|k| !k.trim().is_empty()))
            .unwrap_or(false)
    }

    fn set_key(&self, key: &str) -> Result<()> {
        if key.trim().is_empty() {
            let _ = std::fs::remove_file(&self.creds);
            return Ok(());
        }
        crate::files::write_atomic(&self.creds, json!({ "anthropicApiKey": key.trim() }).to_string().as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.creds, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    /// The `claude` command to spawn.
    pub fn claude_bin(&self) -> String {
        let p = self.get().claude_path;
        if p.trim().is_empty() { "claude".into() } else { p.trim().to_string() }
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/settings", get(get_settings).put(put_settings))
        .route("/settings/api-key", put(put_key))
        .route("/agent/status", get(status))
        .route("/agent/models", get(models))
}

fn settings_json(state: &AppState) -> Value {
    let mut v = serde_json::to_value(state.settings.get()).unwrap_or(json!({}));
    v["apiKeyStored"] = json!(state.settings.stored_key());
    v["apiKeyAvailable"] = json!(state.settings.api_key().is_some());
    v
}

async fn get_settings(State(state): State<AppState>) -> Json<Value> {
    Json(settings_json(&state))
}

/// Partial update: only the fields present in the body change.
async fn put_settings(State(state): State<AppState>, Json(body): Json<Value>) -> Result<Json<Value>> {
    let mut cur = serde_json::to_value(state.settings.get())?;
    if let (Some(dst), Some(src)) = (cur.as_object_mut(), body.as_object()) {
        for (k, v) in src {
            if dst.contains_key(k) {
                dst.insert(k.clone(), v.clone());
            }
        }
    }
    let mut next: AgentSettings = serde_json::from_value(cur).map_err(|e| AppError::BadRequest(e.to_string()))?;
    if !MODES.contains(&next.default_mode.as_str()) {
        next.default_mode = "auto".into();
    }
    if !next.default_effort.is_empty() && !EFFORTS.contains(&next.default_effort.as_str()) {
        next.default_effort.clear();
    }
    if next.auth != "key" {
        next.auth = "subscription".into();
    }
    state.settings.save(&next)?;
    let changed_bin = next.claude_path != state.settings.get().claude_path;
    *state.settings.current.lock().unwrap() = next;
    if changed_bin {
        *models_cache().lock().unwrap() = None;
    }
    Ok(Json(settings_json(&state)))
}

#[derive(Deserialize)]
struct KeyBody {
    key: String,
}

async fn put_key(State(state): State<AppState>, Json(b): Json<KeyBody>) -> Result<Json<Value>> {
    state.settings.set_key(&b.key)?;
    Ok(Json(settings_json(&state)))
}

async fn run_capture(bin: &str, args: &[&str], secs: u64) -> Option<String> {
    let out = tokio::time::timeout(
        Duration::from_secs(secs),
        tokio::process::Command::new(bin).args(args).stdin(Stdio::null()).kill_on_drop(true).output(),
    )
    .await
    .ok()?
    .ok()?;
    Some(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

fn which(bin: &str) -> Option<String> {
    if bin.contains('/') {
        return Path::new(bin).exists().then(|| bin.to_string());
    }
    std::env::var("PATH")
        .ok()?
        .split(':')
        .map(|d| Path::new(d).join(bin))
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

async fn status(State(state): State<AppState>) -> Json<Value> {
    let bin = state.settings.claude_bin();
    let path = which(&bin);
    let version = match &path {
        Some(p) => run_capture(p, &["--version"], 10).await.map(|s| s.trim().to_string()),
        None => None,
    };
    let auth = match &path {
        Some(p) => run_capture(p, &["auth", "status"], 15)
            .await
            .and_then(|s| serde_json::from_str::<Value>(s.trim()).ok())
            .map(|v| {
                json!({
                    "loggedIn": v.get("loggedIn"),
                    "authMethod": v.get("authMethod"),
                    "subscriptionType": v.get("subscriptionType"),
                    "email": v.get("email"),
                    "orgName": v.get("orgName"),
                    "loginExpiresAt": v.get("loginExpiresAt"),
                })
            }),
        None => None,
    };
    let python = state.python_bin.as_ref().map(|b| b.join("python3"));
    let pptx = match &python {
        Some(py) => run_capture(&py.to_string_lossy(), &["-c", "import pptx, fitz; print(pptx.__version__)"], 15)
            .await
            .map(|s| s.trim().to_string())
            .filter(|s| !s.contains("Error")),
        None => None,
    };
    let st = state.clone();
    let conversations = tokio::task::spawn_blocking(move || crate::conversations::sources(&st))
        .await
        .unwrap_or(json!(null));
    Json(json!({
        "cli": { "found": path.is_some(), "path": path, "version": version, "command": bin },
        "auth": auth,
        "apiKeyAvailable": state.settings.api_key().is_some(),
        "python": { "path": python, "pythonPptx": pptx },
        "conversations": conversations,
    }))
}

// ─── model picker (ported from ma-code-navigator) ────────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ModelOption {
    id: String,
    label: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    default: bool,
}

const MODEL_FAMILIES: [&str; 4] = ["fable", "opus", "sonnet", "haiku"];
const MODELS_TTL: Duration = Duration::from_secs(6 * 60 * 60);
type ModelsCache = Mutex<Option<(Instant, Vec<ModelOption>)>>;

fn models_cache() -> &'static ModelsCache {
    static C: OnceLock<ModelsCache> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

fn capitalize(s: &str) -> String {
    let mut cs = s.chars();
    cs.next().map(|c| c.to_uppercase().collect::<String>()).unwrap_or_default() + cs.as_str()
}

/// `claude-opus-4-8` → "Opus 4.8", `claude-haiku-4-5-20251001` → "Haiku 4.5", `claude-fable-5[1m]` → "Fable 5".
pub fn label_from_model_id(id: &str) -> String {
    let base = id.strip_prefix("claude-").unwrap_or(id);
    let base = base.split('[').next().unwrap_or(base);
    let parts: Vec<&str> = base.split('-').collect();
    let Some(family) = parts.first() else { return id.to_string() };
    let ver: Vec<&str> = parts[1..]
        .iter()
        .take_while(|p| p.chars().all(|c| c.is_ascii_digit()))
        .take(2)
        .copied()
        .collect();
    if ver.is_empty() { capitalize(family) } else { format!("{} {}", capitalize(family), ver.join(".")) }
}

/// What a `--model` alias resolves to (None alias = the CLI's default), read
/// from the CLI's `init` event before any model call.
async fn probe_model(bin: &str, alias: Option<&str>) -> Option<String> {
    let mut args = vec!["-p", ".", "--output-format", "stream-json", "--verbose"];
    if let Some(a) = alias {
        args.extend(["--model", a]);
    }
    let mut child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let read_init = async {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                if v.get("type").and_then(|t| t.as_str()) == Some("system") {
                    return v.get("model").and_then(|m| m.as_str()).map(str::to_string);
                }
            }
        }
        None
    };
    let model = tokio::time::timeout(Duration::from_secs(15), read_init).await.ok().flatten();
    let _ = child.start_kill();
    model
}

async fn models(State(state): State<AppState>) -> Json<Vec<ModelOption>> {
    if let Some((at, cached)) = models_cache().lock().unwrap().clone() {
        if at.elapsed() < MODELS_TTL {
            return Json(cached);
        }
    }
    let bin = state.settings.claude_bin();
    let probes = MODEL_FAMILIES.iter().map(|fam| {
        let bin = bin.clone();
        async move {
            let resolved = probe_model(&bin, Some(fam)).await;
            (fam.to_string(), resolved)
        }
    });
    let (probed, default_resolved) = tokio::join!(futures::future::join_all(probes), probe_model(&bin, None));
    let mut options: Vec<ModelOption> = probed
        .iter()
        .map(|(fam, res)| ModelOption {
            id: fam.clone(),
            label: res.as_deref().map(label_from_model_id).unwrap_or_else(|| capitalize(fam)),
            default: res.is_some() && res == &default_resolved,
        })
        .collect();
    // Only one "default" even if two aliases resolve alike.
    let mut seen = false;
    for o in options.iter_mut() {
        if o.default {
            if seen {
                o.default = false;
            }
            seen = true;
        }
    }
    if probed.iter().any(|(_, r)| r.is_some()) {
        *models_cache().lock().unwrap() = Some((Instant::now(), options.clone()));
    }
    Json(options)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(label_from_model_id("claude-opus-4-8"), "Opus 4.8");
        assert_eq!(label_from_model_id("claude-haiku-4-5-20251001"), "Haiku 4.5");
        assert_eq!(label_from_model_id("claude-fable-5[1m]"), "Fable 5");
        assert_eq!(label_from_model_id("claude-sonnet-5-5"), "Sonnet 5.5");
    }
}
