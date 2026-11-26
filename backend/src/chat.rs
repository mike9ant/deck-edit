//! Agent chats: a project has any number of chats (tabs in the UI); each chat
//! is one continuing Claude Code conversation (`--resume`), a list of turns,
//! and an approval mode.
//!
//! A turn: snapshot the folder (backups.rs) → spawn the CLI with the user's
//! message plus an app-generated context block (what the user is looking at,
//! the edits they made since the last turn, open slide notes) → stream events
//! to every browser over `/api/events` → diff the folder against the snapshot
//! so the transcript can show "changed deck.pptx · Revert".
//!
//! Persisted per chat at `<data_dir>/chats/<project>/<chat>.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{Path as AxPath, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};

use crate::backups::{self, Change};
use crate::claude_cli;
use crate::error::{AppError, Result};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Turn {
    pub id: String,
    pub prompt: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<Value>,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<String>,
    /// "running" | "done" | "error" | "stopped"
    pub status: String,
    #[serde(default)]
    pub events: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_id: Option<String>,
    #[serde(default)]
    pub changes: Vec<Change>,
    /// Set after Revert: the safety snapshot that undoes the revert.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reverted: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    /// Tokens the turn used (input incl. cached, output).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<crate::claude_cli::TokenUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// The posture this turn ran under (shown on the turn in the transcript).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(default)]
    pub fast: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// Images attached to the user's message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<crate::chat_images::ChatImage>,
    /// Whether the prompt cache was predicted warm when the turn started (see cache_check.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cache: Option<crate::cache_check::CacheCheck>,
    /// Another agent ran in the project during this turn: its changes are the files it wrote
    /// itself (`touched`), not everything that changed in the folder meanwhile.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub overlapped: bool,
    /// Files (or folders) this turn's tool calls wrote, relative to the project folder ("" = all of it).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub touched: Vec<String>,
    /// This turn started a fresh conversation from a summary of the earlier one (conversation_split.rs).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<crate::conversation_split::SplitInfo>,
    /// The notes this turn works on: the chat's open notes when it started (and any the agent
    /// adds). Notes pinned while it runs wait for the next message; `list_notes` and
    /// `resolve_note` see only these.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub id: String,
    pub project_id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli_session_id: Option<String>,
    /// Approval mode for the next turn: "manual" | "acceptEdits" | "plan" | "auto".
    #[serde(default = "default_mode")]
    pub mode: String,
    /// Model alias for the next turn; None = the CLI's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Reasoning effort for the next turn; None = the model's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    /// Fast mode (Opus only) for the next turn.
    #[serde(default)]
    pub fast: bool,
    /// "subscription" | "key"; None = the settings' choice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth: Option<String>,
    /// The Auto-mode disclosure was shown in this conversation.
    #[serde(default)]
    pub auto_notice_shown: bool,
    #[serde(default)]
    pub turns: Vec<Turn>,
}

/// The CLI's own vocabulary for a turn's approval posture.
pub fn normalize_mode(m: &str) -> String {
    match m {
        "ask" => "manual".into(),
        m if crate::settings::MODES.contains(&m) => m.into(),
        _ => "auto".into(),
    }
}

struct RunningTurn {
    turn_id: String,
    stop: Option<oneshot::Sender<()>>,
    /// Stop was pressed: the agent is gone, a command it started may still be finishing.
    stopping: bool,
    /// Kill: end that command now instead of letting it finish.
    kill: Arc<tokio::sync::Notify>,
    /// Summarizing the conversation for a split (no tools allowed meanwhile).
    summarizing: bool,
    /// The approval mode governing the running turn (switchable mid-turn,
    /// except into or out of plan, which is fixed by the CLI flag).
    mode: String,
}

