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
        .get("x-deckedit-token")
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
pub(crate) fn resolve(root: &Path, target: &str) -> PathBuf {
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
    let verdict = decide(&state, &q, &body).await;
    // Allowed (or left to the CLI): take the file lock it needs first — it may wait for another agent.
    let denied = verdict.pointer("/hookSpecificOutput/permissionDecision").and_then(|d| d.as_str()) == Some("deny");
    if !denied {
        if let Some(turned_back) = take_file_lock(&state, &q.chat, &body).await {
            return Json(turned_back).into_response();
        }
    }
    Json(verdict).into_response()
}

/// Several agents in one project: hold the files this call reads/writes (agent_locks.rs) until its
/// result comes back. Waits while another agent's running call needs them (with a note in the chat);
/// Some(deny) if that takes too long.
async fn take_file_lock(state: &AppState, chat_id: &str, body: &Value) -> Option<Value> {
    use crate::agent_locks::{Hold, MAX_WAIT};
    let turn = state.chats.running_turn(chat_id)?;
    let chat = state.chats.get(chat_id)?;
    let root = state.projects.folder(&chat.project_id).ok()?;
    let tool = body.get("tool_name").and_then(|t| t.as_str())?;
    let access = crate::agent_access::classify(tool, body.get("tool_input").unwrap_or(&Value::Null), &root);
    if access.is_empty() {
        return None;
    }
    let id = match body.get("tool_use_id").and_then(|v| v.as_str()) {
        Some(id) => id.to_string(),
        None => {
            tracing::warn!("hook input without tool_use_id — the lock is released when the turn ends");
            format!("{chat_id}:{}", uuid::Uuid::new_v4())
        }
    };
    let hold = Hold::new(id, chat.project_id.clone(), chat_id.to_string(), chat.title.clone(), access);
    // Shown to the user on the turn's status line while it waits (not in the transcript, not to the agent).
    let waited = std::sync::atomic::AtomicBool::new(false);
    let live = || state.chats.turn_live(chat_id, &turn);
    let result = state
        .locks
        .acquire(hold, &root, MAX_WAIT, live, |b| {
            waited.store(true, std::sync::atomic::Ordering::Relaxed);
            let doing = if b.writing { "changing" } else { "reading" };
            crate::chat::emit(state, chat_id, &turn, json!({ "kind": "status", "text": format!("Waiting for the agent in “{}” to finish {doing} {}…", b.chat_title, b.what) }));
        })
        .await;
    if waited.load(std::sync::atomic::Ordering::Relaxed) {
        crate::chat::emit(state, chat_id, &turn, json!({ "kind": "status", "text": null }));
    }
    if !live() {
        // Stopped while it waited: don't keep (or take) anything for a turn that's over.
        if let Some(id) = body.get("tool_use_id").and_then(|v| v.as_str()) {
            state.locks.release(id);
        }
        return Some(decision(false, "The turn was stopped."));
    }
    match result {
        Ok(waited) => {
            if waited > Duration::from_secs(1) {
                tracing::info!("chat {chat_id}: {tool} waited {:.1} s for another agent", waited.as_secs_f64());
            }
            None
        }
        Err(b) => Some(decision(
            false,
            &format!(
                "Another agent (in the chat “{}”) is still {} {} after {} minutes. Wait a little and try this again, or do other work meanwhile.",
                b.chat_title,
                if b.writing { "changing" } else { "reading" },
                b.what,
                MAX_WAIT.as_secs() / 60
            ),
        )),
    }
}

