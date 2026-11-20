//! Is a chat's prompt cache still warm?
//!
//! Every turn resends the whole conversation (`claude -p --resume`). While the
//! provider still has it cached that costs little — cache reads; once the cache
//! has expired, the whole conversation is written to the cache again at a
//! premium (doubled in fast mode). For a conversation of hundreds of thousands
//! of tokens that's the moment worth asking whether to continue it or to start
//! afresh from a summary.
//!
//! - `predict` — before a turn: how big the conversation is (the last API call's
//!   input), how long it has been idle, and whether the next request will miss
//!   the cache: idle longer than the cache lifetime, or a different model, speed
//!   or effort (each has its own cache). `offer_split` when it's cold and at
//!   least `SPLIT_THRESHOLD` tokens.
//! - `observed_cold` — after a turn: what actually happened, from its first API
//!   call (mostly written to the cache = it started cold).
//! - `learn_ttl` — the cache lifetime this login's requests use (5 minutes, or
//!   1 hour). The API says it outright: each call's usage splits its cache
//!   writes by lifetime (`ephemeral_1h_input_tokens` / `…5m…`), recorded per
//!   turn (`write_1h` / `write_5m`); the latest turn with writes decides. Only
//!   without that (old turns): a turn that started warm after a gap longer than
//!   5 minutes means 1 hour, one that started cold after such a gap, 5.
//!
//! Each turn stores its prediction (`Turn::cache`) and the server log has
//! "predicted … observed …" per turn, so the prediction can be checked.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::chat::{Chat, Turn};
use crate::claude_cli::TokenUsage;

/// Offer to split a cold conversation at least this big (tokens re-sent).
pub const SPLIT_THRESHOLD: u64 = 250_000;
const SHORT_TTL: i64 = 5 * 60;
const LONG_TTL: i64 = 60 * 60;
/// Idle time is measured from the end of the last turn; its last request started a little
/// earlier, and the cache lifetime counts from a request's start. Err towards "cold".
const MARGIN: i64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CacheCheck {
    /// Tokens the next request re-sends: the conversation's size after the last turn (0: unknown).
    pub context_tokens: u64,
    /// Seconds since the last turn ended.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_secs: Option<i64>,
    /// The cache lifetime assumed, and whether it was learned from this account's turns.
    pub ttl_secs: i64,
    pub ttl_learned: bool,
    pub cold: bool,
    /// Why it's cold: "new conversation", "idle 12 min", "model changed", "fast mode changed", "effort changed".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Cold and at least `threshold` tokens: worth asking before continuing.
    pub offer_split: bool,
    /// The cache under the *previous* turn's settings is still warm — cold only because the
    /// settings changed (e.g. switching to fast mode). Then a summary made with those settings
    /// (`--resume --fork-session`) reads the conversation from the cache cheaply.
    #[serde(default)]
    pub previous_warm: bool,
    pub threshold: u64,
}

/// The settings a turn runs with that pick its cache (each model, speed and effort has its own).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct CacheKey {
    pub model: Option<String>,
    pub effort: Option<String>,
    pub fast: bool,
}

impl CacheKey {
    pub fn of(t: &Turn) -> Self {
        Self { model: t.model.clone(), effort: t.effort.clone(), fast: t.fast }
    }
}

/// Whether a finished turn started on a cold cache (its first call mostly written, not read); None if unknown.
pub fn observed_cold(u: &TokenUsage) -> Option<bool> {
    (u.first_read + u.first_write > 0).then_some(u.first_write > u.first_read)
}

