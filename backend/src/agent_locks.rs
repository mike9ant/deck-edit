//! Several agents in one project at once: a readers–writer lock on files.
//!
//! Every tool call an agent makes passes the PreToolUse hook before it runs
//! (permissions.rs). Once it's allowed, the hook takes this lock for the files
//! the call reads and writes (agent_access.rs) and holds it until the call's
//! result comes back on the CLI's output stream (claude_cli → `toolDone`).
//!
//! - A call that only reads waits while another agent's running call writes
//!   one of its files (a deck caught mid-save is a broken file).
//! - A call that writes waits while another agent's running call reads or
//!   writes one of its files.
//! - "Writes everything" (couldn't tell) waits for, and holds back, every other
//!   agent's call in the project.
//! - An agent's own calls never wait for each other.
//!
//! Each call takes all of its locks at once and never waits while holding one,
//! so there are no deadlocks. A waiting call shows a note in its chat; after
//! `MAX_WAIT` it's turned back ("try again shortly") rather than hang the turn.
//! Locks live only in memory: when the app quits, they're gone with the turns.
//!
//! For per-turn change lists, a call that writes "everything" also records the
//! project's files before it runs; when it's done, the files it changed are
//! known (nobody else could write meanwhile) and are credited to its turn.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

use crate::agent_access::{overlaps, Access};

/// A call's longest wait before it's turned back (the hook itself may wait 10 minutes).
pub const MAX_WAIT: Duration = Duration::from_secs(8 * 60);
/// A lock nobody released (a call that never reported back) expires after the longest a command can run.
const LEASE: Duration = Duration::from_secs(11 * 60);

pub struct Hold {
    /// The tool call (`tool_use_id`).
    pub id: String,
    pub project: String,
    pub chat: String,
    /// The chat's title, for the other agents' waiting notes.
    pub chat_title: String,
    pub access: Access,
    /// The project's files (size, mtime) before a "writes everything" call, to see what it changed.
    pub before: Option<HashMap<String, (u64, u128)>>,
    since: Instant,
}

impl Hold {
    pub fn new(id: String, project: String, chat: String, chat_title: String, access: Access) -> Self {
        Self { id, project, chat, chat_title, access, before: None, since: Instant::now() }
    }
}

/// Who a waiting call waits for.
pub struct Blocker {
    pub chat_title: String,
    pub writing: bool,
    pub what: String,
}

#[derive(Default)]
pub struct AgentLocks {
    held: Mutex<Vec<Hold>>,
    changed: Notify,
}

/// Whether a call wanting `want` must wait for a running call holding `have`.
pub fn conflict(want: &Access, have: &Access) -> bool {
    if want.everything {
        return !have.is_empty();
    }
    if have.everything {
        return !want.is_empty();
    }
    let any = |a: &[PathBuf], b: &[PathBuf]| a.iter().any(|x| b.iter().any(|y| overlaps(x, y)));
    any(&want.writes, &have.writes) || any(&want.writes, &have.reads) || any(&want.reads, &have.writes)
}

impl AgentLocks {
    /// Take the lock for `hold` once no other agent's running call conflicts; `on_wait` is told
    /// (once) whom it waits for. Ok(time waited), or Err(blocker) after `max_wait`.
    /// `live`: whether the caller still wants it (its turn wasn't stopped) — checked each time it wakes.
    pub async fn acquire(&self, mut hold: Hold, root: &Path, max_wait: Duration, live: impl Fn() -> bool, on_wait: impl FnOnce(&Blocker)) -> Result<Duration, Blocker> {
        if hold.access.is_empty() {
            return Ok(Duration::ZERO);
        }
        let start = Instant::now();
        let mut on_wait = Some(on_wait);
        loop {
            // Created before looking, so a release in between still wakes us.
            let notified = self.changed.notified();
            let blocker = {
                let mut held = self.held.lock().unwrap();
                held.retain(|h| h.since.elapsed() < LEASE);
                match held.iter().find(|o| o.project == hold.project && o.chat != hold.chat && conflict(&hold.access, &o.access)) {
                    None => {
                        if hold.access.everything {
                            hold.before = Some(snapshot(root));
                        }
                        hold.since = Instant::now();
                        held.push(hold);
                        return Ok(start.elapsed());
                    }
                    Some(o) => Blocker {
                        chat_title: o.chat_title.clone(),
                        writing: o.access.writes_anything(),
                        what: if o.access.writes_anything() { o.access.describe_writes(root) } else { describe_reads(&o.access, root) },
                    },
                }
            };
            if let Some(f) = on_wait.take() {
                f(&blocker);
            }
            let left = max_wait.saturating_sub(start.elapsed());
            if left.is_zero() || !live() {
                return Err(blocker);
            }
            let _ = tokio::time::timeout(left.min(Duration::from_secs(2)), notified).await;
        }
    }

