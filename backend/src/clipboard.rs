//! `POST /api/clipboard/rich` — the system clipboard's formatted text, for
//! "paste keeping source formatting" (⌥⇧⌘V) in slide text.
//!
//! A page only sees the clipboard inside a paste event, and the shortcuts that
//! raise one paste plain text (⌘V by our choice, ⌥⇧⌘V natively as "Paste and
//! Match Style") — so the formatted variant asks the local server, which reads
//! the macOS pasteboard: its HTML, else its RTF converted to HTML, plus the
//! plain text.
//!
//! Other web pages can't ask for it: `local_only` refuses them for the whole API.

use axum::routing::post;
use axum::{Json, Router};
use serde::Serialize;

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/clipboard/rich", post(rich))
}

#[derive(Serialize, Default)]
struct RichClipboard {
    html: Option<String>,
    text: Option<String>,
}

async fn rich() -> Json<RichClipboard> {
    Json(tokio::task::spawn_blocking(read).await.unwrap_or_default())
}

#[cfg(target_os = "macos")]
fn read() -> RichClipboard {
    use std::io::Write;
    use std::process::{Command, Stdio};

    // JXA: the pasteboard's strings for each type, as JSON (null when absent).
    const SCRIPT: &str = r#"ObjC.import("AppKit");
const pb = $.NSPasteboard.generalPasteboard;
const get = (t) => { const s = pb.stringForType(t); return s.isNil() ? null : s.js };
JSON.stringify({ html: get("public.html"), rtf: get("public.rtf"), text: get("public.utf8-plain-text") })"#;
    #[derive(serde::Deserialize, Default)]
    struct Raw {
        html: Option<String>,
        rtf: Option<String>,
        text: Option<String>,
    }
    let raw: Raw = Command::new("osascript")
        .args(["-l", "JavaScript", "-e", SCRIPT])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| serde_json::from_slice(&o.stdout).ok())
        .unwrap_or_default();

    // Only RTF (e.g. copied from TextEdit, Pages, Keynote): let textutil turn it into HTML.
    let html = raw.html.or_else(|| {
        let rtf = raw.rtf?;
        let mut child = Command::new("textutil")
            .args(["-stdin", "-stdout", "-format", "rtf", "-convert", "html"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        child.stdin.take()?.write_all(rtf.as_bytes()).ok()?;
        let out = child.wait_with_output().ok().filter(|o| o.status.success())?;
        String::from_utf8(out.stdout).ok()
    });
    RichClipboard { html, text: raw.text }
}

#[cfg(not(target_os = "macos"))]
fn read() -> RichClipboard {
    RichClipboard::default()
}