fn time(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

/// The last finished turn with token counts (the one the next request continues from).
fn previous(chat: &Chat) -> Option<&Turn> {
    chat.turns.iter().rev().find(|t| t.ended_at.is_some() && t.usage.is_some() && t.status != "running")
}

/// Before a turn with `next` settings, at `now`: will it miss the cache? `ttl`: (seconds, learned).
pub fn predict(chat: &Chat, next: &CacheKey, now: DateTime<Utc>, ttl: (i64, bool)) -> CacheCheck {
    let mut c = CacheCheck {
        context_tokens: 0, idle_secs: None, ttl_secs: ttl.0, ttl_learned: ttl.1, cold: true, reason: None, offer_split: false, previous_warm: false, threshold: SPLIT_THRESHOLD,
    };
    let prev = match previous(chat) {
        Some(p) if chat.cli_session_id.is_some() => p,
        _ => {
            c.reason = Some("new conversation".into());
            return c;
        }
    };
    c.context_tokens = prev.usage.map_or(0, |u| u.context);
    c.idle_secs = prev.ended_at.as_deref().and_then(time).map(|t| (now - t).num_seconds().max(0));
    let was = CacheKey::of(prev);
    let idle_warm = c.idle_secs.is_some_and(|idle| idle + MARGIN < ttl.0);
    c.previous_warm = idle_warm;
    c.reason = if was.model != next.model {
        Some("model changed".into())
    } else if was.fast != next.fast {
        Some("fast mode changed".into())
    } else if was.effort != next.effort {
        Some("effort changed".into())
    } else {
        match c.idle_secs {
            _ if idle_warm => None,
            Some(idle) => Some(format!("idle {}", human(idle))),
            None => Some("idle (unknown)".into()),
        }
    };
    c.cold = c.reason.is_some();
    c.offer_split = c.cold && c.context_tokens >= SPLIT_THRESHOLD;
    c
}

fn human(secs: i64) -> String {
    match secs {
        s if s < 90 => format!("{s} s"),
        s if s < 90 * 60 => format!("{} min", (s + 30) / 60),
        s => format!("{:.1} h", s as f64 / 3600.0),
    }
}

/// The cache lifetime a turn's writes used, from the API's split (any 5-minute write: 5 minutes —
/// the conversation's newest part would expire first); None if it wrote nothing.
pub fn ttl_of(u: &TokenUsage) -> Option<i64> {
    if u.write_5m > 0 {
        Some(SHORT_TTL)
    } else if u.write_1h > 0 {
        Some(LONG_TTL)
    } else {
        None
    }
}

/// The cache lifetime on a login (`auth`), across its chats: what the latest turn's cache writes
/// used (the API reports it); failing that, the latest turn that came after a gap between 5 minutes
/// and an hour with unchanged settings (warm: 1 hour; cold: 5 minutes). (lifetime, known)
pub fn learn_ttl<'a>(chats: impl Iterator<Item = &'a Chat> + Clone, auth: Option<&str>) -> (i64, bool) {
    let mut reported: Option<(DateTime<Utc>, i64)> = None;
    for t in chats.clone().flat_map(|c| c.turns.iter()).filter(|t| t.auth.as_deref() == auth) {
        let (Some(ttl), Some(at)) = (t.usage.as_ref().and_then(ttl_of), time(&t.started_at)) else { continue };
        if reported.is_none_or(|(r, _)| at > r) {
            reported = Some((at, ttl));
        }
    }
    if let Some((_, ttl)) = reported {
        return (ttl, true);
    }
    let mut latest: Option<(DateTime<Utc>, i64)> = None;
    for chat in chats {
        let done: Vec<&Turn> = chat.turns.iter().filter(|t| t.ended_at.is_some() && t.usage.is_some()).collect();
        for pair in done.windows(2) {
            let (a, b) = (pair[0], pair[1]);
            let (Some(end), Some(start)) = (a.ended_at.as_deref().and_then(time), time(&b.started_at)) else { continue };
            let gap = (start - end).num_seconds();
            if gap <= SHORT_TTL + MARGIN || gap >= LONG_TTL - MARGIN || CacheKey::of(a) != CacheKey::of(b) || a.auth != b.auth || b.auth.as_deref() != auth {
                continue;
            }
            let Some(cold) = b.usage.as_ref().and_then(observed_cold) else { continue };
            let ttl = if cold { SHORT_TTL } else { LONG_TTL };
            if latest.is_none_or(|(t, _)| start > t) {
                latest = Some((start, ttl));
            }
        }
    }
    latest.map_or((SHORT_TTL, false), |(_, ttl)| (ttl, true))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage(first_read: u64, first_write: u64, context: u64) -> TokenUsage {
        TokenUsage { first_read, first_write, context, ..Default::default() }
    }
    fn turn(start: &str, end: &str, u: TokenUsage) -> Turn {
        serde_json::from_value(serde_json::json!({
            "id": start, "prompt": "p", "startedAt": start, "endedAt": end, "status": "done", "usage": u, "fast": false
        }))
        .unwrap()
    }
    fn chat(turns: Vec<Turn>) -> Chat {
        serde_json::from_value(serde_json::json!({
            "id": "c", "projectId": "p", "title": "t", "createdAt": "x", "updatedAt": "x", "cliSessionId": "s", "turns": turns
        }))
        .unwrap()
    }
    const T0: &str = "2026-11-19T10:00:00Z";
    const T1: &str = "2026-11-19T10:01:00Z";
    fn at(s: &str) -> DateTime<Utc> {
        time(s).unwrap()
    }

    #[test]
    fn warm_within_the_lifetime_cold_after_it() {
        let c = chat(vec![turn(T0, T1, usage(10, 300_000, 320_000))]);
        let warm = predict(&c, &CacheKey::default(), at("2026-11-19T10:03:00Z"), (SHORT_TTL, false));
        assert!(!warm.cold && !warm.offer_split);
        assert_eq!(warm.context_tokens, 320_000);
        let cold = predict(&c, &CacheKey::default(), at("2026-11-19T10:20:00Z"), (SHORT_TTL, false));
        assert!(cold.cold && cold.offer_split);
        assert_eq!(cold.reason.as_deref(), Some("idle 19 min"));
        // With an hour-long cache the same gap is still warm.
        assert!(!predict(&c, &CacheKey::default(), at("2026-11-19T10:20:00Z"), (LONG_TTL, true)).cold);
    }

    #[test]
    fn a_different_model_speed_or_effort_is_cold_and_small_conversations_are_not_offered() {
        let c = chat(vec![turn(T0, T1, usage(10, 100_000, 120_000))]);
        let fast = predict(&c, &CacheKey { fast: true, ..Default::default() }, at("2026-11-19T10:02:00Z"), (SHORT_TTL, false));
        assert_eq!((fast.cold, fast.reason.as_deref(), fast.offer_split), (true, Some("fast mode changed"), false));
        // Switched right after a turn: the normal-speed cache is still warm (a cheap summary is possible).
        assert!(fast.previous_warm);
        let later = predict(&c, &CacheKey { fast: true, ..Default::default() }, at("2026-11-19T10:30:00Z"), (SHORT_TTL, false));
        assert!(later.cold && !later.previous_warm);
        let model = predict(&c, &CacheKey { model: Some("sonnet".into()), ..Default::default() }, at("2026-11-19T10:02:00Z"), (SHORT_TTL, false));
        assert_eq!(model.reason.as_deref(), Some("model changed"));
        let fresh = predict(&chat(vec![]), &CacheKey::default(), at(T1), (SHORT_TTL, false));
        assert_eq!((fresh.cold, fresh.reason.as_deref(), fresh.offer_split), (true, Some("new conversation"), false));
    }

    #[test]
    fn the_lifetime_is_learned_from_turns_after_a_long_gap() {
        // 20 minutes later the next turn still read its history from the cache: an hour-long cache.
        let warm_after_gap = chat(vec![turn(T0, T1, usage(0, 50_000, 50_000)), turn("2026-11-19T10:21:00Z", "2026-11-19T10:22:00Z", usage(49_000, 900, 50_000))]);
        assert_eq!(learn_ttl([&warm_after_gap].into_iter(), None), (LONG_TTL, true));
        // It had to write it again: a 5-minute cache.
        let cold_after_gap = chat(vec![turn(T0, T1, usage(0, 50_000, 50_000)), turn("2026-11-19T10:21:00Z", "2026-11-19T10:22:00Z", usage(0, 50_000, 50_000))]);
        assert_eq!(learn_ttl([&cold_after_gap].into_iter(), None), (SHORT_TTL, true));
        // No evidence: assume 5 minutes.
        assert_eq!(learn_ttl([&chat(vec![])].into_iter(), None), (SHORT_TTL, false));
    }

    #[test]
    fn the_lifetime_the_api_reports_wins() {
        let mut u = usage(0, 50_000, 50_000);
        u.write_1h = 50_000;
        let mut t = turn(T0, T1, u);
        t.auth = Some("subscription".into());
        let c = chat(vec![t]);
        assert_eq!(learn_ttl([&c].into_iter(), Some("subscription")), (LONG_TTL, true));
        assert_eq!(learn_ttl([&c].into_iter(), Some("key")), (SHORT_TTL, false)); // another login: no evidence
        let mut u5 = usage(0, 50_000, 50_000);
        u5.write_5m = 10;
        u5.write_1h = 49_990;
        assert_eq!(ttl_of(&u5), Some(SHORT_TTL));
        assert_eq!(ttl_of(&TokenUsage::default()), None);
    }

    #[test]
    fn observed_from_the_first_call() {
        assert_eq!(observed_cold(&usage(90_000, 500, 0)), Some(false));
        assert_eq!(observed_cold(&usage(0, 90_000, 0)), Some(true));
        assert_eq!(observed_cold(&TokenUsage::default()), None);
    }
}