    /// The call finished (its result came back): release its lock. Returns its hold.
    pub fn release(&self, id: &str) -> Option<Hold> {
        let hold = {
            let mut held = self.held.lock().unwrap();
            let i = held.iter().position(|h| h.id == id)?;
            held.remove(i)
        };
        self.changed.notify_waiters();
        Some(hold)
    }

    /// The chat's turn ended or was stopped: release whatever it still holds.
    pub fn release_chat(&self, chat: &str) -> Vec<Hold> {
        let gone: Vec<Hold> = {
            let mut held = self.held.lock().unwrap();
            let (gone, keep): (Vec<Hold>, Vec<Hold>) = held.drain(..).partition(|h| h.chat == chat);
            *held = keep;
            gone
        };
        self.changed.notify_waiters();
        gone
    }
}

fn describe_reads(a: &Access, root: &Path) -> String {
    let names: Vec<String> = a.reads.iter().take(2).map(|p| crate::agent_access::rel(root, p)).collect();
    if names.is_empty() { "files".into() } else { names.join(", ") }
}

/// Size and modified time of every tracked file (relative paths).
pub fn snapshot(root: &Path) -> HashMap<String, (u64, u128)> {
    crate::backups::list_files(root).into_iter().map(|(rel, size, mtime)| (rel, (size, mtime))).collect()
}

