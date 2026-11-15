//! The Claude Code CLI engine: one headless `claude -p … --output-format
//! stream-json` run per chat turn, in the project folder, and the mapping of its
//! newline-delimited JSON stream onto the chat events the panel renders.
//!
//! Adapted (and much simplified) from ma-code-navigator's `agent_session`:
//! - text deltas (`--include-partial-messages`) → `delta` (the live draft);
//!   completed text blocks → `message`
//! - Bash tool calls → `activity`, their results → `command`
//! - Edit/Write → `fileEdited` once the tool result confirms it
//! - TodoWrite → `todos`; other tools → `activity`
//! - the final `result` line → cost + the CLI session id, persisted so the
//!   next turn continues the same conversation (`--resume`).
//!
//! Mutating tools (Edit/Write/Bash) are NOT allow-listed: a PreToolUse hook
//! relays each one to `POST /api/agent/hook`, which applies the chat's approval
//! mode (see `permissions.rs`). If the relay is unreachable the CLI falls back
//! to its own permission system, which denies them — failing closed.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
use tokio::sync::mpsc::UnboundedSender;

pub type EventSink = UnboundedSender<Value>;
pub type CliIdSlot = Arc<Mutex<Option<String>>>;

/// Kill a turn only after this much silence on stdout (a parked permission
/// card is silent by design, so this must exceed the hook timeout).
const IDLE_TIMEOUT_SECS: u64 = 900;
const HOOK_TIMEOUT_SECS: u64 = 600;
const OUTPUT_CAP: usize = 4000;

/// Read-only + bookkeeping tools the CLI may use without asking.
const ALLOWED_TOOLS: &[&str] = &[
    "Read", "Grep", "Glob", "TodoWrite", "WebSearch", "WebFetch", "BashOutput", "KillShell", "Skill", "Task",
    "mcp__deck",
];

pub const GATED_TOOLS: &str = "Edit|Write|MultiEdit|NotebookEdit|Bash";
const WEB_TOOLS: [&str; 2] = ["WebSearch", "WebFetch"];

/// Tools that go through the approval hook: edits and commands always; every
/// MCP tool when the user's own servers/connectors are loaded (the app's own
/// `mcp__deck__*` tools are let through by the hook); web tools on "ask".
pub fn gated_tools(user_mcp: bool, web_access: &str) -> String {
    let mut m = GATED_TOOLS.to_string();
    if user_mcp {
        m.push_str("|mcp__.*");
    }
    if web_access == "ask" {
        m.push_str("|WebSearch|WebFetch");
    }
    m
}

pub struct TurnParams<'a> {
    /// The `claude` command (Settings → Claude Code CLI path).
    pub claude_bin: &'a str,
    pub root: &'a Path,
    pub prompt: &'a str,
    /// (media type, base64) images for the message. Non-empty switches the
    /// prompt to a stream-json message on stdin — the only headless path that
    /// carries image content.
    pub images: &'a [(String, String)],
    pub system_prompt: &'a str,
    pub resume: Option<&'a str>,
    pub model: Option<&'a str>,
    /// `--effort low|medium|high|xhigh|max`; None = the model's own.
    pub effort: Option<&'a str>,
    /// Fast mode (Opus only). Headless `-p` ignores the user's saved
    /// `fastMode`, so it rides the inline `--settings`.
    pub fast: bool,
    /// Plan mode: the CLI's own `--permission-mode plan` (read-only turn; the
    /// plan arrives as the final message).
    pub plan: bool,
    /// Run on this Anthropic API key instead of the CLI's own login.
    pub api_key: Option<&'a str>,
    pub max_budget_usd: Option<f64>,
    pub port: u16,
    pub chat_id: &'a str,
    pub token: &'a str,
    pub python_bin: Option<&'a Path>,
    /// Load the user's own MCP servers / claude.ai connectors too (Settings).
    pub user_mcp: bool,
    /// "allow" | "ask" | "off" (Settings).
    pub web_access: &'a str,
}

/// Token counts the CLI reports for a turn (from the final `result` line).
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    /// All input tokens, including the cached part.
    pub input: u64,
    /// The part of `input` served from (or written to) the prompt cache.
    pub cached: u64,
    pub output: u64,
}

