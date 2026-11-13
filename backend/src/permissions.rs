//! Tool-call approval for agent turns — Claude Code's approval modes, ported
//! from ma-code-navigator's permission relay.
//!
//! The CLI's PreToolUse hook (a curl relay, see `claude_cli::settings_json`)
//! posts every Edit/Write/Bash call to `POST /api/agent/hook?chat=…`. The
//! running turn's mode decides:
//!
//! | mode          | edits in the folder      | shell commands                 |
//! |---------------|--------------------------|--------------------------------|
//! | `manual`      | card                     | card                           |
//! | `acceptEdits` | auto-approved            | card                           |
//! | `plan`        | refused (plan file only) | the CLI's read-only classifier |
//! | `auto`        | auto-approved            | auto-approved                  |
//!
//! In every mode, an edit outside the project folder (and /tmp) is refused —
//! the per-turn backup can only undo changes inside the folder. Cards are
//! answered via `POST /api/permissions/{requestId}` (allow / allowAlways / deny);
//! "always" lasts for the chat. The mode of a running turn can be switched
//! (`POST /api/chats/{id}/mode`) and applies to its next gated call.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Path as AxPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::state::AppState;

const WAIT_SECS: u64 = 570;
const PREVIEW_CAP: usize = 1200;

#[derive(Default)]
pub struct Permissions {
    /// request id → (chat id, resolver)
    pending: Mutex<HashMap<String, (String, oneshot::Sender<String>)>>,
    /// chat id → tool buckets ("Edit", "Bash") the user chose to always allow in that chat.
    always: Mutex<HashMap<String, HashSet<String>>>,
    /// chat id → automatic-denial notices already shown this turn.
    noticed: Mutex<HashMap<String, HashSet<String>>>,
}

impl Permissions {
    /// The turn ended or was stopped: wake every parked request (blocked hooks
    /// return now) and forget this turn's notices.
    pub fn cancel_chat(&self, chat_id: &str) {
        self.pending.lock().unwrap().retain(|_, (c, _)| c != chat_id);
        self.noticed.lock().unwrap().remove(chat_id);
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/agent/hook", post(hook))
        .route("/permissions/{rid}", post(answer))
}

pub fn token_ok(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("x-pdfedit-token")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t == token)
}

fn decision(allow: bool, reason: &str) -> Value {
    json!({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": if allow { "allow" } else { "deny" },
            "permissionDecisionReason": reason,
        }
    })
}

/// Canonicalize the deepest existing ancestor (the file may not exist yet).
fn resolve(root: &Path, target: &str) -> PathBuf {
    let p = Path::new(target);
    let abs: PathBuf = if p.is_absolute() { p.to_path_buf() } else { root.join(p) };
    let mut probe = abs.clone();
    let mut tail = Vec::new();
    loop {
        if let Ok(mut c) = probe.canonicalize() {
            for t in tail.iter().rev() {
                c.push(t);
            }
            return c;
        }
        match (probe.file_name(), probe.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name.to_os_string());
                probe = parent.to_path_buf();
            }
            _ => return abs,
        }
    }
}

/// Is `target` (absolute, or relative to `root`) inside the folder or /tmp?
fn inside_allowed(root: &Path, target: &str) -> bool {
    let resolved = resolve(root, target);
    if resolved.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return false;
    }
    let tmp_roots = [PathBuf::from("/tmp"), PathBuf::from("/private/tmp"), std::env::temp_dir()];
    resolved.starts_with(root)
        || tmp_roots
            .iter()
            .any(|t| resolved.starts_with(t) || t.canonicalize().is_ok_and(|c| resolved.starts_with(c)))
}

/// The Claude CLI's own plan store (`~/.claude/plans`) — the one legitimate plan-mode write.
fn is_plan_file(target: &str) -> bool {
    let Some(home) = dirs::home_dir() else { return false };
    let plans = home.join(".claude/plans");
    let plans = plans.canonicalize().unwrap_or(plans);
    let candidate = resolve(&home, target);
    candidate != plans && candidate.starts_with(&plans)
}

fn cap(s: &str) -> String {
    if s.len() <= PREVIEW_CAP {
        return s.to_string();
    }
    let mut end = PREVIEW_CAP;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &s[..end])
}

/// Old → new excerpt for an edit card.
fn edit_preview(tool: &str, input: &Value) -> Option<Value> {
    let s = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("");
    match tool {
        "Edit" => Some(json!({ "old": cap(s("old_string")), "new": cap(s("new_string")) })),
        "MultiEdit" => {
            let edits = input.get("edits")?.as_array()?;
            let old = edits.iter().take(3).filter_map(|e| e.get("old_string")?.as_str()).collect::<Vec<_>>().join("\n…\n");
            let new = edits.iter().take(3).filter_map(|e| e.get("new_string")?.as_str()).collect::<Vec<_>>().join("\n…\n");
            Some(json!({ "old": cap(&old), "new": cap(&new) }))
        }
        "Write" => Some(json!({ "new": cap(s("content")) })),
        _ => None,
    }
}

fn notice_once(state: &AppState, chat_id: &str, turn_id: &str, text: String) {
    let fresh = state.perms.noticed.lock().unwrap().entry(chat_id.to_string()).or_default().insert(text.clone());
    if fresh {
        crate::chat::emit(state, chat_id, turn_id, json!({ "kind": "notice", "text": text }));
    }
}

#[derive(Deserialize)]
struct HookQuery {
    chat: String,
}

