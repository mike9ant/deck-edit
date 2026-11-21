//! Splitting a long conversation: continue in a fresh CLI session that starts
//! from a summary of the old one, instead of re-sending all of it.
//!
//! Offered when a chat's next turn would start on a cold prompt cache and the
//! conversation is large (cache_check.rs), or on request. The split happens as
//! the first step of that turn (`chat::run_turn`):
//!
//! 1. Summary — from the old session itself when its cache is still warm
//!    (the turn before ran with other settings moments ago, e.g. just before
//!    switching to fast mode): the same model resumes a read-only fork of the
//!    session (`--resume --fork-session`), so the conversation is a cache read.
//!    Otherwise Sonnet summarizes a condensed transcript (messages and tool
//!    notes, without tool output) — cheaper than re-sending it cold.
//! 2. Carry-over — the summary, the last turns verbatim (≤ `RECENT_TURNS`,
//!    ≤ `RECENT_CHARS`), and where the old conversation is, so the agent can
//!    look details up in it (`read_conversation`).
//! 3. The turn runs in a new session: carry-over first, then the user's message.
//!
//! The turn keeps a `SplitInfo` (shown as a collapsible card in the chat).

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

use crate::chat::Turn;

/// Turns carried over verbatim, and their size limit (≈ 50K tokens).
pub const RECENT_TURNS: usize = 3;
pub const RECENT_CHARS: usize = 200_000;
/// What Sonnet reads at most (≈ 300K tokens).
pub const TRANSCRIPT_CHARS: usize = 1_200_000;

pub const SUMMARY_INSTRUCTIONS: &str = "The user is moving this conversation to a fresh session to keep it small. Write a handoff summary for the agent that continues the work there — it will see this summary and the last few turns, nothing else. Use these sections:
## Goal — what the user is trying to achieve overall, and for whom.
## Done so far — what was changed (exact file names, slide numbers, sections), key decisions and why.
## Current state — where things stand now; anything half-finished.
## Open threads — questions, next steps, things the user asked for that aren't done.
## User preferences — what they asked for or ruled out (tone, style, wording, formats, things not to touch).
## Key facts — names, numbers, figures, sources the work depends on.
Be specific and factual; at most about 1,500 words. Reply with the summary only — use no tools.";

/// A split, as the turn records it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitInfo {
    /// The old CLI session (still searchable with `read_conversation`, id `cli:<session>`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub previous_session: Option<String>,
    /// The old conversation's size, in tokens (0: unknown).
    pub previous_tokens: u64,
    /// "warm" (the same model, from the old session's cache) | "sonnet" (from a condensed transcript).
    pub method: String,
    pub summary: String,
    /// Turns carried over verbatim.
    pub recent_turns: usize,
}

/// The last finished turns before `current`, newest within the limits, in order.
pub fn recent_turns<'a>(turns: &'a [Turn], current: &str) -> Vec<&'a Turn> {
    let mut out: Vec<&Turn> = Vec::new();
    let mut size = 0;
    for t in turns.iter().rev().filter(|t| t.id != current && t.status != "running") {
        let n = turn_text(t).len();
        if out.len() >= RECENT_TURNS || (size + n > RECENT_CHARS && !out.is_empty()) {
            break;
        }
        size += n;
        out.push(t);
    }
    out.reverse();
    out
}

/// A turn as text: the user's message, the agent's replies, the files it changed.
fn turn_text(t: &Turn) -> String {
    let cap = |s: &str, n: usize| if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s.to_string() };
    let mut out = format!("### User\n{}\n", cap(t.prompt.trim(), 20_000));
    let replies: Vec<String> = t.events.iter().filter(|e| e.get("kind").and_then(|k| k.as_str()) == Some("message")).filter_map(|e| e.get("text").and_then(|x| x.as_str())).map(|x| cap(x.trim(), 20_000)).collect();
    if !replies.is_empty() {
        out.push_str(&format!("### You\n{}\n", replies.join("\n\n")));
    }
    if !t.changes.is_empty() {
        let files: Vec<String> = t.changes.iter().take(30).map(|c| format!("{} ({})", c.path, c.kind)).collect();
        out.push_str(&format!("(Files changed: {})\n", files.join(", ")));
    }
    out
}

