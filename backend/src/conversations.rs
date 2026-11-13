//! Discover, search and read the user's past Claude conversations on this
//! machine — Claude Code CLI sessions, the Claude desktop app's Code sessions,
//! and Cowork sessions — so the user (Conversations panel) and the agent
//! (`search_conversations` / `read_conversation` MCP tools) can find and reuse
//! them.
//!
//! Where they live (the apps' private storage — not a published format, so
//! everything here is read-only and parsed defensively, skipping what it
//! doesn't understand). `<config>` is Claude Code's config folder
//! (`$CLAUDE_CONFIG_DIR`, else `~/.claude`); `<desktop>` is the Claude desktop
//! app's data folder — the OS's per-user app-data folder + `Claude`:
//! `~/Library/Application Support/Claude` (macOS), `%APPDATA%\Claude` or the
//! Microsoft Store package's `LocalCache\Roaming\Claude` (Windows),
//! `$XDG_CONFIG_HOME/Claude` = `~/.config/Claude` (Linux).
//! `PDFEDIT_CLAUDE_DESKTOP_DIR` adds one more folder to look in.
//! - CLI: `<config>/projects/<cwd with separators → ->/<session>.jsonl`
//! - Desktop Code: `<desktop>/claude-code-sessions/<account>/<org>/local_<id>.json`
//!   (title, cwd, `cliSessionId`); the transcript is that CLI session's jsonl
//!   under `<config>/projects`.
//! - Cowork: `<desktop>/local-agent-mode-sessions/<account>/<org>/local_<id>.json`
//!   (title, shared folders, `cliSessionId`); transcript under
//!   `local_<id>/.claude/projects/*/<cliSessionId>.jsonl`, files it produced
//!   under `local_<id>/outputs/`.
//!
//! Transcripts are JSON lines: `{type: "user"|"assistant", message: {content:
//! string | [{type: text|tool_use|tool_result|thinking, …}]}, timestamp, …}`.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant, UNIX_EPOCH};

use axum::extract::{Path as AxPath, Query, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationInfo {
    /// `<source>:<session id>` — stable, used by the API and the agent tools.
    pub id: String,
    /// "cowork" | "desktop" | "cli"
    pub source: String,
    pub title: String,
    /// Working folder (CLI/desktop) or the folders shared with Cowork.
    pub folders: Vec<String>,
    /// Unix ms.
    pub created_at: u64,
    pub last_activity_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Set when this is one of PPTX Edit's own agent chats.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_chat: Option<String>,
    #[serde(skip)]
    pub transcript: Option<PathBuf>,
    #[serde(skip)]
    pub outputs: Option<PathBuf>,
    pub has_transcript: bool,
    pub output_count: usize,
}

#[derive(Default)]
pub struct ConversationIndex {
    cache: Mutex<Option<(Instant, Vec<ConversationInfo>)>>,
}

const CACHE_TTL: Duration = Duration::from_secs(20);
const MAX_SNIPPETS: usize = 3;

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

/// Claude Code's config folder: `$CLAUDE_CONFIG_DIR` when set, else `~/.claude`.
fn claude_config_dir_from(env: Option<String>, home: &Path) -> PathBuf {
    match env.filter(|v| !v.trim().is_empty()) {
        Some(v) => {
            let p = PathBuf::from(v.trim());
            match p.strip_prefix("~") {
                Ok(rest) => home.join(rest),
                Err(_) => p,
            }
        }
        None => home.join(".claude"),
    }
}

pub fn claude_config_dir() -> PathBuf {
    claude_config_dir_from(std::env::var("CLAUDE_CONFIG_DIR").ok(), &home())
}

/// Every Claude desktop app data folder that exists on this machine.
pub fn desktop_dirs() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(p) = std::env::var("PDFEDIT_CLAUDE_DESKTOP_DIR") {
        candidates.push(PathBuf::from(p));
    }
    // macOS: ~/Library/Application Support · Windows: %APPDATA% (Roaming) ·
    // Linux: $XDG_CONFIG_HOME or ~/.config.
    if let Some(cfg) = dirs::config_dir() {
        candidates.push(cfg.join("Claude"));
    }
    // Windows: also the local app-data folder and Microsoft Store (MSIX)
    // installs, whose AppData is virtualized under the package's LocalCache.
    if cfg!(windows) {
        if let Some(local) = dirs::data_local_dir() {
            candidates.push(local.join("Claude"));
            if let Ok(rd) = std::fs::read_dir(local.join("Packages")) {
                for e in rd.filter_map(|e| e.ok()) {
                    let name = e.file_name().to_string_lossy().to_lowercase();
                    if name.starts_with("claude") || name.contains("anthropic") {
                        candidates.push(e.path().join("LocalCache").join("Roaming").join("Claude"));
                    }
                }
            }
        }
    }
    let mut out: Vec<PathBuf> = Vec::new();
    for c in candidates {
        if c.is_dir() && !out.iter().any(|o| same_dir(o, &c)) {
            out.push(c);
        }
    }
    out
}