/// Files changed (created, modified, deleted) between two snapshots.
pub fn changed_between(before: &HashMap<String, (u64, u128)>, after: &HashMap<String, (u64, u128)>) -> Vec<String> {
    let mut out: Vec<String> = after.iter().filter(|(k, v)| before.get(*k) != Some(v)).map(|(k, _)| k.clone()).collect();
    out.extend(before.keys().filter(|k| !after.contains_key(*k)).cloned());
    out.sort();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn reads(p: &[&str]) -> Access {
        Access { reads: p.iter().map(PathBuf::from).collect(), ..Default::default() }
    }
    fn writes(p: &[&str]) -> Access {
        Access { writes: p.iter().map(PathBuf::from).collect(), ..Default::default() }
    }
    fn hold(id: &str, chat: &str, a: Access) -> Hold {
        Hold::new(id.into(), "p".into(), chat.into(), format!("chat {chat}"), a)
    }

    #[test]
    fn who_waits_for_whom() {
        assert!(!conflict(&reads(&["/p/a.pptx"]), &reads(&["/p/a.pptx"]))); // readers share
        assert!(conflict(&reads(&["/p/a.pptx"]), &writes(&["/p/a.pptx"]))); // a reader waits for a writer
        assert!(conflict(&writes(&["/p/a.pptx"]), &reads(&["/p/a.pptx"]))); // a writer waits for a reader
        assert!(!conflict(&writes(&["/p/a.pptx"]), &writes(&["/p/b.pptx"]))); // different files run together
        assert!(conflict(&writes(&["/p/sub/a.md"]), &reads(&["/p"]))); // a folder covers its files
        assert!(conflict(&Access::everything(), &reads(&["/p/x"])));
        assert!(conflict(&reads(&["/p/x"]), &Access::everything()));
        assert!(!conflict(&Access::default(), &Access::everything())); // touches no files
    }

    #[tokio::test]
    async fn a_writer_waits_for_another_agents_writer_then_runs() {
        let locks = Arc::new(AgentLocks::default());
        let root = Path::new("/p");
        locks.acquire(hold("a1", "A", writes(&["/p/deck.pptx"])), root, MAX_WAIT, || true, |_| {}).await.ok().unwrap();
        // The same agent's next call doesn't wait; another file doesn't either.
        assert!(locks.acquire(hold("a2", "A", writes(&["/p/deck.pptx"])), root, Duration::from_millis(50), || true, |_| {}).await.is_ok());
        assert!(locks.acquire(hold("b0", "B", writes(&["/p/other.pptx"])), root, Duration::from_millis(50), || true, |_| {}).await.is_ok());
        // Agent B wants the same deck: it waits until A's call is done.
        let l2 = locks.clone();
        let waiter = tokio::spawn(async move {
            let mut told = None;
            let r = l2.acquire(hold("b1", "B", reads(&["/p/deck.pptx"])), Path::new("/p"), MAX_WAIT, || true, |b| told = Some(b.chat_title.clone())).await;
            (r.is_ok(), told)
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!waiter.is_finished());
        locks.release("a1");
        locks.release("a2");
        let (ok, told) = waiter.await.unwrap();
        assert!(ok);
        assert_eq!(told.as_deref(), Some("chat A"));
    }

    #[tokio::test]
    async fn a_wait_gives_up_after_its_limit_and_a_stopped_turn_releases_all() {
        let locks = AgentLocks::default();
        let root = Path::new("/p");
        locks.acquire(hold("a1", "A", Access::everything()), root, MAX_WAIT, || true, |_| {}).await.ok().unwrap();
        let r = locks.acquire(hold("b1", "B", reads(&["/p/x.md"])), root, Duration::from_millis(100), || true, |_| {}).await;
        assert!(r.is_err_and(|b| b.writing && b.chat_title == "chat A"));
        assert_eq!(locks.release_chat("A").len(), 1);
        assert!(locks.acquire(hold("b2", "B", reads(&["/p/x.md"])), root, Duration::from_millis(100), || true, |_| {}).await.is_ok());
    }

    #[tokio::test]
    async fn a_stopped_caller_stops_waiting() {
        let locks = Arc::new(AgentLocks::default());
        let root = Path::new("/p");
        locks.acquire(hold("a1", "A", writes(&["/p/deck.pptx"])), root, MAX_WAIT, || true, |_| {}).await.ok().unwrap();
        let stopped = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (l2, s2) = (locks.clone(), stopped.clone());
        let waiter = tokio::spawn(async move {
            l2.acquire(hold("b1", "B", writes(&["/p/deck.pptx"])), Path::new("/p"), MAX_WAIT, move || !s2.load(std::sync::atomic::Ordering::Relaxed), |_| {}).await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        stopped.store(true, std::sync::atomic::Ordering::Relaxed);
        // It notices within its next wake-up (at most 2 s) and gives up without taking the lock.
        assert!(tokio::time::timeout(Duration::from_secs(3), waiter).await.unwrap().unwrap().is_err());
        locks.release("a1");
        assert!(locks.release_chat("B").is_empty());
    }

    #[test]
    fn what_a_call_changed() {
        let before: HashMap<String, (u64, u128)> = [("a".into(), (1, 1)), ("b".into(), (2, 2))].into();
        let after: HashMap<String, (u64, u128)> = [("a".into(), (1, 1)), ("b".into(), (3, 5)), ("c".into(), (1, 1))].into();
        assert_eq!(changed_between(&before, &after), vec!["b", "c"]);
        let gone: HashMap<String, (u64, u128)> = [("a".into(), (1, 1))].into();
        assert_eq!(changed_between(&before, &gone), vec!["b"]);
    }
}