pub struct TurnOutcome {
    pub usage: Option<TokenUsage>,
    pub cost_usd: Option<f64>,
    pub error: Option<String>,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn settings_json(port: u16, chat_id: &str, token: &str, fast: bool, matcher: &str) -> String {
    let url = format!("http://127.0.0.1:{port}/api/agent/hook?chat={chat_id}");
    let header = shell_quote(&format!("X-PdfEdit-Token: {token}"));
    let command = format!(
        "curl -sS -m {} -X POST -H 'Content-Type: application/json' -H {header} --data-binary @- {}",
        HOOK_TIMEOUT_SECS + 30,
        shell_quote(&url)
    );
    let mut settings = json!({
        "hooks": {
            "PreToolUse": [{
                "matcher": matcher,
                "hooks": [{ "type": "command", "command": command, "timeout": HOOK_TIMEOUT_SECS }]
            }]
        }
    });
    if fast {
        settings["fastMode"] = json!(true);
    }
    settings.to_string()
}

fn mcp_config(port: u16, chat_id: &str, token: &str) -> String {
    json!({
        "mcpServers": {
            "deck": {
                "type": "http",
                "url": format!("http://127.0.0.1:{port}/api/mcp?chat={chat_id}"),
                "headers": { "X-PdfEdit-Token": token },
            }
        }
    })
    .to_string()
}

pub fn build_command(p: &TurnParams<'_>) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(p.claude_bin);
    cmd.current_dir(p.root).arg("-p");
    if p.images.is_empty() {
        cmd.arg(p.prompt);
    } else {
        cmd.args(["--input-format", "stream-json"]);
    }
    cmd.args(["--output-format", "stream-json", "--verbose", "--include-partial-messages"])
        .args(["--permission-mode", if p.plan { "plan" } else { "default" }])
        // Only the user's own settings: a folder's .claude/settings.json must
        // not inject hooks into our turns.
        .args(["--setting-sources", "user"])
        .args(["--append-system-prompt", p.system_prompt])
        .arg("--allowedTools")
        // Web tools are pre-approved only on "allow" ("ask" routes them through the hook).
        .args(ALLOWED_TOOLS.iter().filter(|t| p.web_access == "allow" || !WEB_TOOLS.contains(t)))
        .args(["--mcp-config", &mcp_config(p.port, p.chat_id, p.token)])
        .args(["--settings", &settings_json(p.port, p.chat_id, p.token, p.fast, &gated_tools(p.user_mcp, p.web_access))])
        .stdin(if p.images.is_empty() { Stdio::null() } else { Stdio::piped() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("MCP_TOOL_TIMEOUT", "120000")
        .kill_on_drop(true);
    // Only the app's own tools, unless the user opted into their MCP servers / connectors.
    if !p.user_mcp {
        cmd.arg("--strict-mcp-config");
    }
    if p.web_access == "off" {
        cmd.arg("--disallowedTools").args(WEB_TOOLS);
    }
    if let Some(id) = p.resume {
        cmd.args(["--resume", id]);
    }
    if let Some(m) = p.model.filter(|m| !m.is_empty()) {
        cmd.args(["--model", m]);
    }
    if let Some(e) = p.effort.filter(|e| !e.is_empty()) {
        cmd.args(["--effort", e]);
    }
    if let Some(b) = p.max_budget_usd.filter(|b| *b > 0.0) {
        cmd.args(["--max-budget-usd", &b.to_string()]);
    }
    // Put the app's Python env (python-pptx, pymupdf, pypdf) first on PATH.
    if let Some(bin) = p.python_bin {
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{path}", bin.display()));
        if let Some(venv) = bin.parent() {
            cmd.env("VIRTUAL_ENV", venv);
        }
    }
    // Auth: the API key when chosen; otherwise the CLI's own login — which only
    // takes effect if no key is visible to the child.
    match p.api_key {
        Some(key) => {
            cmd.env("ANTHROPIC_API_KEY", key);
        }
        None => {
            cmd.env_remove("ANTHROPIC_API_KEY");
            cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
        }
    }
    cmd
}

/// The turn's one stream-json input line: the prompt text, then the images
/// as base64 image blocks in the order they were attached.
pub fn user_message(prompt: &str, images: &[(String, String)]) -> String {
    let mut content = vec![json!({ "type": "text", "text": prompt })];
    content.extend(images.iter().map(|(media_type, data)| {
        json!({ "type": "image", "source": { "type": "base64", "media_type": media_type, "data": data } })
    }));
    json!({ "type": "user", "message": { "role": "user", "content": content } }).to_string()
}

fn truncate(s: &str, cap: usize) -> String {
    if s.len() <= cap {
        return s.to_string();
    }
    let mut end = cap;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…(truncated)", &s[..end])
}

fn summarize_input(input: &Value) -> String {
    for key in ["file_path", "path", "command", "pattern", "query", "url", "description", "deck"] {
        if let Some(v) = input.get(key) {
            return match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
        }
    }
    String::new()
}

fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[derive(Default)]
pub struct StreamState {
    pub cli_session_id: CliIdSlot,
    pub cost_usd: Option<f64>,
    pub usage: Option<TokenUsage>,
    pending_bash: HashMap<String, String>,
    pending_edits: HashMap<String, String>,
    last_text: String,
    pub result_error: Option<String>,
    pub saw_result: bool,
}

fn rel_to_root(path: &str, root: &Path) -> String {
    let p = Path::new(path);
    if p.is_absolute() {
        // Compare canonical forms: macOS /tmp vs /private/tmp etc.
        let canon = p.parent().and_then(|d| d.canonicalize().ok()).map(|d| d.join(p.file_name().unwrap_or_default()));
        for candidate in [Some(p.to_path_buf()), canon].into_iter().flatten() {
            if let Ok(rel) = candidate.strip_prefix(root) {
                return rel.to_string_lossy().into_owned();
            }
        }
        path.to_string()
    } else {
        path.to_string()
    }
}

/// Map one stream-json line onto chat events.
pub fn handle_line(line: &Value, root: &Path, sink: &EventSink, st: &mut StreamState) {
    // Lines from a subagent's own conversation: summarize as activity only.
    let in_subagent = line.get("parent_tool_use_id").and_then(|p| p.as_str()).is_some();
    match line.get("type").and_then(|t| t.as_str()) {
        Some("system") => {
            if let Some(id) = line.get("session_id").and_then(|s| s.as_str()) {
                *st.cli_session_id.lock().unwrap() = Some(id.to_string());
            }
            if line.get("subtype").and_then(|s| s.as_str()) == Some("api_retry") {
                let _ = sink.send(json!({"kind": "activity", "tool": "api", "detail": "provider hiccup — retrying"}));
            }
        }
        Some("stream_event") => {
            if in_subagent {
                return;
            }
            let event = line.get("event");
            match event.and_then(|e| e.get("type")).and_then(|t| t.as_str()) {
                Some("content_block_delta") => {
                    if let Some(text) = event
                        .and_then(|e| e.get("delta"))
                        .filter(|d| d.get("type").and_then(|t| t.as_str()) == Some("text_delta"))
                        .and_then(|d| d.get("text"))
                        .and_then(|t| t.as_str())
                        .filter(|t| !t.is_empty())
                    {
                        let _ = sink.send(json!({"kind": "delta", "text": text}));
                    }
                }
                Some("content_block_start") => {
                    let kind = event
                        .and_then(|e| e.get("content_block"))
                        .and_then(|c| c.get("type"))
                        .and_then(|t| t.as_str());
                    if kind == Some("thinking") {
                        let _ = sink.send(json!({"kind": "thinking"}));
                    }
                }
                _ => {}
            }
        }
        Some("assistant") => {
            let blocks = line.pointer("/message/content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            for block in blocks {
                match block.get("type").and_then(|t| t.as_str()) {
                    Some("text") if !in_subagent => {
                        let text = block.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        if !text.trim().is_empty() {
                            st.last_text = text.to_string();
                            let _ = sink.send(json!({"kind": "message", "text": text}));
                        }
                    }
                    Some("tool_use") => {
                        let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("");
                        let input = block.get("input").cloned().unwrap_or(Value::Null);
                        let id = block.get("id").and_then(|i| i.as_str()).unwrap_or("").to_string();
                        handle_tool_use(name, &input, &id, root, in_subagent, sink, st);
                    }
                    _ => {}
                }
            }
        }
        Some("user") => {
            let blocks = line.pointer("/message/content").and_then(|c| c.as_array()).cloned().unwrap_or_default();
            for block in blocks {
                if block.get("type").and_then(|t| t.as_str()) != Some("tool_result") {
                    continue;
                }
                let Some(id) = block.get("tool_use_id").and_then(|i| i.as_str()) else { continue };
                let is_error = block.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
                if let Some(path) = st.pending_edits.remove(id) {
                    if !is_error {
                        let _ = sink.send(json!({"kind": "fileEdited", "path": path}));
                    }
                    continue;
                }
                if let Some(command) = st.pending_bash.remove(id) {
                    let text = block.get("content").map(tool_result_text).unwrap_or_default();
                    // A relay-denied command never ran; the denial is already shown.
                    if is_error && text.contains("hook") && text.to_lowercase().contains("denied") {
                        continue;
                    }
                    let _ = sink.send(json!({
                        "kind": "command",
                        "command": command,
                        "exitCode": if is_error { 1 } else { 0 },
                        "output": truncate(text.trim(), OUTPUT_CAP),
                    }));
                }
            }
        }
        Some("result") => {
            st.saw_result = true;
            if let Some(id) = line.get("session_id").and_then(|s| s.as_str()) {
                *st.cli_session_id.lock().unwrap() = Some(id.to_string());
            }
            st.cost_usd = line.get("total_cost_usd").and_then(|v| v.as_f64());
            if let Some(u) = line.get("usage") {
                let n = |k: &str| u.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                let cached = n("cache_read_input_tokens") + n("cache_creation_input_tokens");
                st.usage = Some(TokenUsage { input: n("input_tokens") + cached, cached, output: n("output_tokens") });
            }
            let subtype = line.get("subtype").and_then(|s| s.as_str()).unwrap_or("");
            let is_error = line.get("is_error").and_then(|e| e.as_bool()).unwrap_or(false);
            let text = line.get("result").and_then(|r| r.as_str()).unwrap_or("").to_string();
            if subtype != "success" || is_error {
                st.result_error = Some(if text.trim().is_empty() {
                    format!("Agent turn failed ({subtype})")
                } else {
                    text
                });
            } else if !text.trim().is_empty() && text != st.last_text {
                let _ = sink.send(json!({"kind": "message", "text": text}));
            }
        }
        _ => {}
    }
}

fn handle_tool_use(
    name: &str,
    input: &Value,
    id: &str,
    root: &Path,
    in_subagent: bool,
    sink: &EventSink,
    st: &mut StreamState,
) {
    match name {
        "Edit" | "MultiEdit" | "Write" | "NotebookEdit" => {
            let path = input
                .get("file_path")
                .or_else(|| input.get("notebook_path"))
                .and_then(|p| p.as_str())
                .unwrap_or("");
            let rel = rel_to_root(path, root);
            let _ = sink.send(json!({"kind": "activity", "tool": name, "detail": rel}));
            if !id.is_empty() {
                st.pending_edits.insert(id.to_string(), rel);
            }
        }
        "Bash" => {
            let command = input.get("command").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let desc = input.get("description").and_then(|c| c.as_str()).unwrap_or("");
            let _ = sink.send(json!({
                "kind": "activity",
                "tool": "Bash",
                "detail": if desc.is_empty() { command.clone() } else { desc.to_string() },
            }));
            if !id.is_empty() {
                st.pending_bash.insert(id.to_string(), command);
            }
        }
        "TodoWrite" if !in_subagent => {
            let items: Vec<Value> = input
                .get("todos")
                .and_then(|t| t.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| {
                            Some(json!({
                                "text": t.get("content").and_then(|c| c.as_str())?,
                                "status": t.get("status").and_then(|s| s.as_str()).unwrap_or("pending"),
                            }))
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !items.is_empty() {
                let _ = sink.send(json!({"kind": "todos", "items": items}));
            }
        }
        other => {
            let display = other.strip_prefix("mcp__deck__").unwrap_or(other);
            let _ = sink.send(json!({"kind": "activity", "tool": display, "detail": summarize_input(input)}));
        }
    }
}

/// Spawn the CLI and stream its events to `sink` until it exits.
pub async fn run(p: TurnParams<'_>, sink: EventSink, slot: CliIdSlot) -> Result<TurnOutcome, String> {
    let root: PathBuf = p.root.to_path_buf();
    let mut cmd = build_command(&p);
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("The Claude Code CLI (`{}`) was not found. Install it from https://claude.com/claude-code and run `claude login`, or set its path in Settings.", p.claude_bin)
        } else {
            format!("failed to start claude: {e}")
        }
    })?;
    // Deliver the image message off-thread (it can be megabytes of base64) and
    // close stdin — EOF tells the CLI no further input is coming.
    if !p.images.is_empty() {
        if let Some(mut stdin) = child.stdin.take() {
            let message = user_message(p.prompt, p.images);
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let _ = stdin.write_all(message.as_bytes()).await;
                let _ = stdin.write_all(b"\n").await;
                let _ = stdin.shutdown().await;
            });
        }
    }
    let stdout = child.stdout.take().ok_or("claude: no stdout")?;
    let mut stderr = child.stderr.take().ok_or("claude: no stderr")?;
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) if buf.len() < 8192 => buf.extend_from_slice(&chunk[..n]),
                Ok(_) => {}
            }
        }
        String::from_utf8_lossy(&buf).into_owned()
    });

    let mut st = StreamState { cli_session_id: slot, ..Default::default() };
    let mut lines = BufReader::new(stdout).lines();
    let mut idle = false;
    loop {
        match tokio::time::timeout(Duration::from_secs(IDLE_TIMEOUT_SECS), lines.next_line()).await {
            Ok(Ok(Some(line))) => {
                if let Ok(v) = serde_json::from_str::<Value>(&line) {
                    handle_line(&v, &root, &sink, &mut st);
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(format!("claude: {e}")),
            Err(_) => {
                idle = true;
                break;
            }
        }
    }
    if idle {
        let _ = child.kill().await;
        return Ok(TurnOutcome {
            usage: st.usage,
            cost_usd: st.cost_usd,
            error: Some(format!(
                "The agent produced no output for {} minutes and was stopped. Send a follow-up to continue.",
                IDLE_TIMEOUT_SECS / 60
            )),
        });
    }
    let status = child.wait().await.map_err(|e| format!("claude: {e}"))?;
    if st.result_error.is_none() && !status.success() && !st.saw_result {
        let err = stderr_task.await.unwrap_or_default();
        let err = err.trim();
        let low = err.to_lowercase();
        if low.contains("login") || low.contains("authenticat") || low.contains("api key") {
            return Err(format!("Claude Code isn't logged in: run `claude login` in a terminal, then retry. ({err})"));
        }
        return Err(format!(
            "claude exited with {}{}{}",
            status.code().map_or("?".to_string(), |c| c.to_string()),
            if err.is_empty() { "" } else { ": " },
            err
        ));
    }
    Ok(TurnOutcome { usage: st.usage, cost_usd: st.cost_usd, error: st.result_error })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn drain(rx: &mut mpsc::UnboundedReceiver<Value>) -> Vec<Value> {
        let mut v = Vec::new();
        while let Ok(e) = rx.try_recv() {
            v.push(e);
        }
        v
    }

    #[test]
    fn maps_a_turn() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let mut st = StreamState::default();
        let root = Path::new("/tmp/proj");
        handle_line(&json!({"type":"system","subtype":"init","session_id":"s1"}), root, &tx, &mut st);
        assert_eq!(st.cli_session_id.lock().unwrap().as_deref(), Some("s1"));
        handle_line(
            &json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"Updating slide 3."},
                {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"python3 edit.py","description":"Edit deck"}},
                {"type":"tool_use","id":"t2","name":"Write","input":{"file_path":"/tmp/proj/notes.md","content":"x"}}
            ]}}),
            root,
            &tx,
            &mut st,
        );
        handle_line(
            &json!({"type":"user","message":{"content":[
                {"type":"tool_result","tool_use_id":"t1","content":"saved"},
                {"type":"tool_result","tool_use_id":"t2","content":"ok"}
            ]}}),
            root,
            &tx,
            &mut st,
        );
        handle_line(
            &json!({"type":"result","subtype":"success","result":"Updating slide 3.","total_cost_usd":0.01,"session_id":"s1",
                    "usage":{"input_tokens":10,"cache_read_input_tokens":900,"cache_creation_input_tokens":90,"output_tokens":5}}),
            root,
            &tx,
            &mut st,
        );
        let ev = drain(&mut rx);
        let kinds: Vec<&str> = ev.iter().map(|e| e["kind"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["message", "activity", "activity", "command", "fileEdited"]);
        assert_eq!(ev[3]["command"], "python3 edit.py");
        assert_eq!(ev[4]["path"], "notes.md");
        assert_eq!(st.cost_usd, Some(0.01));
        assert_eq!(st.usage, Some(TokenUsage { input: 1000, cached: 990, output: 5 }));
        assert!(st.result_error.is_none());
    }

    #[test]
    fn hook_command_quotes_token() {
        let s: Value = serde_json::from_str(&settings_json(3101, "c1", "tok'en", true, GATED_TOOLS)).unwrap();
        assert_eq!(s["fastMode"], true);
        assert_eq!(s["hooks"]["PreToolUse"][0]["matcher"], GATED_TOOLS);
        let cmd = s["hooks"]["PreToolUse"][0]["hooks"][0]["command"].as_str().unwrap();
        assert!(cmd.contains("X-PdfEdit-Token: tok'\\''en"));
        assert!(cmd.contains("/api/agent/hook?chat=c1"));
    }

    #[test]
    fn user_connectors_are_opt_in() {
        let params = |user_mcp| TurnParams {
            claude_bin: "claude", root: Path::new("/tmp"), prompt: "hi", images: &[], system_prompt: "", resume: None,
            model: None, effort: None, fast: false, plan: false, api_key: None, max_budget_usd: None, port: 3101,
            chat_id: "c1", token: "t", python_bin: None, user_mcp, web_access: "allow",
        };
        let args = |user_mcp| build_command(&params(user_mcp)).as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>();
        assert!(args(false).contains(&"--strict-mcp-config".to_string()));
        assert!(!args(true).contains(&"--strict-mcp-config".to_string()));
        // With connectors on, their tools go through the approval hook too.
        assert_eq!(gated_tools(true, "allow"), "Edit|Write|MultiEdit|NotebookEdit|Bash|mcp__.*");
    }

    #[test]
    fn web_access_setting() {
        let args = |web: &'static str| {
            let p = TurnParams {
                claude_bin: "claude", root: Path::new("/tmp"), prompt: "hi", images: &[], system_prompt: "", resume: None,
                model: None, effort: None, fast: false, plan: false, api_key: None, max_budget_usd: None, port: 3101,
                chat_id: "c1", token: "t", python_bin: None, user_mcp: false, web_access: web,
            };
            build_command(&p).as_std().get_args().map(|a| a.to_string_lossy().into_owned()).collect::<Vec<_>>()
        };
        let allowed = |a: &[String]| a.iter().any(|x| x == "WebSearch") && !a.iter().any(|x| x == "--disallowedTools");
        assert!(allowed(&args("allow")));
        let ask = args("ask");
        assert!(!ask.iter().any(|x| x == "WebSearch")); // not pre-approved…
        assert!(gated_tools(false, "ask").ends_with("|WebSearch|WebFetch")); // …asked through the hook
        let off = args("off");
        let i = off.iter().position(|x| x == "--disallowedTools").unwrap();
        assert_eq!(&off[i + 1..i + 3], &["WebSearch".to_string(), "WebFetch".to_string()]);
    }
}