fn same_dir(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(x), Ok(y)) => x == y,
        _ => a == b,
    }
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

fn clip(s: &str, n: usize) -> String {
    let t = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.chars().count() <= n {
        t
    } else {
        format!("{}…", t.chars().take(n).collect::<String>())
    }
}

/// Text of a message's `content` (string or blocks): text blocks only.
fn message_text(msg: &Value) -> String {
    match msg.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The human part of a first message: tools (Code Navigator's Atlas, this
/// app) wrap the question in generated context blocks — keep the question.
fn human_part(text: &str) -> String {
    let mut t = text;
    if let Some(i) = t.find("User question:") {
        t = &t[i + "User question:".len()..];
    }
    for cut in ["\n---\n[Context from", "\n\n---\n["] {
        if let Some(i) = t.find(cut) {
            t = &t[..i];
        }
    }
    t.trim().to_string()
}

/// Is this a real human turn (not a tool result, not an injected system/command wrapper)?
fn is_human_text(text: &str) -> bool {
    let t = text.trim_start();
    !t.is_empty()
        && !t.starts_with("<command-")
        && !t.starts_with("<local-command")
        && !t.starts_with("<system-reminder>")
        && !t.starts_with("Caveat:")
}

/// First human message + first/last timestamps + cwd of a CLI transcript (reads only the head).
fn scan_head(path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    let Ok(f) = std::fs::File::open(path) else { return (None, None, None) };
    let mut first_msg = None;
    let mut cwd = None;
    let mut summary = None;
    for line in BufReader::new(f).lines().take(400).map_while(|l| l.ok()) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if cwd.is_none() {
            cwd = v.get("cwd").and_then(|c| c.as_str()).map(String::from);
        }
        if v.get("type").and_then(|t| t.as_str()) == Some("summary") && summary.is_none() {
            summary = v.get("summary").and_then(|s| s.as_str()).map(String::from);
        }
        if first_msg.is_none() && v.get("type").and_then(|t| t.as_str()) == Some("user") && !v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
            if let Some(m) = v.get("message") {
                let t = message_text(m);
                if is_human_text(&t) {
                    first_msg = Some(t);
                }
            }
        }
        if first_msg.is_some() && cwd.is_some() && summary.is_some() {
            break;
        }
    }
    (first_msg, cwd, summary)
}

fn count_files(dir: &Path) -> usize {
    walkdir::WalkDir::new(dir).into_iter().filter_map(|e| e.ok()).filter(|e| e.file_type().is_file()).count()
}

/// The agent turns run by PPTX Edit itself: CLI session id → chat title.
fn app_chats(state: &AppState) -> HashMap<String, String> {
    state.chats.cli_sessions()
}