/// What the new session starts from, before the user's message.
pub fn carry_over(info: &SplitInfo, recent: &[&Turn]) -> String {
    let mut out = String::from("[This conversation continues an earlier one. The app split it to keep the conversation small: below are a summary of the earlier conversation and its last turns verbatim.");
    if let Some(s) = &info.previous_session {
        out.push_str(&format!(
            " If you need a detail that isn't here, look it up in the earlier conversation with the `deck` tool `read_conversation` (id `cli:{s}`, pass `query`)."
        ));
    }
    out.push_str(" Files may have changed since — re-read a file before you change it.]\n\n## Summary of the earlier conversation\n\n");
    out.push_str(info.summary.trim());
    if !recent.is_empty() {
        out.push_str("\n\n## Its last turns\n\n");
        for t in recent {
            out.push_str(&turn_text(t));
            out.push('\n');
        }
    }
    out.push_str("\n---\n[The user's new message:]\n\n");
    out
}

/// A summary by Sonnet of the session's condensed transcript (no tools, no session kept).
pub async fn summarize_with_sonnet(claude_bin: &str, root: &Path, api_key: Option<&str>, session: &str) -> Result<String, String> {
    let transcript = crate::conversations::condensed_transcript(session, TRANSCRIPT_CHARS).ok_or("the earlier conversation's transcript wasn't found")?;
    let mut cmd = crate::login_path::command(claude_bin);
    cmd.current_dir(root)
        // Medium effort is plenty for a summary (the warm route keeps the session's own effort: changing it would miss the cache).
        .args(["-p", "--model", "sonnet", "--effort", "medium", "--output-format", "text", "--no-session-persistence", "--tools", ""])
        .args(["--setting-sources", "user", "--strict-mcp-config"])
        .args(["--system-prompt", "You write precise, factual handoff summaries of conversations between a user and an agent working on documents."])
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    match api_key {
        Some(k) => cmd.env("ANTHROPIC_API_KEY", k),
        None => cmd.env_remove("ANTHROPIC_API_KEY"),
    };
    let mut child = cmd.spawn().map_err(|e| format!("couldn't start claude: {e}"))?;
    let input = format!("Here is the conversation:\n\n<conversation>\n{transcript}\n</conversation>\n\n{SUMMARY_INSTRUCTIONS}");
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(input.as_bytes()).await.map_err(|e| e.to_string())?;
    }
    let out = tokio::time::timeout(Duration::from_secs(300), child.wait_with_output()).await.map_err(|_| "the summary took too long".to_string())?.map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || text.is_empty() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("the summary failed{}", if err.trim().is_empty() { String::new() } else { format!(": {}", err.trim().lines().last().unwrap_or("")) }));
    }
    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(id: &str, prompt: &str, reply: &str) -> Turn {
        serde_json::from_value(serde_json::json!({
            "id": id, "prompt": prompt, "startedAt": "x", "status": "done",
            "events": [{ "kind": "message", "text": reply }], "changes": [{ "path": "deck.pptx", "kind": "modified", "restorable": true }]
        }))
        .unwrap()
    }

    #[test]
    fn the_last_turns_are_carried_over_in_order() {
        let turns: Vec<Turn> = (1..=5).map(|i| turn(&format!("t{i}"), &format!("ask {i}"), &format!("did {i}"))).collect();
        let recent = recent_turns(&turns, "t5");
        assert_eq!(recent.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec!["t2", "t3", "t4"]);
        let info = SplitInfo { previous_session: Some("abc".into()), previous_tokens: 650_000, method: "sonnet".into(), summary: "## Goal\nA deck.".into(), recent_turns: 3 };
        let text = carry_over(&info, &recent);
        assert!(text.contains("read_conversation") && text.contains("cli:abc"));
        assert!(text.contains("## Goal\nA deck.") && text.contains("ask 2") && text.contains("did 4") && text.contains("deck.pptx (modified)"));
        assert!(text.trim_end().ends_with("[The user's new message:]"));
    }

    #[test]
    fn a_huge_message_is_cut_short_in_the_carry_over() {
        let big = "x".repeat(RECENT_CHARS + 10);
        let turns = vec![turn("t1", "a", "b"), turn("t2", &big, "c"), turn("t3", "now", "")];
        let recent = recent_turns(&turns, "t3");
        assert_eq!(recent.len(), 2);
        let info = SplitInfo { previous_session: None, previous_tokens: 0, method: "sonnet".into(), summary: "s".into(), recent_turns: 2 };
        let text = carry_over(&info, &recent);
        assert!(text.len() < 30_000, "each message is capped (20K characters)");
        assert!(!text.contains("read_conversation"), "no earlier session to point to");
    }
}