fn default_mode() -> String {
    "auto".into()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ChatSummary {
    id: String,
    title: String,
    updated_at: String,
    turn_count: usize,
    running: bool,
}

pub struct ChatRegistry {
    dir: PathBuf,
    chats: Mutex<HashMap<String, Chat>>,
    /// chat id → the turn running in it
    running: Mutex<HashMap<String, RunningTurn>>,
    /// (chat, turn) left running when the app last quit — see `settle_interrupted`.
    interrupted: Mutex<Vec<(String, String)>>,
}

impl ChatRegistry {
    pub fn load(data_dir: &Path) -> Self {
        let dir = data_dir.join("chats");
        let mut chats = HashMap::new();
        let mut interrupted = Vec::new();
        if let Ok(projects) = std::fs::read_dir(&dir) {
            for p in projects.filter_map(|e| e.ok()) {
                let Ok(files) = std::fs::read_dir(p.path()) else { continue };
                for f in files.filter_map(|e| e.ok()) {
                    let Ok(text) = std::fs::read_to_string(f.path()) else { continue };
                    let Ok(mut chat) = serde_json::from_str::<Chat>(&text) else { continue };
                    chat.mode = normalize_mode(&chat.mode);
                    // A turn left "running" by a crash/restart is over — but its CLI session (saved as soon as
                    // it started) holds what it did, so a new message continues it.
                    for t in chat.turns.iter_mut() {
                        if t.status == "running" {
                            t.status = "stopped".into();
                            t.ended_at.get_or_insert_with(|| chrono::Utc::now().to_rfc3339());
                            // Did the agent get going (anything from it beyond the app's own backup step)?
                            let started = t.events.iter().any(|e| match e.get("kind").and_then(|k| k.as_str()) {
                                Some("activity") => e.get("tool").and_then(|k| k.as_str()) != Some("backup"),
                                Some("message" | "command" | "fileEdited" | "permission" | "todos") => true,
                                _ => false,
                            });
                            let text = if started { INTERRUPTED_NOTICE } else { INTERRUPTED_BEFORE_START };
                            t.events.push(json!({ "kind": "notice", "text": text }));
                            interrupted.push((chat.id.clone(), t.id.clone()));
                        }
                    }
                    chats.insert(chat.id.clone(), chat);
                }
            }
        }
        Self { dir, chats: Mutex::new(chats), running: Mutex::new(HashMap::new()), interrupted: Mutex::new(interrupted) }
    }

    pub fn get(&self, id: &str) -> Option<Chat> {
        self.chats.lock().unwrap().get(id).cloned()
    }

    /// CLI session id → chat title, for every chat of this app (so the
    /// conversation browser can label Deck Edit's own agent sessions).
    pub fn cli_sessions(&self) -> HashMap<String, String> {
        self.chats
            .lock()
            .unwrap()
            .values()
            .filter_map(|c| c.cli_session_id.clone().map(|s| (s, format!("Deck Edit chat: {}", c.title))))
            .collect()
    }

    /// Other chats of `project_id` with a running turn: (chat id, turn id).
    fn running_in_project(&self, project_id: &str, except: &str) -> Vec<(String, String)> {
        let running = self.running.lock().unwrap();
        let chats = self.chats.lock().unwrap();
        running
            .iter()
            .filter(|(id, _)| id.as_str() != except && chats.get(*id).is_some_and(|c| c.project_id == project_id))
            .map(|(id, r)| (id.clone(), r.turn_id.clone()))
            .collect()
    }

    pub fn summarizing(&self, chat_id: &str) -> bool {
        self.running.lock().unwrap().get(chat_id).is_some_and(|r| r.summarizing)
    }

    fn set_summarizing(&self, chat_id: &str, on: bool) {
        if let Some(r) = self.running.lock().unwrap().get_mut(chat_id) {
            r.summarizing = on;
        }
    }

    /// Whether `turn_id` is the chat's running turn and its agent hasn't been stopped.
    pub fn turn_live(&self, chat_id: &str, turn_id: &str) -> bool {
        self.running.lock().unwrap().get(chat_id).is_some_and(|r| r.turn_id == turn_id && !r.stopping)
    }

    pub fn running_turn(&self, chat_id: &str) -> Option<String> {
        self.running.lock().unwrap().get(chat_id).map(|r| r.turn_id.clone())
    }

    /// The approval mode governing the chat's running turn (None when idle).
    pub fn turn_mode(&self, chat_id: &str) -> Option<String> {
        self.running.lock().unwrap().get(chat_id).map(|r| r.mode.clone())
    }

    fn persist(&self, chat: &Chat) {
        let path = self.dir.join(&chat.project_id).join(format!("{}.json", chat.id));
        match serde_json::to_vec_pretty(chat) {
            Ok(bytes) => {
                if let Err(e) = crate::files::write_atomic(&path, &bytes) {
                    tracing::warn!("persist chat {}: {e}", chat.id);
                }
            }
            Err(e) => tracing::warn!("serialize chat: {e}"),
        }
    }

    pub fn update(&self, id: &str, f: impl FnOnce(&mut Chat)) -> Result<Chat> {
        let mut chats = self.chats.lock().unwrap();
        let chat = chats.get_mut(id).ok_or_else(|| AppError::NotFound(format!("chat {id} not found")))?;
        f(chat);
        chat.updated_at = chrono::Utc::now().to_rfc3339();
        let out = chat.clone();
        drop(chats);
        self.persist(&out);
        Ok(out)
    }

    /// The notes the chat's running turn works on (None: no turn running).
    pub fn turn_notes(&self, chat_id: &str) -> Option<Vec<String>> {
        let chats = self.chats.lock().unwrap();
        chats.get(chat_id)?.turns.iter().rev().find(|t| t.status == "running").map(|t| t.notes.clone())
    }

    /// A note the agent added: part of its running turn's notes.
    pub fn add_turn_note(&self, chat_id: &str, note_id: &str) {
        if let Some(chat) = self.chats.lock().unwrap().get_mut(chat_id) {
            if let Some(t) = chat.turns.iter_mut().rev().find(|t| t.status == "running") {
                t.notes.push(note_id.to_string());
            }
        }
    }

    /// Mutate a turn without persisting (hot path for streaming events).
    fn with_turn(&self, chat_id: &str, turn_id: &str, f: impl FnOnce(&mut Turn)) {
        if let Some(chat) = self.chats.lock().unwrap().get_mut(chat_id) {
            if let Some(t) = chat.turns.iter_mut().find(|t| t.id == turn_id) {
                f(t);
            }
        }
    }
}

/// Record one turn event (everything except live text deltas) and broadcast it.
pub fn emit(state: &AppState, chat_id: &str, turn_id: &str, event: Value) {
    let kind = event.get("kind").and_then(|k| k.as_str()).unwrap_or("");
    // Live-only: text deltas, thinking, and the status line ("waiting for another agent…").
    if kind != "delta" && kind != "thinking" && kind != "status" {
        state.chats.with_turn(chat_id, turn_id, |t| {
            if kind == "todos" {
                t.events.retain(|e| e.get("kind").and_then(|k| k.as_str()) != Some("todos"));
            }
            t.events.push(event.clone());
        });
    }
    state.publish(json!({ "type": "chat", "chatId": chat_id, "turnId": turn_id, "event": event }));
}

/// Credit the files a finished tool call wrote to its turn (`Turn::touched`): the paths it was
/// classified as writing, or — for a call that could write anything — what actually changed
/// while it ran (nobody else could write meanwhile).
fn credit(state: &AppState, chat_id: &str, turn_id: &str, root: &Path, hold: crate::agent_locks::Hold) {
    let mut paths: Vec<String> = hold
        .access
        .writes
        .iter()
        .filter_map(|p| p.strip_prefix(root).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
        .collect();
    if let Some(before) = &hold.before {
        paths.extend(crate::agent_locks::changed_between(before, &crate::agent_locks::snapshot(root)));
    }
    if paths.is_empty() {
        return;
    }
    let _ = state.chats.update(chat_id, |c| {
        if let Some(t) = c.turns.iter_mut().find(|t| t.id == turn_id) {
            for p in paths {
                if !t.touched.contains(&p) {
                    t.touched.push(p);
                }
            }
        }
    });
}

/// A turn's own changes: all of the folder's when it ran alone; with other agents at work at the
/// same time, only those under the paths it wrote itself.
fn own_changes(turn: Option<&Turn>, all: Vec<backups::Change>) -> Vec<backups::Change> {
    let Some(t) = turn.filter(|t| t.overlapped) else { return all };
    let under = |p: &str| t.touched.iter().any(|w| w.is_empty() || p == w || p.starts_with(&format!("{w}/")));
    all.into_iter().filter(|c| under(&c.path) || c.from.as_deref().is_some_and(under)).collect()
}

/// After a restart: turns the app's quitting cut short get their change lists (so they can be
/// reviewed and reverted); their chats continue from the saved CLI session on the next message.
pub async fn settle_interrupted(state: AppState) {
    let list = std::mem::take(&mut *state.chats.interrupted.lock().unwrap());
    for (cid, tid) in list {
        let Some(chat) = state.chats.get(&cid) else { continue };
        let Some(turn) = chat.turns.iter().find(|t| t.id == tid).cloned() else { continue };
        let (Some(sid), Ok(root)) = (turn.snapshot_id.clone(), state.projects.folder(&chat.project_id)) else { continue };
        if !turn.changes.is_empty() {
            continue;
        }
        let (dd, pid) = (state.data_dir.clone(), chat.project_id.clone());
        let all = tokio::task::spawn_blocking(move || backups::load(&dd, &pid, &sid).map(|m| backups::changes(&m, &root)))
            .await
            .ok()
            .and_then(|r| r.ok())
            .unwrap_or_default();
        let changes = own_changes(Some(&turn), all);
        if changes.is_empty() {
            continue;
        }
        let _ = state.chats.update(&cid, |c| {
            if let Some(t) = c.turns.iter_mut().find(|t| t.id == tid) {
                t.changes = changes;
            }
        });
        state.publish(json!({ "type": "chatUpdated", "chatId": cid }));
    }
}

/// Update the turn's last `tool` activity in place to a finished state and
/// broadcast it (`done: true` tells the UI to replace, not append).
fn finish_activity(state: &AppState, chat_id: &str, turn_id: &str, tool: &str, detail: &str) {
    let event = json!({"kind": "activity", "tool": tool, "detail": detail, "done": true});
    state.chats.with_turn(chat_id, turn_id, |t| {
        let last = t.events.iter_mut().rev().find(|e| {
            e.get("kind").and_then(|k| k.as_str()) == Some("activity") && e.get("tool").and_then(|k| k.as_str()) == Some(tool)
        });
        match last {
            Some(e) => *e = event.clone(),
            None => t.events.push(event.clone()),
        }
    });
    state.publish(json!({ "type": "chat", "chatId": chat_id, "turnId": turn_id, "event": event }));
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{id}/chats", get(list).post(create))
        .route("/chats/{cid}", get(get_chat).patch(update).delete(delete))
        .route("/chats/{cid}/turns", post(start_turn))
        .route("/chats/{cid}/cache", get(cache_state))
        .route("/chats/{cid}/stop", post(stop))
        .route("/chats/{cid}/kill", post(kill))
        .route("/chats/{cid}/mode", post(set_mode))
        .route("/chats/{cid}/images/{file}", get(crate::chat_images::serve_image))
        .route("/chats/{cid}/turns/{tid}/revert", post(revert))
        .route("/chats/{cid}/turns/{tid}/unrevert", post(unrevert))
        .route("/projects/{id}/snapshots/{sid}/file", get(snapshot_file))
}

async fn list(State(state): State<AppState>, AxPath(id): AxPath<String>) -> Json<Vec<ChatSummary>> {
    let running = state.chats.running.lock().unwrap().keys().cloned().collect::<std::collections::HashSet<_>>();
    let mut out: Vec<ChatSummary> = state
        .chats
        .chats
        .lock()
        .unwrap()
        .values()
        .filter(|c| c.project_id == id)
        .map(|c| ChatSummary {
            id: c.id.clone(),
            title: c.title.clone(),
            updated_at: c.updated_at.clone(),
            turn_count: c.turns.len(),
            running: running.contains(&c.id),
        })
        .collect();
    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Json(out)
}

#[derive(Deserialize, Default)]
struct CreateBody {
    title: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    body: Option<Json<CreateBody>>,
) -> Result<Json<Chat>> {
    state.projects.get(&id)?;
    let now = chrono::Utc::now().to_rfc3339();
    // A new chat starts from the saved defaults (Settings, or the last pick).
    let d = state.settings.get();
    let chat = Chat {
        id: uuid::Uuid::new_v4().to_string(),
        project_id: id,
        title: body.and_then(|b| b.0.title).unwrap_or_else(|| "New chat".into()),
        created_at: now.clone(),
        updated_at: now,
        cli_session_id: None,
        mode: normalize_mode(&d.default_mode),
        model: Some(d.default_model).filter(|m| !m.is_empty()),
        effort: Some(d.default_effort).filter(|e| !e.is_empty()),
        fast: d.fast,
        auth: None,
        auto_notice_shown: false,
        turns: Vec::new(),
    };
    state.chats.chats.lock().unwrap().insert(chat.id.clone(), chat.clone());
    state.chats.persist(&chat);
    Ok(Json(chat))
}

async fn get_chat(State(state): State<AppState>, AxPath(cid): AxPath<String>) -> Result<Json<Value>> {
    let chat = state.chats.get(&cid).ok_or_else(|| AppError::NotFound("chat not found".into()))?;
    let mut v = serde_json::to_value(&chat)?;
    v["runningTurnId"] = json!(state.chats.running_turn(&cid));
    Ok(Json(v))
}

/// Whether the chat's next turn would start on a cold prompt cache (its current settings, now).
async fn cache_state(State(state): State<AppState>, AxPath(cid): AxPath<String>) -> Result<Json<crate::cache_check::CacheCheck>> {
    let chat = state.chats.get(&cid).ok_or_else(|| AppError::NotFound("chat not found".into()))?;
    let auth = chat.auth.clone().unwrap_or_else(|| state.settings.get().auth);
    Ok(Json(predict_cache(&state, &chat, &auth)))
}

/// The cache prediction for `chat`'s next turn (its model / effort / fast settings), on login `auth`.
fn predict_cache(state: &AppState, chat: &Chat, auth: &str) -> crate::cache_check::CacheCheck {
    use crate::cache_check::{learn_ttl, predict, CacheKey};
    let key = CacheKey { model: chat.model.clone(), effort: chat.effort.clone(), fast: chat.fast && fast_supported(chat.model.as_deref()) };
    let mut ttl = learn_ttl(state.chats.chats.lock().unwrap().values(), Some(auth));
    // No turn on this login reported it yet: the chat's CLI transcript has the API's report.
    if !ttl.1 {
        if let Some(t) = chat.cli_session_id.as_deref().and_then(crate::conversations::session_cache_ttl) {
            ttl = (t, true);
        }
    }
    let mut c = predict(chat, &key, chrono::Utc::now(), ttl);
    // The last turn predates size tracking (or didn't report it): the CLI's own transcript knows.
    if c.context_tokens == 0 {
        if let Some(n) = chat.cli_session_id.as_deref().and_then(crate::conversations::session_context_tokens) {
            c.context_tokens = n;
            c.offer_split = c.cold && n >= crate::cache_check::SPLIT_THRESHOLD;
        }
    }
    c
}

/// The posture fields a chat (and a turn request) can carry. Empty strings
/// clear an override (back to the CLI's/model's own default).
#[derive(Deserialize, Default)]
struct Posture {
    mode: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    fast: Option<bool>,
    auth: Option<String>,
}

fn apply_posture(c: &mut Chat, p: Posture) {
    if let Some(m) = p.mode {
        c.mode = normalize_mode(&m);
    }
    if let Some(m) = p.model {
        c.model = Some(m).filter(|m| !m.is_empty() && m != "default");
    }
    if let Some(e) = p.effort {
        c.effort = Some(e).filter(|e| crate::settings::EFFORTS.contains(&e.as_str()));
    }
    if let Some(f) = p.fast {
        c.fast = f;
    }
    if let Some(a) = p.auth {
        c.auth = Some(a).filter(|a| a == "subscription" || a == "key");
    }
}

#[derive(Deserialize)]
struct UpdateBody {
    title: Option<String>,
    #[serde(flatten)]
    posture: Posture,
}

async fn update(
    State(state): State<AppState>,
    AxPath(cid): AxPath<String>,
    Json(b): Json<UpdateBody>,
) -> Result<Json<Chat>> {
    let chat = state.chats.update(&cid, |c| {
        if let Some(t) = b.title.filter(|t| !t.trim().is_empty()) {
            c.title = t;
        }
        apply_posture(c, b.posture);
    })?;
    Ok(Json(chat))
}

#[derive(Deserialize)]
struct ModeBody {
    mode: String,
}

/// Switch the approval mode — for the next turn, and for the running turn
/// too when possible (`applied`). Plan is fixed for a running turn: it is a
/// CLI flag, so a turn can't enter or leave it midway.
async fn set_mode(
    State(state): State<AppState>,
    AxPath(cid): AxPath<String>,
    Json(b): Json<ModeBody>,
) -> Result<Json<Value>> {
    let mode = normalize_mode(&b.mode);
    state.chats.update(&cid, |c| c.mode = mode.clone())?;
    let mut applied = false;
    let mut running_mode = None;
    if let Some(r) = state.chats.running.lock().unwrap().get_mut(&cid) {
        if r.mode != "plan" && mode != "plan" {
            r.mode = mode.clone();
            applied = true;
        }
        running_mode = Some(r.mode.clone());
    }
    Ok(Json(json!({ "mode": mode, "applied": applied, "runningMode": running_mode })))
}

async fn delete(State(state): State<AppState>, AxPath(cid): AxPath<String>) -> Result<Json<Value>> {
    if state.chats.running_turn(&cid).is_some() {
        return Err(AppError::Conflict("stop the running turn first".into()));
    }
    let chat = state.chats.chats.lock().unwrap().remove(&cid);
    if let Some(c) = chat {
        let _ = std::fs::remove_file(state.chats.dir.join(&c.project_id).join(format!("{cid}.json")));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct TurnBody {
    text: String,
    #[serde(default)]
    context: Option<Value>,
    /// Pasted/dropped images (base64), sent to the model with the message.
    #[serde(default)]
    images: Vec<crate::chat_images::IncomingImage>,
    /// The composer's posture for this turn (also becomes the chat's).
    #[serde(flatten)]
    posture: Posture,
    /// Start a fresh conversation from a summary of this one first (conversation_split.rs).
    #[serde(default)]
    split: bool,
}

async fn start_turn(
    State(state): State<AppState>,
    AxPath(cid): AxPath<String>,
    Json(b): Json<TurnBody>,
) -> Result<Json<Value>> {
    if b.text.trim().is_empty() && b.images.is_empty() {
        return Err(AppError::BadRequest("empty message".into()));
    }
    let chat = state.chats.get(&cid).ok_or_else(|| AppError::NotFound("chat not found".into()))?;
    let root = state.projects.folder(&chat.project_id)?;
    // One turn per chat. Chats of the same project may run at once: their tool calls take turns
    // on the files they share (agent_locks.rs), so no save overwrites another.
    if state.chats.running_turn(&cid).is_some() {
        return Err(AppError::Conflict("This chat is still working — wait for its turn to end, or stop it first.".into()));
    }
    // Store the attachments first: a turn never runs with an image silently missing.
    let images = crate::chat_images::store_images(&state.data_dir, &cid, b.images)?;
    let text = if b.text.trim().is_empty() {
        format!("Take a look at {}.", if images.len() == 1 { "this image" } else { "these images" })
    } else {
        b.text.clone()
    };
    // The composer's posture for this turn becomes the chat's.
    let chat = state.chats.update(&cid, |c| apply_posture(c, b.posture))?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    let (stop_tx, stop_rx) = oneshot::channel();
    state.chats.running.lock().unwrap().insert(
        cid.clone(),
        RunningTurn { turn_id: turn_id.clone(), stop: Some(stop_tx), stopping: false, kill: Arc::new(tokio::sync::Notify::new()), summarizing: false, mode: chat.mode.clone() },
    );
    let auth = chat.auth.clone().unwrap_or_else(|| state.settings.get().auth);
    let cache = predict_cache(&state, &chat, &auth);
    tracing::info!(
        "chat {cid}: turn starts {} — conversation {} tokens, idle {}, cache lifetime {} s{}{}",
        if cache.cold { "COLD" } else { "warm" },
        cache.context_tokens,
        cache.idle_secs.map_or("-".into(), |s| format!("{s} s")),
        cache.ttl_secs,
        if cache.ttl_learned { " (learned)" } else { " (assumed)" },
        cache.reason.as_deref().map(|r| format!(" ({r})")).unwrap_or_default(),
    );
    let turn = Turn {
        id: turn_id.clone(),
        prompt: text.clone(),
        context: b.context.clone(),
        started_at: chrono::Utc::now().to_rfc3339(),
        ended_at: None,
        status: "running".into(),
        events: Vec::new(),
        snapshot_id: None,
        changes: Vec::new(),
        reverted: None,
        cost_usd: None,
        usage: None,
        error: None,
        mode: Some(chat.mode.clone()),
        model: chat.model.clone(),
        effort: chat.effort.clone(),
        fast: chat.fast && fast_supported(chat.model.as_deref()),
        auth: Some(auth),
        images: images.iter().map(|i| i.meta.clone()).collect(),
        cache: Some(cache),
        overlapped: false,
        touched: Vec::new(),
        split: None,
        notes: Vec::new(),
    };
    let first = chat.turns.is_empty();
    state.chats.update(&cid, |c| {
        c.turns.push(turn.clone());
        if first && c.title == "New chat" {
            c.title = title_from(&text);
        }
    })?;
    // Other agents already at work here: from now on each turn's changes are only its own.
    let others = state.chats.running_in_project(&chat.project_id, &cid);
    if !others.is_empty() {
        for (oc, ot) in others.iter().chain(std::iter::once(&(cid.clone(), turn_id.clone()))) {
            state.chats.with_turn(oc, ot, |t| t.overlapped = true);
        }
    }
    state.publish(json!({ "type": "turn", "chatId": cid, "turnId": turn_id, "status": "running", "projectId": chat.project_id }));

    let (mut prompt, turn_notes) = compose_prompt(&state, &chat.project_id, &chat.id, &root, &text, b.context.as_ref());
    // The notes this turn works on are fixed now: ones pinned while it runs wait for the next message.
    state.chats.with_turn(&cid, &turn_id, |t| t.notes = turn_notes);
    if !images.is_empty() {
        prompt.push_str("Images attached to this message (also saved on disk — copy one into the project folder or onto a slide when asked to use it):\n");
        for (i, img) in images.iter().enumerate() {
            let name = img.meta.name.as_deref().map(|n| format!(" ({n})")).unwrap_or_default();
            prompt.push_str(&format!("- image {}{name}: {}\n", i + 1, img.path.display()));
        }
    }
    let attached: Vec<(String, String)> = images.into_iter().map(|i| (i.meta.media_type, i.data)).collect();
    tokio::spawn(run_turn(state.clone(), cid.clone(), turn_id.clone(), root, prompt, attached, stop_rx, b.split));
    Ok(Json(json!({ "turnId": turn_id })))
}

/// Fast mode is Opus-only: available for the Opus alias and for the CLI's
/// default (typically Opus); explicit other families can't use it.
pub fn fast_supported(model: Option<&str>) -> bool {
    match model {
        None => true,
        Some(m) => m == "opus" || m.contains("opus"),
    }
}

const AUTO_MODE_NOTICE: &str = "Auto approve: edits and shell commands run without asking. \
Revert restores files in the project folder to how they were before the turn — it can't undo \
anything a command did outside the folder.";

fn title_from(text: &str) -> String {
    let line = text.lines().next().unwrap_or("").trim();
    let mut t: String = line.chars().take(48).collect();
    if line.chars().count() > 48 {
        t.push('…');
    }
    if t.is_empty() {
        "New chat".into()
    } else {
        t
    }
}

/// The user's message plus an app-generated context block.
/// Where a chat's agent keeps its scratch scripts — its own, so agents never run each other's.
pub fn scratch_dir(chat_id: &str) -> PathBuf {
    std::env::temp_dir().join(format!("deck-edit-{}", &chat_id[..chat_id.len().min(8)]))
}

const INTERRUPTED_NOTICE: &str = "The app closed while this turn was running. Send a message (for example “continue”) to pick up where it left off.";
const INTERRUPTED_BEFORE_START: &str = "The app closed before the agent started on this message. Send it again to run it.";

/// Every turn: places in project files are written as links (the app makes them clickable).
/// Repeated here, near the message, because a long conversation's own unlinked replies outweigh
/// the system prompt.
const LINK_REMINDER: &str = "Links: write every slide, page, line or file of the project you mention as a markdown link, e.g. [Deck.pptx, slide 5](<Deck.pptx#slide=5>), [Report.pdf p. 3](<Report.pdf#page=3>), [notes.md line 12](<notes.md#line=12>), [Model.xlsx Sheet1!B4](<Model.xlsx#cell=Sheet1!B4>) — path relative to the project folder. The app makes them clickable links that open the file at that place; they work for these local files, so never say links aren't possible. In tables and lists too, and name the deck in each link (not \"same deck\").\n";

/// The prompt for a turn (the user's text and the context block), and the ids of the notes it
/// was given — the turn's notes (see `Turn::notes`).
fn compose_prompt(state: &AppState, project_id: &str, chat_id: &str, root: &Path, text: &str, ctx: Option<&Value>) -> (String, Vec<String>) {
    let mut out = String::from(text.trim());
    out.push_str("\n\n---\n[Context from the Deck Edit app — generated automatically, not typed by the user]\n");
    out.push_str(&format!("Project folder: {}\n", root.display()));
    let s = |v: Option<&Value>| v.and_then(|x| x.as_str()).unwrap_or("").to_string();
    let deck = ctx.and_then(|c| c.get("deck")).and_then(|d| d.as_str()).unwrap_or("");
    if !deck.is_empty() {
        let idx = ctx.and_then(|c| c.get("slideIndex")).and_then(|v| v.as_u64()).unwrap_or(0);
        let count = ctx.and_then(|c| c.get("slideCount")).and_then(|v| v.as_u64()).unwrap_or(0);
        let kind = if deck.to_lowercase().ends_with(".pdf") { "page" } else { "slide" };
        if idx > 0 {
            // Written as a link, the way the agent should write places (it mirrors this format).
            let frag = if kind == "page" { "page" } else { "slide" };
            out.push_str(&format!(
                "The user is viewing: [{deck}, {kind} {idx}](<{deck}#{frag}={idx}>) — {kind} {idx} of {count}{}\n",
                match s(ctx.and_then(|c| c.get("slideId"))) {
                    id if !id.is_empty() => format!(" (slideId {id})"),
                    _ => String::new(),
                }
            ));
        } else {
            out.push_str(&format!("The user has open: [{deck}](<{deck}>)\n"));
        }
        if let Some(sel) = ctx.and_then(|c| c.get("selection")).and_then(|v| v.as_array()).filter(|a| !a.is_empty()) {
            out.push_str("Selected on that slide:\n");
            for item in sel.iter().take(10) {
                let name = s(item.get("name"));
                let text = s(item.get("text"));
                if text.is_empty() {
                    out.push_str(&format!("- \"{name}\"\n"));
                } else {
                    let excerpt: String = text.chars().take(160).collect();
                    out.push_str(&format!("- \"{name}\" — text: \"{excerpt}\"\n"));
                }
            }
        }
    } else if let Some(f) = ctx.and_then(|c| c.get("openFile")).and_then(|v| v.as_str()) {
        out.push_str(&format!("The user has open: {f}\n"));
    }
    // The deck is open in the app's compare view: say so, with the differences it found.
    if let Some(cmp) = ctx.and_then(|c| c.get("compare")).filter(|c| c.is_object()) {
        let base = s(cmp.get("base"));
        let what = match s(cmp.get("baseLabel")) {
            l if !l.is_empty() => format!("its backup from {l} ({base} as it was then — not a file in the folder)"),
            _ => format!("[{base}](<{base}>)"),
        };
        out.push_str(&format!(
"The user is comparing this deck with {what} in the app's compare view (showing {}; changes marked on the slides and listed beside the thumbnails). The totals, and the differences on the slide in view (for the full list, call get_user_view):\n{}\n",
            s(cmp.get("view")),
            s(cmp.get("summary")).chars().take(6000).collect::<String>().trim_end(),
        ));
    }
    out.push_str(&format!("Scratch folder for your scripts (yours alone): {}\n", scratch_dir(chat_id).display()));
    out.push_str(LINK_REMINDER);
    let others = state.chats.running_in_project(project_id, chat_id);
    if !others.is_empty() {
        out.push_str("Other agents are working in this project at the same time (the user's other chat tabs):\n");
        for (oc, ot) in &others {
            let Some(c) = state.chats.get(oc) else { continue };
            let Some(t) = c.turns.iter().find(|t| &t.id == ot) else { continue };
            let task: String = t.prompt.chars().take(140).collect();
            let changed = if t.touched.is_empty() { String::new() } else { format!(" — changed so far: {}", t.touched.iter().take(8).cloned().collect::<Vec<_>>().join(", ")) };
            out.push_str(&format!("- “{}”: {}{changed}\n", c.title, task.trim()));
        }
        out.push_str("Your file reads and writes take turns with theirs automatically (a command may briefly wait), so no save overwrites another. Unless the user asks, don't change the files they're changing, and re-read a file right before you change it.\n");
    }
    if let Some(tabs) = ctx.and_then(|c| c.get("openTabs")).and_then(|v| v.as_array()).filter(|a| !a.is_empty()) {
        let names: Vec<&str> = tabs.iter().filter_map(|t| t.as_str()).take(20).collect();
        out.push_str(&format!("Other files open in tabs (the user may refer to them): {}\n", names.join(", ")));
    }
    if let Some(changes) = ctx.and_then(|c| c.get("userChanges")).and_then(|v| v.as_array()).filter(|a| !a.is_empty()) {
        out.push_str("Edits the user made in the app since your last turn (already saved to disk — build on them, don't undo them):\n");
        for c in changes.iter().take(40) {
            if let Some(line) = c.as_str() {
                out.push_str(&format!("- {line}\n"));
            }
        }
        if changes.len() > 40 {
            out.push_str(&format!("- …and {} more edits\n", changes.len() - 40));
        }
    }
    let notes: Vec<_> = crate::notes::with_current_index(state, project_id, state.notes.all(project_id))
        .into_iter()
        .filter(|n| n.status == "open" && n.visible_in_chat(chat_id))
        .collect();
    if !notes.is_empty() {
        out.push_str("Open notes the user pinned for this chat — on slides, PDF pages, spreadsheet cells, speaker notes, chat messages or selected text (address the ones relevant to this request; call resolve_note with a one-line summary for each note you handle). These are this turn's notes; ones the user pins while you work are for their next message:\n");
        for n in notes.iter().take(30) {
            out.push_str(&format!("- [note {}] {} (by {}): \"{}\"\n", n.id, n.describe_place(), n.author, n.text));
        }
        if notes.iter().take(30).any(|n| !n.strokes.is_empty()) {
            out.push_str("(Notes with an area were drawn freehand on the slide — the request applies to what's inside the mark. `screenshot_slide` with show_notes=true shows the marks.)\n");
        }
    }
    let ids = notes.iter().map(|n| n.id.clone()).collect();
    (out, ids)
}

pub fn system_prompt(state: &AppState) -> String {
    let python = state
        .python
        .bin()
        .map(|b| format!("`{}/python3`", b.display()))
        .unwrap_or_else(|| "`python3`".into());
    let agent_settings = state.settings.get();
    let connectors = if agent_settings.user_mcp {
        "\n- The user's own MCP servers and connectors (e.g. Slack, Google Drive) are available besides the app's tools. Use them when the user asks (e.g. to pull content from a Slack thread into a slide). Anything that sends, posts or changes something outside the project needs the user's approval unless they chose auto approve — never send messages on their behalf unless asked. (The user can turn this off in Agent settings → Your connectors.)"
    } else {
        "\n- Only the app's own tools are loaded — not the user's MCP servers / claude.ai connectors (Slack, Google Drive, Gmail, …). If a request needs one, tell the user they can turn on \"Use my MCP servers & connectors\" in Settings (gear icon, top right) → Agent settings → Your connectors; it applies from their next message."
    };
    let web = match agent_settings.web_access.as_str() {
        "off" => "\n- Web access is turned off (no web search or page fetch). If a request needs the web, say so and mention they can allow it in Agent settings → Web access.",
        "ask" => "\n- Web search and page fetches need the user's approval each time (Agent settings → Web access is \"Ask first\"); use them only when the request needs it.",
        _ => "",
    };
    format!(
        r#"You are the presentation agent inside **Deck Edit**, a desktop-style app where the user and you take turns developing slide decks (PowerPoint .pptx, and PDF) in the project folder (your working directory).

How the app works:
- The user sees the deck live: whenever a .pptx/.pdf file in the folder changes on disk, the app reloads it within a second. So edit decks IN PLACE and save to the same path — the user watches your changes appear. Save after each logical change (e.g. per slide) so progress shows up while you work.
- The user also edits slides themselves in the app (text, moving/resizing boxes and images, reordering/duplicating slides, dropping in images). Their edits are saved straight into the file before your turn; each message lists them. Re-open the file at the start of every turn and never overwrite their edits with stale state.
- The user pins notes on slides for you — either at a point, or by drawing freehand (circling or marking an area; the note then gives the area in % of the slide and the shapes it covers: focus your change there). Open notes are listed in the context block. Use the `deck` MCP tools: `list_notes`, `resolve_note` (always resolve a note you've addressed, with a one-line summary of what you did), `add_note` (leave a question/remark for the user on a slide), `get_user_view` (what the user is looking at now), `screenshot_slide` (renders a slide exactly as the app shows it — use it to check your visual result after significant layout changes) and `compare_decks` (opens the app's comparison of two versions of a deck, changes marked on the slides — another .pptx, or the deck before this turn/chat — and returns what changed per slide; use it when the user asks to compare decks or what changed).
- Before every turn the app snapshots the folder; the user can revert your whole turn with one click. You don't need to make your own backups.

Editing PowerPoint files:
- Use python-pptx (installed; run scripts with {python}). Modify the existing presentation — keep the theme, layouts, fonts, colors and positioning conventions already used in the deck. Never rebuild a deck from scratch unless asked.
- Keep the file valid for PowerPoint: don't hand-edit zip parts unless python-pptx can't do it; when duplicating slides, copy image relationships properly.
- Slide numbers the user mentions are 1-based in the current order. Notes reference slides by number and stable slideId (the p:sldId id in presentation.xml).
- Write scratch scripts to your scratch folder (named in the context block, under /tmp), not into the project folder.
- Edit files in place: never copy a deck elsewhere, change the copy over several commands and copy it back — the user, or another agent, may change the original meanwhile.
- The user's past Claude conversations (Claude Code CLI, the Claude desktop app's Code sessions, and Cowork) can be searched with the `deck` tools `search_conversations` and read with `read_conversation` (pass `query` to get just the relevant parts). When the user mentions an earlier conversation, a Cowork session, or text like `[Conversation: … — id cowork:…]`, use these instead of searching the disk yourself. Cowork output files are listed by `read_conversation`; ask before copying them into the project.
- Speaker notes are shown and edited in the app under each slide. Read/write them with python-pptx (`slide.notes_slide.notes_text_frame.text`); keep the user's notes unless asked to change them.
- Spreadsheets (.xlsx): read/write them with openpyxl (installed; same Python). The app shows them as a read-only preview. openpyxl doesn't calculate formulas — a formula you write shows as the formula in the preview (and gets its value when the user opens the file in Excel); for figures the user should see right away, also write the computed value somewhere or tell them.{connectors}{web}
- The user may keep editing while you work. In decks, their edits are held and re-applied on top of your saved version after your turn (just save normally; they're reported to you next turn). Text/Markdown files may change between your reads: if an edit fails because the file changed, re-read it and apply your change to the current text — don't overwrite theirs.
- Copying slides BETWEEN decks: the user can do it in the app (mini-slides ⌘C in one deck, ⌘V in the other — it re-creates the slide on the target's matching layout). If asked to do it yourself, add a slide on a matching layout of the target, copy the source shapes' XML into it, and copy every image they reference (with its relationship) — never modify the source deck.
- For PDFs, pymupdf (`import fitz`) and pypdf are installed.

Linking to places in the project (the user clicks a link to open the file there):
- EVERY time you mention a slide, page, line or cell of a project file, write it as a link — not only for search results: also when citing a source for a figure or claim, referring to another deck, summarizing, or mentioning it in passing. Earlier replies in this conversation may lack links; don't copy that — link from now on. Write it as a markdown link whose target is the file's path relative to the project folder plus a location: `[Deck.pptx, slide 5](Deck.pptx#slide=5)`, `[Report.pdf p. 3](Report.pdf#page=3)`, `[plan.md line 42](notes/plan.md#line=42)` (a range: `#line=42-48`), `[Model.xlsx Sheet1!B4](Model.xlsx#cell=Sheet1!B4)` (or just `#sheet=Sheet1`). With no `#…` the link just opens the file. Name the file in the link text unless the sentence already makes it obvious (then `[slide 5](…)` is fine).
- These links work for local files: the app makes them clickable. Never answer that there are no URLs or that links aren't possible — write the links.
- If the path has spaces, put it in angle brackets: `[slide 5](<Investor Deck.pptx#slide=5>)`. Slide/page numbers are 1-based in the file's current order; line numbers are in the file's source text.
- When listing several finds, link each one (e.g. a bullet per match). Keep ordinary web links as usual.

Be concise in chat: say what you changed (linked slide numbers), not how the code works."#
    )
}

async fn run_turn(
    state: AppState,
    chat_id: String,
    turn_id: String,
    root: PathBuf,
    prompt: String,
    images: Vec<(String, String)>,
    mut stop_rx: oneshot::Receiver<()>,
    split: bool,
) {
    let chat = match state.chats.get(&chat_id) {
        Some(c) => c,
        None => return,
    };
    let project_id = chat.project_id.clone();
    let turn = chat.turns.iter().find(|t| t.id == turn_id).cloned();
    let turn_mode = turn.as_ref().and_then(|t| t.mode.clone()).unwrap_or_else(|| chat.mode.clone());

    // Disclose Auto mode's reach once per conversation, not once per turn.
    if turn_mode == "auto" && !chat.auto_notice_shown {
        emit(&state, &chat_id, &turn_id, json!({"kind": "notice", "text": AUTO_MODE_NOTICE}));
        let _ = state.chats.update(&chat_id, |c| c.auto_notice_shown = true);
    }

    // 1. Snapshot the folder so the turn can be reverted.
    emit(&state, &chat_id, &turn_id, json!({"kind": "activity", "tool": "backup", "detail": "saving a backup of the folder"}));
    let (dd, pid, r2) = (state.data_dir.clone(), project_id.clone(), root.clone());
    let backup_started = std::time::Instant::now();
    // Read the folder only while no other agent is saving into it (no half-written deck in the backup).
    let backup_hold = format!("backup:{turn_id}");
    let reading_all = crate::agent_access::Access { reads: vec![root.clone()], ..Default::default() };
    let hold = crate::agent_locks::Hold::new(backup_hold.clone(), project_id.clone(), chat_id.clone(), chat.title.clone(), reading_all);
    let waited = std::sync::atomic::AtomicBool::new(false);
    let _ = state
        .locks
        .acquire(hold, &root, crate::agent_locks::MAX_WAIT, || true, |b| {
            waited.store(true, std::sync::atomic::Ordering::Relaxed);
            emit(&state, &chat_id, &turn_id, json!({"kind": "status", "text": format!("Waiting for the agent in “{}” to finish changing {} before backing up the folder…", b.chat_title, b.what)}));
        })
        .await;
    if waited.load(std::sync::atomic::Ordering::Relaxed) {
        emit(&state, &chat_id, &turn_id, json!({"kind": "status", "text": null}));
    }
    let snapshot = tokio::task::spawn_blocking(move || backups::create(&dd, &pid, &r2)).await;
    state.locks.release(&backup_hold);
    let snapshot = match snapshot {
        Ok(Ok(m)) => Some(m),
        other => {
            let msg = match other {
                Ok(Err(e)) => e.to_string(),
                Err(e) => e.to_string(),
                _ => unreachable!(),
            };
            emit(&state, &chat_id, &turn_id, json!({"kind": "notice", "text": format!("Backup failed ({msg}) — Revert won't be available for this turn.")}));
            None
        }
    };
    if let Some(m) = &snapshot {
        let id = m.id.clone();
        state.chats.with_turn(&chat_id, &turn_id, |t| t.snapshot_id = Some(id));
        // Mark the backup step finished, so the spinner moves on to the agent
        // instead of sitting on "Backup" while the model thinks.
        let n = m.files.len();
        let detail = format!(
            "saved ({n} file{}, {:.1} s)",
            if n == 1 { "" } else { "s" },
            backup_started.elapsed().as_secs_f64()
        );
        finish_activity(&state, &chat_id, &turn_id, "backup", &detail);
    }

    // 2. Run the CLI, forwarding its events.
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    let fwd_state = state.clone();
    let (fc, ft, froot) = (chat_id.clone(), turn_id.clone(), root.clone());
    let forwarder = tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            let id = ev.get("id").and_then(|v| v.as_str()).map(String::from);
            match (ev.get("kind").and_then(|k| k.as_str()), id) {
                // A tool call finished: release its file lock, credit the files it wrote to this turn.
                (Some("toolDone"), Some(id)) => {
                    if let Some(hold) = fwd_state.locks.release(&id) {
                        credit(&fwd_state, &fc, &ft, &froot, hold);
                    }
                }
                // The CLI session is known: save it now, so the chat can continue even if the app quits mid-turn.
                (Some("session"), Some(id)) => {
                    let _ = fwd_state.chats.update(&fc, |c| c.cli_session_id = Some(id));
                }
                _ => emit(&fwd_state, &fc, &ft, ev),
            }
        }
    });
    let slot: claude_cli::CliIdSlot = Arc::new(Mutex::new(chat.cli_session_id.clone()));
    let system = system_prompt(&state);
    let resume = chat.cli_session_id.clone();
    let settings = state.settings.get();
    let use_key = turn.as_ref().and_then(|t| t.auth.as_deref()) == Some("key");
    let api_key = if use_key { state.settings.api_key() } else { None };
    if use_key && api_key.is_none() {
        emit(&state, &chat_id, &turn_id, json!({"kind": "notice", "text": "API key selected, but no Anthropic key is set (Settings or ANTHROPIC_API_KEY) — running on your Claude login instead."}));
    }
    let claude_bin = state.settings.claude_bin();
    let python_bin = state.python.bin();

    // Split: continue in a fresh session that starts from a summary of this one (conversation_split.rs).
    let mut prompt = prompt;
    let mut resume = resume;
    if split {
        if let Some(prev) = resume.clone() {
            use crate::conversation_split::{carry_over, recent_turns, summarize_with_sonnet, SplitInfo, SUMMARY_INSTRUCTIONS};
            let check = turn.as_ref().and_then(|t| t.cache.clone());
            // The turn before, whose settings the old session's cache is under.
            let before = chat.turns.iter().rev().find(|t| t.id != turn_id && t.status != "running").cloned();
            let warm = check.as_ref().is_some_and(|c| c.previous_warm) && before.is_some();
            emit(&state, &chat_id, &turn_id, json!({"kind": "activity", "tool": "summary", "detail": if warm { "summarizing the conversation (from its still-warm cache)…" } else { "summarizing the conversation with Sonnet…" }}));
            state.chats.set_summarizing(&chat_id, true);
            let summarize = async {
                if let (true, Some(b)) = (warm, &before) {
                    // The same model and settings resume a throwaway copy of the session: the conversation is a cache read.
                    let (wtx, mut wrx) = mpsc::unbounded_channel::<Value>();
                    let collect = tokio::spawn(async move {
                        let mut texts = Vec::new();
                        while let Some(ev) = wrx.recv().await {
                            if ev.get("kind").and_then(|k| k.as_str()) == Some("message") {
                                texts.extend(ev.get("text").and_then(|t| t.as_str()).map(String::from));
                            }
                        }
                        texts
                    });
                    let wparams = claude_cli::TurnParams {
                        claude_bin: &claude_bin,
                        pid: None,
                        fork: true,
                        root: &root,
                        prompt: SUMMARY_INSTRUCTIONS,
                        images: &[],
                        system_prompt: &system,
                        resume: Some(&prev),
                        model: b.model.as_deref(),
                        effort: b.effort.as_deref(),
                        fast: b.fast,
                        plan: b.mode.as_deref() == Some("plan"),
                        api_key: api_key.as_deref(),
                        max_budget_usd: settings.max_budget_usd,
                        port: state.port,
                        chat_id: &chat_id,
                        token: &state.token,
                        python_bin: python_bin.as_deref(),
                        user_mcp: settings.user_mcp,
                        web_access: &settings.web_access,
                    };
                    let r = claude_cli::run(wparams, wtx, Arc::new(Mutex::new(Some(prev.clone())))).await;
                    let texts = collect.await.unwrap_or_default();
                    match (r, texts.last()) {
                        (Ok(o), Some(t)) if o.error.is_none() && t.trim().len() > 200 => return Ok((t.clone(), "warm")),
                        (r, _) => tracing::warn!("warm summary failed ({:?}) — using Sonnet", r.err().or(Some("no summary text".into()))),
                    }
                }
                summarize_with_sonnet(&claude_bin, &root, api_key.as_deref(), &prev).await.map(|s| (s, "sonnet"))
            };
            let outcome = tokio::select! {
                r = summarize => Some(r),
                _ = &mut stop_rx => None,
            };
            state.chats.set_summarizing(&chat_id, false);
            match outcome {
                Some(Ok((summary, method))) => {
                    let recent: Vec<Turn> = recent_turns(&chat.turns, &turn_id).into_iter().cloned().collect();
                    let info = SplitInfo {
                        previous_session: Some(prev.clone()),
                        previous_tokens: check.as_ref().map_or(0, |c| c.context_tokens),
                        method: method.into(),
                        summary,
                        recent_turns: recent.len(),
                    };
                    prompt = format!("{}{}", carry_over(&info, &recent.iter().collect::<Vec<_>>()), prompt);
                    resume = None;
                    *slot.lock().unwrap() = None;
                    let _ = state.chats.update(&chat_id, |c| {
                        c.cli_session_id = None;
                        if let Some(t) = c.turns.iter_mut().find(|t| t.id == turn_id) {
                            t.split = Some(info.clone());
                        }
                    });
                    let how = if method == "warm" { "from its warm cache" } else { "by Sonnet" };
                    finish_activity(&state, &chat_id, &turn_id, "summary", &format!("summarized {how} — continuing in a fresh conversation"));
                    state.publish(json!({ "type": "chatUpdated", "chatId": chat_id }));
                }
                failed => {
                    let (status, error) = match failed {
                        None => ("stopped", None),
                        Some(Err(e)) => ("error", Some(format!("Couldn't split the conversation: {e}. Your message wasn't sent — send it again (or continue without splitting)."))),
                        Some(Ok(_)) => unreachable!(),
                    };
                    if let Some(e) = &error {
                        emit(&state, &chat_id, &turn_id, json!({"kind": "error", "text": e}));
                    }
                    let _ = state.chats.update(&chat_id, |c| {
                        if let Some(t) = c.turns.iter_mut().find(|t| t.id == turn_id) {
                            t.status = status.into();
                            t.error = error.clone();
                            t.ended_at = Some(chrono::Utc::now().to_rfc3339());
                        }
                    });
                    state.locks.release_chat(&chat_id);
                    state.perms.cancel_chat(&chat_id);
                    state.chats.running.lock().unwrap().remove(&chat_id);
                    state.publish(json!({ "type": "turn", "chatId": chat_id, "turnId": turn_id, "projectId": project_id, "status": status, "changes": [] }));
                    return;
                }
            }
        } else {
            emit(&state, &chat_id, &turn_id, json!({"kind": "notice", "text": "Nothing to split yet — this chat has no earlier conversation. Sending normally."}));
        }
    }

    let cli_pid: Mutex<Option<u32>> = Mutex::new(None);
    let params = claude_cli::TurnParams {
        claude_bin: &claude_bin,
        pid: Some(&cli_pid),
        fork: false,
        root: &root,
        prompt: &prompt,
        images: &images,
        system_prompt: &system,
        resume: resume.as_deref(),
        model: turn.as_ref().and_then(|t| t.model.as_deref()),
        effort: turn.as_ref().and_then(|t| t.effort.as_deref()),
        fast: turn.as_ref().is_some_and(|t| t.fast),
        plan: turn_mode == "plan",
        api_key: api_key.as_deref(),
        max_budget_usd: settings.max_budget_usd,
        port: state.port,
        chat_id: &chat_id,
        token: &state.token,
        python_bin: python_bin.as_deref(),
        user_mcp: settings.user_mcp,
        web_access: &settings.web_access,
    };
    // Stop: note the commands the CLI is running before it goes (it's killed when `run` is dropped).
    let (result, leftover) = {
        let run = claude_cli::run(params, tx, slot.clone());
        tokio::pin!(run);
        tokio::select! {
            r = &mut run => (Some(r), Vec::new()),
            _ = &mut stop_rx => (None, cli_pid.lock().unwrap().map(crate::proc_tree::descendants).unwrap_or_default()),
        }
    };
    // A command it was running (say, a script saving a deck) is let finish — killing it mid-save would
    // break the file — while the turn keeps its file locks; the user can Kill it from the status line.
    if leftover.iter().any(|&p| crate::proc_tree::alive(p)) {
        let kill = state.chats.running.lock().unwrap().get(&chat_id).map(|r| r.kill.clone());
        emit(&state, &chat_id, &turn_id, json!({"kind": "status", "text": "Stopping — waiting for the running command to finish…", "kill": true}));
        while leftover.iter().any(|&p| crate::proc_tree::alive(p)) {
            tokio::select! {
                _ = tokio::time::sleep(std::time::Duration::from_millis(400)) => {}
                _ = async { if let Some(k) = &kill { k.notified().await } else { std::future::pending::<()>().await } } => {
                    crate::proc_tree::kill_all(&leftover);
                    emit(&state, &chat_id, &turn_id, json!({"kind": "notice", "text": "Killed the command that was still running — if it was saving a file, check that file (Revert restores the backup)."}));
                }
            }
        }
        emit(&state, &chat_id, &turn_id, json!({"kind": "status", "text": null}));
    }
    state.perms.cancel_chat(&chat_id);
    let _ = forwarder.await;
    // Locks a call never reported back on (stopped mid-call) go with the turn.
    for hold in state.locks.release_chat(&chat_id) {
        credit(&state, &chat_id, &turn_id, &root, hold);
    }

    // 3. Wrap up: status, changed files, resume token.
    let (status, error, cost, usage) = match result {
        None => ("stopped", None, None, None),
        Some(Ok(o)) => match o.error {
            Some(e) => ("error", Some(e), o.cost_usd, o.usage),
            None => ("done", None, o.cost_usd, o.usage),
        },
        Some(Err(e)) => ("error", Some(e), None, None),
    };
    // The CLI always reports a dollar figure, but it's only a real charge when
    // the turn ran on the API key; on a subscription it's notional — dropped.
    let billed_to_key = turn.as_ref().and_then(|t| t.auth.as_deref()) == Some("key") && api_key.is_some();
    let cost = cost.filter(|_| billed_to_key);
    if let Some(e) = &error {
        emit(&state, &chat_id, &turn_id, json!({"kind": "error", "text": e}));
    }
    let changes = match &snapshot {
        Some(m) => {
            let (m2, r2) = (m.clone(), root.clone());
            let all = tokio::task::spawn_blocking(move || backups::changes(&m2, &r2)).await.unwrap_or_default();
            own_changes(state.chats.get(&chat_id).and_then(|c| c.turns.into_iter().find(|t| t.id == turn_id)).as_ref(), all)
        }
        None => Vec::new(),
    };
    // How the cache prediction held up: the turn's first API call read or (re)wrote the conversation.
    if let Some(u) = &usage {
        let predicted = turn.as_ref().and_then(|t| t.cache.as_ref()).map(|c| if c.cold { "cold" } else { "warm" }).unwrap_or("-");
        let observed = crate::cache_check::observed_cold(u).map_or("unknown", |c| if c { "cold" } else { "warm" });
        tracing::info!(
            "chat {chat_id}: turn done — cache predicted {predicted}, observed {observed} (first call read {} / wrote {}); conversation now {} tokens",
            u.first_read, u.first_write, u.context
        );
    }
    let new_session = slot.lock().unwrap().clone();
    let _ = state.chats.update(&chat_id, |c| {
        if new_session.is_some() {
            c.cli_session_id = new_session;
        }
        if let Some(t) = c.turns.iter_mut().find(|t| t.id == turn_id) {
            t.status = status.into();
            t.error = error.clone();
            t.cost_usd = cost;
            t.usage = usage;
            t.changes = changes.clone();
            t.ended_at = Some(chrono::Utc::now().to_rfc3339());
        }
    });
    state.chats.running.lock().unwrap().remove(&chat_id);
    state.publish(json!({
        "type": "turn",
        "chatId": chat_id,
        "turnId": turn_id,
        "projectId": project_id,
        "status": status,
        "changes": changes,
    }));
}

async fn stop(State(state): State<AppState>, AxPath(cid): AxPath<String>) -> Json<Value> {
    let tx = state.chats.running.lock().unwrap().get_mut(&cid).and_then(|r| {
        r.stopping = true;
        r.stop.take()
    });
    let ok = tx.is_some_and(|tx| tx.send(()).is_ok());
    state.perms.cancel_chat(&cid);
    Json(json!({ "ok": ok }))
}

/// Kill the command a stopped turn is still waiting on (it may leave a half-written file — Revert has the backup).
async fn kill(State(state): State<AppState>, AxPath(cid): AxPath<String>) -> Json<Value> {
    let k = state.chats.running.lock().unwrap().get(&cid).map(|r| r.kill.clone());
    if let Some(k) = &k {
        k.notify_one();
    }
    Json(json!({ "ok": k.is_some() }))
}

fn find_turn(state: &AppState, cid: &str, tid: &str) -> Result<(Chat, Turn)> {
    let chat = state.chats.get(cid).ok_or_else(|| AppError::NotFound("chat not found".into()))?;
    let turn = chat
        .turns
        .iter()
        .find(|t| t.id == tid)
        .cloned()
        .ok_or_else(|| AppError::NotFound("turn not found".into()))?;
    Ok((chat, turn))
}

#[derive(Deserialize, Default)]
struct RevertQuery {
    /// Revert even though a later turn (another agent's) also changed some of these files.
    #[serde(default)]
    force: bool,
}

/// No agent may be working in the project while files are put back (it could be mid-save).
fn ensure_project_idle(state: &AppState, project_id: &str) -> Result<()> {
    if !state.chats.running_in_project(project_id, "").is_empty() {
        return Err(AppError::Conflict("An agent is working in this project — wait for it to finish (or stop it) before reverting.".into()));
    }
    Ok(())
}

/// The files a turn changed (both ends of a move): what its revert puts back.
fn turn_paths(turn: &Turn) -> std::collections::HashSet<String> {
    turn.changes.iter().flat_map(|c| std::iter::once(c.path.clone()).chain(c.from.clone())).collect()
}

async fn revert(
    State(state): State<AppState>,
    AxPath((cid, tid)): AxPath<(String, String)>,
    Query(q): Query<RevertQuery>,
) -> Result<Response> {
    let (chat, turn) = find_turn(&state, &cid, &tid)?;
    ensure_project_idle(&state, &chat.project_id)?;
    let sid = turn.snapshot_id.clone().ok_or_else(|| AppError::BadRequest("this turn has no backup".into()))?;
    let paths = turn_paths(&turn);
    // A later turn (any chat of the project) that changed the same files: those changes go too — ask first.
    if !q.force {
        let mut later: Vec<String> = Vec::new();
        for c in state.chats.chats.lock().unwrap().values().filter(|c| c.project_id == chat.project_id) {
            for t in c.turns.iter().filter(|t| t.id != tid && t.reverted.is_none() && t.started_at > turn.started_at) {
                let shared: Vec<&str> = t.changes.iter().map(|x| x.path.as_str()).filter(|p| paths.contains(*p)).collect();
                if !shared.is_empty() {
                    later.push(format!("{} (in “{}”)", shared.join(", "), c.title));
                }
            }
        }
        if !later.is_empty() {
            let msg = format!(
                "A later turn also changed {}. Reverting puts these files back as they were before this turn — undoing that later work too. Revert anyway?",
                later.join("; ")
            );
            return Ok((StatusCode::PRECONDITION_REQUIRED, Json(json!({ "error": msg }))).into_response());
        }
    }
    let root = state.projects.folder(&chat.project_id)?;
    let (dd, pid) = (state.data_dir.clone(), chat.project_id.clone());
    let safety = tokio::task::spawn_blocking(move || backups::restore(&dd, &pid, &sid, &root, Some(&paths)))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    state.chats.update(&cid, |c| {
        if let Some(t) = c.turns.iter_mut().find(|t| t.id == tid) {
            t.reverted = Some(safety.clone());
        }
    })?;
    state.publish(json!({ "type": "chatUpdated", "chatId": cid }));
    Ok(Json(json!({ "ok": true, "safetySnapshotId": safety })).into_response())
}

async fn unrevert(
    State(state): State<AppState>,
    AxPath((cid, tid)): AxPath<(String, String)>,
) -> Result<Json<Value>> {
    let (chat, turn) = find_turn(&state, &cid, &tid)?;
    ensure_project_idle(&state, &chat.project_id)?;
    let sid = turn.reverted.clone().ok_or_else(|| AppError::BadRequest("this turn was not reverted".into()))?;
    let paths = turn_paths(&turn);
    let root = state.projects.folder(&chat.project_id)?;
    let (dd, pid) = (state.data_dir.clone(), chat.project_id.clone());
    tokio::task::spawn_blocking(move || backups::restore(&dd, &pid, &sid, &root, Some(&paths)))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    state.chats.update(&cid, |c| {
        if let Some(t) = c.turns.iter_mut().find(|t| t.id == tid) {
            t.reverted = None;
        }
    })?;
    state.publish(json!({ "type": "chatUpdated", "chatId": cid }));
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct PathQuery {
    path: String,
}

/// A file as it was in a snapshot (the "before" of a turn).
async fn snapshot_file(
    State(state): State<AppState>,
    AxPath((id, sid)): AxPath<(String, String)>,
    Query(q): Query<PathQuery>,
) -> Result<axum::response::Response> {
    use axum::response::IntoResponse;
    let path = backups::backup_file(&state.data_dir, &id, &sid, &q.path)?;
    let bytes = tokio::fs::read(&path).await?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    // The version token of the file as it was (modified time and size, like `x-etag` on the live file).
    let etag = backups::load(&state.data_dir, &id, &sid)?
        .files
        .iter()
        .find(|f| f.rel == q.path)
        .map(|f| format!("{}-{}", f.mtime_ns, f.size))
        .unwrap_or_default();
    Ok(([(axum::http::header::CONTENT_TYPE, mime.to_string()), (axum::http::header::HeaderName::from_static("x-etag"), etag)], bytes).into_response())
}