fn discover(state: &AppState) -> Vec<ConversationInfo> {
    let mut out: Vec<ConversationInfo> = Vec::new();
    let app = app_chats(state);
    let mut claimed: HashMap<String, usize> = HashMap::new(); // cli session id → index in `out`

    // Cowork.
    let desktops = desktop_dirs();
    let cowork_metas: Vec<PathBuf> = desktops
        .iter()
        .flat_map(|d| glob_files(&d.join("local-agent-mode-sessions"), 2, "local_", ".json"))
        .collect();
    for meta in cowork_metas {
        let Some(v) = read_json(&meta) else { continue };
        let dir = meta.with_extension("");
        let cli = v.get("cliSessionId").and_then(|s| s.as_str()).unwrap_or("").to_string();
        let transcript = find_jsonl(&dir.join(".claude/projects"), &cli);
        let outputs = Some(dir.join("outputs")).filter(|p| p.is_dir());
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        let n = |k: &str| v.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
        let id = s("sessionId").unwrap_or_else(|| meta.file_stem().unwrap_or_default().to_string_lossy().into_owned());
        out.push(ConversationInfo {
            id: format!("cowork:{id}"),
            source: "cowork".into(),
            title: s("title").unwrap_or_else(|| "Untitled Cowork session".into()),
            folders: v.get("userSelectedFolders").and_then(|f| f.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            created_at: n("createdAt"),
            last_activity_at: n("lastActivityAt").max(transcript.as_deref().map(mtime_ms).unwrap_or(0)),
            first_message: s("initialMessage").map(|m| clip(&m, 300)),
            model: s("model"),
            app_chat: None,
            has_transcript: transcript.is_some(),
            output_count: outputs.as_deref().map(count_files).unwrap_or(0),
            transcript,
            outputs,
        });
    }

    // Desktop app's Code sessions (transcripts live with the CLI's).
    let cli_root = claude_config_dir().join("projects");
    let mut desktop: Vec<(Value, String)> = Vec::new();
    for meta in desktops.iter().flat_map(|d| glob_files(&d.join("claude-code-sessions"), 2, "local_", ".json")) {
        if let Some(v) = read_json(&meta) {
            let cli = v.get("cliSessionId").and_then(|s| s.as_str()).unwrap_or("").to_string();
            desktop.push((v, cli));
        }
    }

    // CLI sessions.
    for jsonl in glob_files(&cli_root, 1, "", ".jsonl") {
        let sid = jsonl.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let (first, cwd, summary) = scan_head(&jsonl);
        let last = mtime_ms(&jsonl);
        let created = std::fs::metadata(&jsonl)
            .and_then(|m| m.created())
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(last);
        let title = app
            .get(&sid)
            .cloned()
            .or(summary)
            .or_else(|| first.as_deref().map(|f| clip(&human_part(f), 80)))
            .unwrap_or_else(|| "Untitled session".into());
        claimed.insert(sid.clone(), out.len());
        out.push(ConversationInfo {
            id: format!("cli:{sid}"),
            source: "cli".into(),
            title,
            folders: cwd.into_iter().collect(),
            created_at: created,
            last_activity_at: last,
            first_message: first.map(|f| clip(&human_part(&f), 300)),
            model: None,
            app_chat: app.get(&sid).cloned(),
            has_transcript: true,
            output_count: 0,
            transcript: Some(jsonl),
            outputs: None,
        });
    }

    // A desktop Code session relabels its CLI transcript (title, source).
    for (v, cli) in desktop {
        let s = |k: &str| v.get(k).and_then(|x| x.as_str()).map(String::from);
        if let Some(&i) = claimed.get(&cli) {
            let c = &mut out[i];
            c.source = "desktop".into();
            c.id = format!("desktop:{cli}");
            if let Some(t) = s("title").filter(|t| !t.trim().is_empty()) {
                c.title = t;
            }
            c.model = s("model");
        }
    }

    // Hide empty shells (a CLI session that never got a human message).
    out.retain(|c| c.source != "cli" || c.first_message.is_some() || c.app_chat.is_some());
    out.sort_by(|a, b| b.last_activity_at.cmp(&a.last_activity_at));
    out
}

/// Files named `<prefix>*<suffix>` exactly `depth` directories below `root`
/// (plus `root` itself when depth is 0) — skipping our own skill plugin dirs.
fn glob_files(root: &Path, depth: usize, prefix: &str, suffix: &str) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root)
        .min_depth(depth + 1)
        .max_depth(depth + 1)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.into_path())
        .filter(|p| !p.components().any(|c| c.as_os_str() == "skills-plugin"))
        .filter(|p| {
            let n = p.file_name().unwrap_or_default().to_string_lossy();
            n.starts_with(prefix) && n.ends_with(suffix)
        })
        .collect()
}