/// Whether the call may run: the running turn's approval mode, the user's answer to a card, or
/// (`{}`) the CLI's own rules.
async fn decide(state: &AppState, q: &HookQuery, body: &Value) -> Value {
    // Summarizing the conversation for a split: text only, no tools.
    if state.chats.summarizing(&q.chat) {
        return decision(false, "You're writing a summary — use no tools; reply with the summary text only.");
    }
    let Some(chat) = state.chats.get(&q.chat) else {
        return decision(false, "unknown chat");
    };
    let Ok(root) = state.projects.folder(&chat.project_id) else {
        return decision(false, "project folder missing");
    };
    let turn_id = state.chats.running_turn(&q.chat);
    let mode = state.chats.turn_mode(&q.chat).unwrap_or_else(|| chat.mode.clone());
    let tool = body.get("tool_name").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let input = body.get("tool_input").cloned().unwrap_or(Value::Null);
    let always = |bucket: &str| state.perms.always.lock().unwrap().get(&q.chat).is_some_and(|s| s.contains(bucket));
    let auto_deny = |reason: &str, lead: &str| {
        if let Some(t) = &turn_id {
            notice_once(state, &q.chat, t, format!("Declined {lead} automatically — {}", reason.split(". ").next().unwrap_or(reason)));
        }
        decision(false, reason)
    };

    // (always-allow bucket, card kind, detail, description, preview)
    let (bucket, kind, detail, description, preview): (String, &str, String, String, Option<Value>) = match tool.as_str() {
        "Edit" | "Write" | "MultiEdit" | "NotebookEdit" => {
            let target = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .to_string();
            if target.is_empty() {
                return decision(false, "edit without a target path");
            }
            if mode == "plan" {
                if is_plan_file(&target) {
                    return decision(true, "plan file");
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
                return decision(true, "auto-approved (edits inside the project folder)");
            }
            if always("Edit") {
                return decision(true, "allowed for this chat");
            }
            let rel = resolve(&root, &target)
                .strip_prefix(&root)
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or(target.clone());
            let description = if tool == "Write" && !resolve(&root, &target).exists() { "create" } else { "edit" };
            ("Edit".into(), "Edit", rel, description.to_string(), edit_preview(&tool, &input))
        }
        "Bash" => {
            // Plan mode defers commands to the CLI's own read-only classifier.
            if mode == "plan" {
                return json!({});
            }
            if mode == "auto" || always("Bash") {
                return decision(true, "auto-approved");
            }
            let command = input.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let description = input.get("description").and_then(|c| c.as_str()).unwrap_or("").to_string();
            ("Bash".into(), "Bash", command, description, None)
        }
        // Web tools reach the hook only when Agent settings → Web access is "Ask first" — asked in every mode.
        "WebSearch" | "WebFetch" => {
            if state.settings.get().web_access != "ask" || always("Web") {
                return decision(true, "web access allowed");
            }
            let s = |k: &str| input.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            let (detail, description) = if tool == "WebSearch" { (s("query"), "search the web".to_string()) } else { (s("url"), s("prompt")) };
            ("Web".to_string(), "Web", detail, description, None)
        }
        // The app's own tools (notes, view, screenshots).
        t if t.starts_with("mcp__deck__") => return decision(true, "app tool"),
        // The user's own MCP servers / connectors (only loaded when enabled in Settings).
        t if t.starts_with("mcp__") => {
            if mode == "plan" {
                return json!({}); // the CLI's plan mode decides (read-only tools only)
            }
            let mut parts = t.splitn(3, "__").skip(1);
            let server = parts.next().unwrap_or("").to_string();
            let action = parts.next().unwrap_or("").to_string();
            let bucket = format!("mcp:{server}");
            if mode == "auto" || always(&bucket) {
                return decision(true, "auto-approved");
            }
            let args = serde_json::to_string_pretty(&input).unwrap_or_default();
            let args: String = if args.chars().count() > 600 { format!("{}…", args.chars().take(600).collect::<String>()) } else { args };
            // "claude_ai_Slack" / "slack_add_reaction" → "Slack · add reaction"
            let pretty_server = server.trim_start_matches("claude_ai_").replace('_', " ");
            let lower = pretty_server.to_lowercase().replace(' ', "_");
            let pretty_action = action.strip_prefix(&format!("{lower}_")).unwrap_or(&action).replace('_', " ");
            (bucket, "Connector", format!("{pretty_server} · {pretty_action}"), args, None)
        }
        // Read-only tools reach the hook only for the file lock: the CLI's own rules decide.
        "Read" | "Grep" | "Glob" | "LS" | "NotebookRead" => return json!({}),
        _ => return decision(true, "not gated"),
    };

    let Some(turn_id) = turn_id else {
        return decision(false, "no running turn to approve this");
    };
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    state.perms.pending.lock().unwrap().insert(request_id.clone(), (q.chat.clone(), tx));
    crate::chat::emit(
        state,
        &q.chat,
        &turn_id,
        json!({
            "kind": "permission",
            "requestId": request_id,
            "tool": kind,
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
        state.perms.always.lock().unwrap().entry(q.chat.clone()).or_default().insert(bucket.clone());
    }
    let allow = d == "allow" || d == "allowAlways";
    crate::chat::emit(
        state,
        &q.chat,
        &turn_id,
        json!({"kind": "permissionResolved", "requestId": request_id, "decision": if allow { "allow" } else { "deny" }}),
    );
    decision(allow, if allow { "approved by user" } else { "denied by user" })
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
