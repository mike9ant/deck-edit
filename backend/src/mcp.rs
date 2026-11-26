//! A minimal MCP server (streamable HTTP, plain JSON responses) giving the
//! agent the app-side tools: slide notes, the user's current view, and slide
//! screenshots rendered by the browser exactly as the user sees them.
//!
//! `POST /api/mcp?chat=<chat id>` — the CLI is configured with this URL and the
//! process token header for each turn (`claude_cli::mcp_config`).

use std::time::Duration;

use axum::extract::{Path as AxPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::oneshot;

use crate::notes::{self, Note};
use crate::permissions::token_ok;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/mcp", any(mcp))
        .route("/screenshots/{rid}", post(screenshot_result))
        .route("/compares/{rid}", post(compare_result))
}

#[derive(Deserialize)]
struct McpQuery {
    chat: String,
}

fn ok(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn err(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn text_result(text: String, is_error: bool) -> Value {
    json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

async fn mcp(
    method: axum::http::Method,
    State(state): State<AppState>,
    Query(q): Query<McpQuery>,
    headers: HeaderMap,
    body: String,
) -> Response {
    if method != axum::http::Method::POST {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    if !token_ok(&headers, &state.token) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(req) = serde_json::from_str::<Value>(&body) else {
        return (StatusCode::BAD_REQUEST, Json(err(Value::Null, -32700, "parse error"))).into_response();
    };
    let Some(method_name) = req.get("method").and_then(|m| m.as_str()) else {
        return StatusCode::ACCEPTED.into_response();
    };
    let Some(id) = req.get("id").cloned() else {
        // Notification.
        return StatusCode::ACCEPTED.into_response();
    };
    let params = req.get("params").cloned().unwrap_or(Value::Null);
    let resp = match method_name {
        "initialize" => {
            let version = params
                .get("protocolVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("2025-06-18")
                .to_string();
            ok(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": {} },
                    "serverInfo": { "name": "deck-edit", "version": env!("CARGO_PKG_VERSION") },
                }),
            )
        }
        "ping" => ok(id, json!({})),
        "tools/list" => ok(id, json!({ "tools": with_annotations(tool_defs()) })),
        "tools/call" => {
            let name = params.get("name").and_then(|n| n.as_str()).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            ok(id, call_tool(&state, &q.chat, name, &args).await)
        }
        other => err(id, -32601, &format!("method {other} not supported")),
    };
    Json(resp).into_response()
}

/// Mark the tools that only read as `readOnlyHint` — Claude Code's plan mode
/// blocks MCP tools it can't tell are read-only.
fn with_annotations(mut tools: Value) -> Value {
    const READ_ONLY: [&str; 6] = ["list_notes", "get_user_view", "screenshot_slide", "search_conversations", "read_conversation", "compare_decks"];
    if let Some(arr) = tools.as_array_mut() {
        for t in arr {
            let name = t.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string();
            let ro = READ_ONLY.contains(&name.as_str());
            t["annotations"] = json!({ "readOnlyHint": ro, "destructiveHint": false, "openWorldHint": false });
        }
    }
    tools
}

fn tool_defs() -> Value {
    json!([
        {
            "name": "list_notes",
            "description": "List the notes the user pinned for this chat — on slides, pages, cells or text in this project (the open ones are this message's notes: the ones pinned while you work are for the next message). Each note has an id, deck path, current 1-based slide number, slideId, position (x/y as fractions of the slide), the shape it was pinned near, its text, author and status. A note the user drew freehand (circled or marked an area) also has `strokes` (polylines of [x, y] slide fractions), `region` (its bounding box as fractions, and whether it's a closed loop) and `shapes` (the shapes the mark covers); `where` describes it in words.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deck": { "type": "string", "description": "Deck path relative to the project folder; omit for all decks." },
                    "status": { "type": "string", "enum": ["open", "resolved", "all"], "description": "Default: open." }
                }
            }
        },
        {
            "name": "resolve_note",
            "description": "Mark a note as resolved after you addressed it, with a one-line summary of what you did. The user sees it flip to resolved.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "resolution": { "type": "string", "description": "One line: what you changed for this note." }
                },
                "required": ["id", "resolution"]
            }
        },
        {
            "name": "add_note",
            "description": "Pin a note on a slide for the user (a question, a caveat, or something they should check).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deck": { "type": "string" },
                    "slide_number": { "type": "integer", "description": "1-based slide (or PDF page) number." },
                    "text": { "type": "string" },
                    "x": { "type": "number", "description": "0..1 across the slide (default 0.9)." },
                    "y": { "type": "number", "description": "0..1 down the slide (default 0.1)." }
                },
                "required": ["deck", "slide_number", "text"]
            }
        },
        {
            "name": "get_user_view",
            "description": "What the user is looking at right now: open deck, current slide number, selected shapes — and, when the deck is open in compare mode, what it is compared with (another file or a turn backup), which view shows, and the differences found (`compare`).",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "search_conversations",
            "description": "Search the user's past Claude conversations on this machine — Claude Code CLI sessions, Claude desktop Code sessions and Cowork sessions — by words in their title, folders or full transcript. Returns newest first with ids, titles, dates, folders and matching snippets. Empty query lists recent ones.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "Words that must all appear (case-insensitive). Empty = recent conversations." },
                    "source": { "type": "string", "enum": ["cowork", "desktop", "cli"], "description": "Limit to one source." },
                    "limit": { "type": "integer", "description": "Default 15." }
                }
            }
        },
        {
            "name": "read_conversation",
            "description": "Read one past conversation found with search_conversations: the user's messages and Claude's replies (tool calls as one-line summaries), plus files a Cowork session produced. With `query`, returns only the messages around matches. Long transcripts are paged with `offset`.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "Conversation id, e.g. cowork:… or cli:…" },
                    "query": { "type": "string", "description": "Only return messages near this text (with one message of context either side)." },
                    "offset": { "type": "integer", "description": "First message index to return (default 0)." },
                    "max_chars": { "type": "integer", "description": "Default 40000." }
                },
                "required": ["id"]
            }
        },
        {
            "name": "compare_decks",
            "description": "Compare two versions of a deck and open the comparison in the app for the user: the `deck` version (\"to\") is shown with its changes from `base` (\"from\") marked on the slides (added green, changed orange, removed red) and listed beside each thumbnail. Returns the same comparison as text, slide by slide: text changes (words added/removed), shapes added/removed/moved/resized, pictures replaced, chart values, table cells, speaker notes, and slides added, removed or moved. Use it when the user asks to compare decks or what changed, or to review your own changes to a deck. Give `base` (another .pptx in the project) or `since` (the deck as it was before this turn, or before this chat's first turn).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deck": { "type": "string", "description": "The deck to show (the \"to\" side of the comparison), relative to the project folder." },
                    "base": { "type": "string", "description": "Another .pptx to compare it with (the \"from\" side), relative to the project folder." },
                    "since": { "type": "string", "enum": ["turn_start", "chat_start"], "description": "Instead of `base`: compare with the deck as it was before this turn (default), or before this chat's first turn." }
                },
                "required": ["deck"]
            }
        },
        {
            "name": "screenshot_slide",
            "description": "Render one slide (or PDF page) to a PNG exactly as the app displays it, to check your visual result. Requires the app to be open in a browser. Re-read the file first if you just saved — the app reloads within ~1s of a save.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "deck": { "type": "string", "description": "Deck path relative to the project folder." },
                    "slide_number": { "type": "integer", "description": "1-based." },
                    "show_notes": { "type": "boolean", "description": "Overlay the open notes on this slide — pins and the marks the user drew — to see exactly which area a note points at. Default false (the clean slide)." }
                },
                "required": ["deck", "slide_number"]
            }
        }
    ])
}