fn find_jsonl(projects: &Path, session: &str) -> Option<PathBuf> {
    let mut any = None;
    for e in walkdir::WalkDir::new(projects).max_depth(2).into_iter().filter_map(|e| e.ok()) {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "jsonl") {
            if !session.is_empty() && p.file_stem().is_some_and(|s| s == session) {
                return Some(p.to_path_buf());
            }
            any.get_or_insert_with(|| p.to_path_buf());
        }
    }
    any
}

impl ConversationIndex {
    pub fn list(&self, state: &AppState) -> Vec<ConversationInfo> {
        let mut cache = self.cache.lock().unwrap();
        if let Some((at, list)) = cache.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return list.clone();
            }
        }
        let list = discover(state);
        *cache = Some((Instant::now(), list.clone()));
        list
    }

    pub fn get(&self, state: &AppState, id: &str) -> Result<ConversationInfo> {
        self.list(state)
            .into_iter()
            .find(|c| c.id == id || c.id.split_once(':').map(|x| x.1) == Some(id))
            .ok_or_else(|| AppError::NotFound(format!("conversation {id} not found")))
    }
}

// ─── reading & searching transcripts ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptMessage {
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
    /// One-line summaries of tool calls made in this message.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tools: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
}

fn tool_summary(b: &Value) -> String {
    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
    let input = b.get("input").cloned().unwrap_or(Value::Null);
    let detail = ["file_path", "path", "command", "pattern", "query", "url", "description"]
        .iter()
        .find_map(|k| input.get(*k).and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_default();
    if detail.is_empty() {
        name.to_string()
    } else {
        format!("{name}: {}", clip(&detail, 140))
    }
}

/// The readable conversation: human messages and assistant text, tool calls as
/// one-liners; tool results, thinking and subagent (sidechain) lines dropped.
pub fn read_transcript(path: &Path) -> Vec<TranscriptMessage> {
    let Ok(f) = std::fs::File::open(path) else { return Vec::new() };
    let mut out: Vec<TranscriptMessage> = Vec::new();
    for line in BufReader::new(f).lines().map_while(|l| l.ok()) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v.get("isSidechain").and_then(|b| b.as_bool()).unwrap_or(false) {
            continue;
        }
        let role = match v.get("type").and_then(|t| t.as_str()) {
            Some(r @ ("user" | "assistant")) => r.to_string(),
            _ => continue,
        };
        let Some(msg) = v.get("message") else { continue };
        let text = message_text(msg);
        let tools: Vec<String> = msg
            .get("content")
            .and_then(|c| c.as_array())
            .map(|a| a.iter().filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_use")).map(tool_summary).collect())
            .unwrap_or_default();
        if role == "user" && !is_human_text(&text) {
            continue;
        }
        if text.trim().is_empty() && tools.is_empty() {
            continue;
        }
        let ts = v.get("timestamp").and_then(|t| t.as_str()).map(String::from);
        // Consecutive assistant lines (streamed blocks) merge into one message.
        if let Some(last) = out.last_mut() {
            if last.role == "assistant" && role == "assistant" {
                if !text.trim().is_empty() {
                    if !last.text.is_empty() {
                        last.text.push_str("\n\n");
                    }
                    last.text.push_str(text.trim());
                }
                last.tools.extend(tools);
                continue;
            }
        }
        out.push(TranscriptMessage { role, text: text.trim().to_string(), tools, timestamp: ts });
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snippet {
    pub role: String,
    pub text: String,
    /// Index of the message in `read_transcript` order.
    pub message: usize,
}

/// Snippets around each match of `needle` (lowercase) in the readable transcript.
fn search_transcript(path: &Path, needle: &str, max: usize) -> Vec<Snippet> {
    // Cheap pre-check on the raw file before parsing it.
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    if !raw.to_lowercase().contains(needle) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for (i, m) in read_transcript(path).iter().enumerate() {
        let lower = m.text.to_lowercase();
        if let Some(pos) = lower.find(needle) {
            let chars: Vec<char> = m.text.chars().collect();
            let cpos = lower[..pos].chars().count();
            let start = cpos.saturating_sub(90);
            let end = (cpos + needle.chars().count() + 140).min(chars.len());
            let mut text: String = chars[start..end].iter().collect();
            text = text.split_whitespace().collect::<Vec<_>>().join(" ");
            if start > 0 {
                text = format!("…{text}");
            }
            if end < chars.len() {
                text.push('…');
            }
            out.push(Snippet { role: m.role.clone(), text, message: i });
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    #[serde(flatten)]
    pub info: ConversationInfo,
    pub snippets: Vec<Snippet>,
}

/// Conversations whose title / folders / first message — or transcript text — contain every word of `query`.
pub fn search(state: &AppState, query: &str, source: Option<&str>, limit: usize) -> Vec<SearchHit> {
    let list = state.conversations.list(state);
    let q = query.trim().to_lowercase();
    let words: Vec<&str> = q.split_whitespace().collect();
    let mut hits = Vec::new();
    for c in list {
        if source.is_some_and(|s| !s.is_empty() && s != c.source) {
            continue;
        }
        if words.is_empty() {
            hits.push(SearchHit { info: c, snippets: Vec::new() });
        } else {
            let meta = format!("{} {} {}", c.title, c.folders.join(" "), c.first_message.as_deref().unwrap_or("")).to_lowercase();
            let meta_hit = words.iter().all(|w| meta.contains(w));
            // Snippets for the whole phrase, else for the first word that occurs.
            let snippets = c
                .transcript
                .as_deref()
                .map(|p| {
                    let s = search_transcript(p, &q, MAX_SNIPPETS);
                    if s.is_empty() && words.len() > 1 { search_transcript(p, words[0], MAX_SNIPPETS) } else { s }
                })
                .unwrap_or_default();
            let text_hit = !snippets.is_empty()
                && (words.len() == 1 || snippets.iter().any(|s| s.text.to_lowercase().contains(&q)) || {
                    let raw = c.transcript.as_deref().and_then(|p| std::fs::read_to_string(p).ok()).unwrap_or_default().to_lowercase();
                    words.iter().all(|w| raw.contains(w))
                });
            if meta_hit || text_hit {
                hits.push(SearchHit { info: c, snippets });
            }
        }
        if hits.len() >= limit {
            break;
        }
    }
    hits
}

/// Where conversations were looked for on this machine, and what was found —
/// so a user can see at a glance whether their Claude apps were detected.
pub fn sources(state: &AppState) -> Value {
    let list = state.conversations.list(state);
    let count = |s: &str| list.iter().filter(|c| c.source == s).count();
    let config = claude_config_dir();
    json!({
        "claudeCode": { "path": config.join("projects"), "found": config.join("projects").is_dir(), "sessions": count("cli") },
        "desktopApp": {
            "paths": desktop_dirs(),
            "found": !desktop_dirs().is_empty(),
            "codeSessions": count("desktop"),
            "coworkSessions": count("cowork"),
        },
    })
}

// ─── routes ──────────────────────────────────────────────────────────────────

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/conversations", get(list))
        .route("/conversations-sources", get(sources_route))
        .route("/conversations/{id}", get(read))
        .route("/conversations/{id}/import", post(import_output))
}

async fn sources_route(State(state): State<AppState>) -> Result<Json<Value>> {
    let st = state.clone();
    tokio::task::spawn_blocking(move || sources(&st)).await.map(Json).map_err(|e| AppError::Internal(e.to_string()))
}

#[derive(Deserialize)]
struct ListQuery {
    q: Option<String>,
    source: Option<String>,
    limit: Option<usize>,
}

async fn list(State(state): State<AppState>, Query(q): Query<ListQuery>) -> Result<Json<Vec<SearchHit>>> {
    let st = state.clone();
    let hits = tokio::task::spawn_blocking(move || {
        search(&st, q.q.as_deref().unwrap_or(""), q.source.as_deref(), q.limit.unwrap_or(200))
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(hits))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputFile {
    /// Path relative to the session's outputs folder.
    pub path: String,
    pub size: u64,
}

fn outputs_of(c: &ConversationInfo) -> Vec<OutputFile> {
    let Some(dir) = c.outputs.as_deref() else { return Vec::new() };
    walkdir::WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter_map(|e| {
            let rel = e.path().strip_prefix(dir).ok()?.to_string_lossy().into_owned();
            Some(OutputFile { path: rel, size: e.metadata().map(|m| m.len()).unwrap_or(0) })
        })
        .collect()
}

pub fn read_json_value(state: &AppState, id: &str) -> Result<Value> {
    let c = state.conversations.get(state, id)?;
    let messages = c.transcript.as_deref().map(read_transcript).unwrap_or_default();
    let outputs = outputs_of(&c);
    Ok(json!({ "info": c, "messages": messages, "outputs": outputs, "transcriptPath": c.transcript }))
}

async fn read(State(state): State<AppState>, AxPath(id): AxPath<String>) -> Result<Json<Value>> {
    let st = state.clone();
    tokio::task::spawn_blocking(move || read_json_value(&st, &id))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map(Json)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportBody {
    project_id: String,
    /// Path inside the session's outputs folder.
    path: String,
}

/// Copy a file a Cowork session produced into a project folder (never overwrites).
async fn import_output(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Json(b): Json<ImportBody>,
) -> Result<Json<Value>> {
    let c = state.conversations.get(&state, &id)?;
    let dir = c.outputs.clone().ok_or_else(|| AppError::BadRequest("this conversation has no output files".into()))?;
    let src = crate::files::resolve_under(&dir, &b.path)?;
    if !src.is_file() {
        return Err(AppError::NotFound(format!("{} not found", b.path)));
    }
    let root = state.projects.folder(&b.project_id)?;
    let name = src.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let dst = crate::files::unique_path(&root.join(&name));
    std::fs::copy(&src, &dst)?;
    let rel = dst.strip_prefix(&root).map(|p| p.to_string_lossy().into_owned()).unwrap_or(name);
    Ok(Json(json!({ "path": rel })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_config_dir_honors_env() {
        let home = Path::new("/home/ann");
        assert_eq!(claude_config_dir_from(None, home), home.join(".claude"));
        assert_eq!(claude_config_dir_from(Some("  ".into()), home), home.join(".claude"));
        assert_eq!(claude_config_dir_from(Some("/data/claude".into()), home), PathBuf::from("/data/claude"));
        assert_eq!(claude_config_dir_from(Some("~/alt-claude".into()), home), home.join("alt-claude"));
    }

    #[test]
    fn transcript_reading_and_search() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("s.jsonl");
        let lines = [
            json!({"type":"user","message":{"role":"user","content":"Make an investor deck about Togo"},"timestamp":"t1"}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"Drafting the deck."},{"type":"tool_use","name":"Bash","input":{"command":"python3 make.py"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"Saved investor-deck.pptx."}]}}),
            json!({"type":"user","isSidechain":true,"message":{"content":"subagent noise"}}),
        ];
        std::fs::write(&p, lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n")).unwrap();
        let msgs = read_transcript(&p);
        assert_eq!(msgs.len(), 2, "tool results and sidechains dropped, assistant lines merged");
        assert_eq!(msgs[1].tools, vec!["Bash: python3 make.py"]);
        assert!(msgs[1].text.contains("Saved investor-deck.pptx"));
        assert_eq!(human_part("[Canvas context]\n- x\n---\nUser question: find my deck\n"), "find my deck");
        assert_eq!(human_part("Fix slide 3\n\n---\n[Context from the PPTX Edit app — …]"), "Fix slide 3");
        let hits = search_transcript(&p, "togo", 3);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].role, "user");
        assert!(search_transcript(&p, "subagent", 3).is_empty());
    }
}