async fn hook(
    State(state): State<AppState>,
    Query(q): Query<HookQuery>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !token_ok(&headers, &state.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Some(chat) = state.chats.get(&q.chat) else {
        return Json(decision(false, "unknown chat")).into_response();
    };
    let Ok(root) = state.projects.folder(&chat.project_id) else {
        return Json(decision(false, "project folder missing")).into_response();
    };
    let turn_id = state.chats.running_turn(&q.chat);
    let mode = state.chats.turn_mode(&q.chat).unwrap_or_else(|| chat.mode.clone());
    let tool = body.get("tool_name").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let input = body.get("tool_input").cloned().unwrap_or(Value::Null);
    let always = |bucket: &str| state.perms.always.lock().unwrap().get(&q.chat).is_some_and(|s| s.contains(bucket));
    let auto_deny = |reason: &str, lead: &str| {
        if let Some(t) = &turn_id {
            notice_once(&state, &q.chat, t, format!("Declined {lead} automatically — {}", reason.split(". ").next().unwrap_or(reason)));
        }
        Json(decision(false, reason)).into_response()
    };

    let (bucket, detail, description, preview) = match tool.as_str() {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let target = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();
            if target.is_empty() {
                return Json(decision(false, "edit without a target path")).into_response();
            }
            if mode == "plan" {
                if is_plan_file(&target) {
                    return Json(decision(true, "plan file")).into_response();
                }
                return auto_deny(
                    "Plan mode — make no edits this turn. Describe the change in your plan; the user approves it before an implement turn.",
                    "an edit",
                );
            }
            if !inside_allowed(&root, &target) {
                return auto_deny(
                    "Edits are limited to the project folder (and /tmp) so the per-turn backup can undo them. Work inside the project folder.",
                    &format!("an edit to {target}"),
                );
            }
            if mode == "auto" || mode == "acceptEdits" {
                return Json(decision(true, "auto-approved (edits inside the project folder)")).into_response();
            }
            if always("Edit") {
                return Json(decision(true, "allowed for this chat")).into_response();
            }
            let rel = resolve(&root, &target)
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(target.clone());
            let description = if tool == "Write" && !resolve(&root, &target).exists() { "create" } else { "edit" };
            ("Edit", rel, description.to_string(), edit_preview(&tool, &input))
        }
        "Bash" => {
            // Plan mode defers commands to the CLI's own read-only classifier.
            if mode == "plan" {
                return Json(json!({})).into_response();
            }
            if mode == "auto" || always("Bash") {
                return Json(decision(true, "auto-approved")).into_response();
            }
            let command = input.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let description = input.get("description").and_then(|c| c.as_str()).unwrap_or("").to_string();
            ("Bash", command, description, None)
        }
        _ => return Json(decision(true, "not gated")).into_response(),
    };

    let Some(turn_id) = turn_id else {
        return Json(decision(false, "no running turn to approve this")).into_response();
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.perms.pending.lock().unwrap().insert(request_id.clone(), (q.chat.clone(), tx));
    crate::chat::emit(
        &state,
        &q.chat,
        &turn_id,
        json!({
            "kind": "permission",
            "requestId": request_id,
            "tool": bucket,
            "detail": detail,
            "description": description,
            "preview": preview,
        }),
    );
    let d = match tokio::time::timeout(Duration::from_secs(WAIT_SECS), rx).await {
        Ok(Ok(d)) => d,
        _ => {
            state.perms.pending.lock().unwrap().remove(&request_id);
            "deny".to_string()
        }
    };
    if d == "allowAlways" {
        state.perms.always.lock().unwrap().entry(q.chat.clone()).or_default().insert(bucket.to_string());
    }
    let allow = d == "allow" || d == "allowAlways";
    crate::chat::emit(
        &state,
        &q.chat,
        &turn_id,
        json!({"kind": "permissionResolved", "requestId": request_id, "decision": if allow { "allow" } else { "deny" }}),
    );
    Json(decision(allow, if allow { "approved by user" } else { "denied by user" })).into_response()
}

#[derive(Deserialize)]
struct AnswerBody {
    decision: String,
}

async fn answer(
    State(state): State<AppState>,
    AxPath(rid): AxPath<String>,
    Json(b): Json<AnswerBody>,
) -> Json<Value> {
    let ok = match state.perms.pending.lock().unwrap().remove(&rid) {
        Some((_, tx)) => tx.send(b.decision).is_ok(),
        None => false,
    };
    Json(json!({ "ok": ok }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn containment() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        assert!(inside_allowed(&root, &root.join("deck.pptx").to_string_lossy()));
        assert!(inside_allowed(&root, "sub/new/file.md"));
        assert!(inside_allowed(&root, "/tmp/scratch.py"));
        assert!(!inside_allowed(&root, "/etc/hosts"));
        assert!(!inside_allowed(&root, "/usr/../etc/hosts"));
        assert!(!inside_allowed(&root, "../../../../../../etc/newfile"));
    }

    #[test]
    fn plan_store_containment() {
        let Some(home) = dirs::home_dir() else { return };
        assert!(is_plan_file(&home.join(".claude/plans/p.md").to_string_lossy()));
        assert!(!is_plan_file(&home.join(".claude/plans/../settings.json").to_string_lossy()));
        assert!(!is_plan_file("/etc/hosts"));
    }

    #[test]
    fn previews() {
        let p = edit_preview("Edit", &json!({"old_string": "a", "new_string": "b"})).unwrap();
        assert_eq!(p["old"], "a");
        assert_eq!(p["new"], "b");
        assert!(edit_preview("Write", &json!({"content": "x".repeat(5000)})).unwrap()["new"].as_str().unwrap().len() < 1300);
    }
}