async fn call_tool(state: &AppState, chat_id: &str, name: &str, args: &Value) -> Value {
    let Some(chat) = state.chats.get(chat_id) else {
        return text_result("unknown chat".into(), true);
    };
    let pid = chat.project_id.clone();
    let s = |k: &str| args.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
    match name {
        "list_notes" => {
            let deck = s("deck");
            let status = match s("status").as_str() {
                "" => "open".to_string(),
                other => other.to_string(),
            };
            // While a turn runs, its open notes are the ones it started with (Turn::notes).
            let mine = state.chats.turn_notes(chat_id);
            let list: Vec<Value> = notes::with_current_index(state, &pid, state.notes.all(&pid))
                .into_iter()
                .filter(|n| n.visible_in_chat(chat_id))
                .filter(|n| n.status != "open" || mine.as_ref().is_none_or(|m| m.contains(&n.id)))
                .filter(|n| deck.is_empty() || n.deck == deck)
                .filter(|n| status == "all" || n.status == status)
                .map(|n| {
                    let place = n.describe_place();
                    let region = n.region().map(|r| {
                        json!({ "x1": r.x1, "y1": r.y1, "x2": r.x2, "y2": r.y2, "circled": r.closed })
                    });
                    let mut v = serde_json::to_value(&n).unwrap_or_default();
                    if let Some(o) = v.as_object_mut() {
                        o.insert("where".into(), json!(place));
                        if let Some(r) = region {
                            o.insert("region".into(), r);
                        }
                    }
                    v
                })
                .collect();
            text_result(serde_json::to_string_pretty(&list).unwrap_or_default(), false)
        }
        "resolve_note" => {
            let id = s("id");
            let resolution = s("resolution");
            if state.chats.turn_notes(chat_id).is_some_and(|m| !m.contains(&id)) {
                return text_result(
                    format!("Note {id} isn't one of this message's notes (the user pinned it for another chat, or while you were working) — leave it open; it's for a later message."),
                    true,
                );
            }
            match state.notes.update(&pid, &id, |n| {
                n.status = "resolved".into();
                n.resolution = Some(resolution.clone());
                n.resolved_at = Some(chrono::Utc::now().to_rfc3339());
                n.resolved_by = Some("agent".into());
            }) {
                Ok(_) => {
                    notes::notify_changed(state, &pid);
                    text_result(format!("Note {id} resolved."), false)
                }
                Err(e) => text_result(e.to_string(), true),
            }
        }
        "add_note" => {
            let deck = s("deck");
            let n = args.get("slide_number").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
            let slide_id = state
                .deck_maps
                .lock()
                .unwrap()
                .get(&(pid.clone(), deck.clone()))
                .and_then(|m| m.as_array().cloned())
                .and_then(|slides| {
                    slides
                        .iter()
                        .find(|s| s.get("index").and_then(|v| v.as_u64()) == Some(n as u64))
                        .and_then(|s| s.get("slideId").and_then(|v| v.as_str()).map(String::from))
                })
                .unwrap_or_default();
            let note = Note {
                id: uuid::Uuid::new_v4().to_string()[..8].to_string(),
                deck,
                slide_id,
                slide_index: n,
                x: args.get("x").and_then(|v| v.as_f64()).unwrap_or(0.9).clamp(0.0, 1.0),
                y: args.get("y").and_then(|v| v.as_f64()).unwrap_or(0.1).clamp(0.0, 1.0),
                shape_name: None,
                strokes: Vec::new(),
                shapes: Vec::new(),
                quote: None,
                lines: None,
                target: None,
                text: s("text"),
                author: "agent".into(),
                created_at: chrono::Utc::now().to_rfc3339(),
                status: "open".into(),
                resolution: None,
                resolved_at: None,
                resolved_by: None,
                chats: vec![chat_id.to_string()],
            };
            match state.notes.add(&pid, note) {
                Ok(n) => {
                    state.chats.add_turn_note(chat_id, &n.id);
                    notes::notify_changed(state, &pid);
                    text_result(format!("Added note {}.", n.id), false)
                }
                Err(e) => text_result(e.to_string(), true),
            }
        }
        "search_conversations" => {
            let query = s("query");
            let source = s("source");
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(15) as usize;
            let st = state.clone();
            let hits = tokio::task::spawn_blocking(move || {
                crate::conversations::search(&st, &query, Some(source.as_str()).filter(|x| !x.is_empty()), limit)
            })
            .await
            .unwrap_or_default();
            if hits.is_empty() {
                return text_result("No matching conversations.".into(), false);
            }
            let mut out = String::new();
            for h in hits {
                let c = &h.info;
                let when = chrono::DateTime::from_timestamp_millis(c.last_activity_at as i64)
                    .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
                    .unwrap_or_default();
                out.push_str(&format!("- id {} [{}] \"{}\" — last active {when}", c.id, c.source, c.title));
                if !c.folders.is_empty() {
                    out.push_str(&format!(" — folders: {}", c.folders.join(", ")));
                }
                if c.output_count > 0 {
                    out.push_str(&format!(" — {} output file(s)", c.output_count));
                }
                out.push('\n');
                for sn in h.snippets {
                    out.push_str(&format!("    · {} (msg {}): {}\n", sn.role, sn.message, sn.text));
                }
            }
            text_result(out, false)
        }
        "read_conversation" => {
            let id = s("id");
            let query = s("query").to_lowercase();
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let max = args.get("max_chars").and_then(|v| v.as_u64()).unwrap_or(40_000) as usize;
            let st = state.clone();
            let res = tokio::task::spawn_blocking(move || crate::conversations::read_json_value(&st, &id)).await;
            let v = match res {
                Ok(Ok(v)) => v,
                Ok(Err(e)) => return text_result(e.to_string(), true),
                Err(e) => return text_result(e.to_string(), true),
            };
            let msgs = v["messages"].as_array().cloned().unwrap_or_default();
            let keep: Vec<usize> = if query.is_empty() {
                (offset..msgs.len()).collect()
            } else {
                let mut set = std::collections::BTreeSet::new();
                for (i, m) in msgs.iter().enumerate() {
                    if m["text"].as_str().unwrap_or("").to_lowercase().contains(&query) {
                        set.extend(i.saturating_sub(1)..=(i + 1).min(msgs.len().saturating_sub(1)));
                    }
                }
                set.into_iter().filter(|i| *i >= offset).collect()
            };
            let info = &v["info"];
            let mut out = format!(
                "Conversation {} [{}] \"{}\" — {} messages{}\n",
                info["id"].as_str().unwrap_or(""),
                info["source"].as_str().unwrap_or(""),
                info["title"].as_str().unwrap_or(""),
                msgs.len(),
                if query.is_empty() { String::new() } else { format!(", {} shown around \"{query}\"", keep.len()) }
            );
            if let Some(outputs) = v["outputs"].as_array().filter(|a| !a.is_empty()) {
                out.push_str("Output files: ");
                out.push_str(&outputs.iter().filter_map(|o| o["path"].as_str()).collect::<Vec<_>>().join(", "));
                out.push('\n');
            }
            let mut last = None;
            let mut truncated_at = None;
            for i in keep {
                let m = &msgs[i];
                if last.is_some_and(|l: usize| i > l + 1) {
                    out.push_str("\n[…]\n");
                }
                last = Some(i);
                let mut block = format!("\n### {} (msg {i})\n{}\n", m["role"].as_str().unwrap_or(""), m["text"].as_str().unwrap_or(""));
                if let Some(t) = m["tools"].as_array().filter(|t| !t.is_empty()) {
                    block.push_str(&format!("(tools: {})\n", t.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join("; ")));
                }
                if out.len() + block.len() > max {
                    truncated_at = Some(i);
                    break;
                }
                out.push_str(&block);
            }
            if let Some(i) = truncated_at {
                out.push_str(&format!("\n[truncated — continue with offset={i}]\n"));
            }
            text_result(out, false)
        }
        "get_user_view" => {
            let view = state.views.lock().unwrap().get(&pid).cloned().unwrap_or(json!({}));
            text_result(serde_json::to_string_pretty(&view).unwrap_or_default(), false)
        }
        "screenshot_slide" => {
            let deck = s("deck");
            let n = args.get("slide_number").and_then(|v| v.as_u64()).unwrap_or(1);
            if state.events.receiver_count() == 0 {
                return text_result("The app isn't open in a browser, so slides can't be rendered right now.".into(), true);
            }
            let rid = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            state.screenshots.lock().unwrap().insert(rid.clone(), tx);
            state.publish(json!({
                "type": "screenshot",
                "requestId": rid,
                "projectId": pid,
                "deck": deck,
                "slideIndex": n,
                "showNotes": args.get("show_notes").and_then(|v| v.as_bool()).unwrap_or(false),
            }));
            match tokio::time::timeout(Duration::from_secs(45), rx).await {
                Ok(Ok(data_url)) => {
                    if let Some(b64) = data_url.strip_prefix("data:image/png;base64,") {
                        json!({ "content": [
                            { "type": "image", "data": b64, "mimeType": "image/png" },
                            { "type": "text", "text": format!("{deck} slide {n} as rendered in the app{}.", if args.get("show_notes").and_then(|v| v.as_bool()).unwrap_or(false) { ", with the open notes overlaid (pins and drawn marks)" } else { "" }) }
                        ], "isError": false })
                    } else {
                        text_result(data_url, true)
                    }
                }
                _ => {
                    state.screenshots.lock().unwrap().remove(&rid);
                    text_result("Timed out waiting for the app to render the slide.".into(), true)
                }
            }
        }
        "compare_decks" => {
            let deck = s("deck");
            if deck.is_empty() {
                return text_result("Give the deck to compare (`deck`).".into(), true);
            }
            if state.events.receiver_count() == 0 {
                return text_result("The app isn't open in a browser, so decks can't be compared right now.".into(), true);
            }
            let other = s("base");
            let base = if !other.is_empty() {
                json!({ "kind": "file", "path": other })
            } else {
                let since = s("since");
                // A turn's backup is the folder as it was when the turn started.
                let snapshot = if since == "chat_start" {
                    chat.turns.iter().find_map(|t| t.snapshot_id.clone())
                } else {
                    chat.turns.iter().rev().find_map(|t| t.snapshot_id.clone())
                };
                let Some(sid) = snapshot else {
                    return text_result("There's no backup to compare with yet — give `base` (another deck) instead.".into(), true);
                };
                let label = if since == "chat_start" { "before this chat" } else { "before this turn" };
                json!({ "kind": "snapshot", "snapshotId": sid, "path": deck, "label": label })
            };
            let rid = uuid::Uuid::new_v4().to_string();
            let (tx, rx) = oneshot::channel();
            state.screenshots.lock().unwrap().insert(rid.clone(), tx);
            state.publish(json!({ "type": "compare", "requestId": rid, "projectId": pid, "deck": deck, "base": base }));
            match tokio::time::timeout(Duration::from_secs(90), rx).await {
                Ok(Ok(text)) => match text.strip_prefix("error:") {
                    Some(e) => text_result(e.trim().to_string(), true),
                    None => text_result(text, false),
                },
                _ => {
                    state.screenshots.lock().unwrap().remove(&rid);
                    text_result("Timed out waiting for the app to compare the decks.".into(), true)
                }
            }
        }
        other => text_result(format!("unknown tool {other}"), true),
    }
}

#[derive(Deserialize)]
struct CompareBody {
    /// The comparison as text, or `error: …`.
    summary: String,
}

/// The app's answer to a `compare_decks` request.
async fn compare_result(
    State(state): State<AppState>,
    AxPath(rid): AxPath<String>,
    Json(b): Json<CompareBody>,
) -> Json<Value> {
    let tx = state.screenshots.lock().unwrap().remove(&rid);
    let delivered = tx.is_some_and(|tx| tx.send(b.summary).is_ok());
    Json(json!({ "ok": delivered }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotBody {
    /// `data:image/png;base64,…`, or an error message.
    data_url: String,
}

async fn screenshot_result(
    State(state): State<AppState>,
    AxPath(rid): AxPath<String>,
    Json(b): Json<ScreenshotBody>,
) -> Json<Value> {
    let tx = state.screenshots.lock().unwrap().remove(&rid);
    let delivered = tx.is_some_and(|tx| tx.send(b.data_url).is_ok());
    Json(json!({ "ok": delivered }))
}
