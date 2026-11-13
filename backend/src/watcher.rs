//! Folder watching → live reload.
//!
//! One recursive `notify` watcher per project folder, started lazily the first
//! time the project's tree is listed. Raw events are debounced (files written
//! by python-pptx or PowerPoint fire several events per save), then each
//! changed path is published on the event bus as
//! `{type:"file", projectId, path, etag, deleted, writer}`; a `{type:"tree"}`
//! event follows when files appeared or disappeared.
//!
//! `writer` is the client id of an app save that produced this exact version
//! (recorded by `note_self_write`), so the browser that saved it can skip
//! reloading its own change. Every other change (agent, PowerPoint, Finder) has
//! an empty writer and reloads the open document.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{RecursiveMode, Watcher};
use serde_json::json;
use tokio::sync::mpsc;

use crate::files::{etag_of, rel_is_ignored};
use crate::state::AppState;

const DEBOUNCE: Duration = Duration::from_millis(350);
/// How long a recorded self-write stays matchable against watcher events.
const SELF_WRITE_TTL: Duration = Duration::from_secs(30);

#[derive(Default)]
pub struct WatcherRegistry {
    /// project id → live watcher (dropping it stops watching).
    watchers: Mutex<HashMap<String, notify::RecommendedWatcher>>,
    /// absolute path → (etag, client id, when) of the app's own recent saves.
    self_writes: Mutex<HashMap<PathBuf, (String, String, Instant)>>,
}

impl WatcherRegistry {
    pub fn note_self_write(&self, path: &Path, etag: &str, client: &str) {
        let mut map = self.self_writes.lock().unwrap();
        map.retain(|_, (_, _, at)| at.elapsed() < SELF_WRITE_TTL);
        map.insert(path.to_path_buf(), (etag.to_string(), client.to_string(), Instant::now()));
    }

    fn writer_for(&self, path: &Path, etag: &str) -> String {
        let map = self.self_writes.lock().unwrap();
        match map.get(path) {
            Some((e, client, at)) if e == etag && at.elapsed() < SELF_WRITE_TTL => client.clone(),
            _ => String::new(),
        }
    }

    /// Start watching `root` for project `id` unless already watching.
    pub fn ensure(&self, state: &AppState, id: &str, root: &Path) {
        let mut watchers = self.watchers.lock().unwrap();
        if watchers.contains_key(id) {
            return;
        }
        let (tx, rx) = mpsc::unbounded_channel::<PathBuf>();
        let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, notify::EventKind::Access(_)) {
                    return;
                }
                for p in ev.paths {
                    let _ = tx.send(p);
                }
            }
        });
        let mut watcher = match watcher {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("watcher for {}: {e}", root.display());
                return;
            }
        };
        if let Err(e) = watcher.watch(root, RecursiveMode::Recursive) {
            tracing::warn!("watch {}: {e}", root.display());
            return;
        }
        watchers.insert(id.to_string(), watcher);
        tokio::spawn(debounce_loop(state.clone(), id.to_string(), root.to_path_buf(), rx));
    }
}

async fn debounce_loop(state: AppState, project_id: String, root: PathBuf, mut rx: mpsc::UnboundedReceiver<PathBuf>) {
    // Known etags so repeated events for an unchanged file are dropped.
    let mut known: HashMap<PathBuf, Option<String>> = HashMap::new();
    loop {
        let Some(first) = rx.recv().await else { return };
        let mut batch: HashSet<PathBuf> = HashSet::from([first]);
        let deadline = tokio::time::Instant::now() + DEBOUNCE;
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(p)) => {
                    batch.insert(p);
                }
                Ok(None) => return,
                Err(_) => break,
            }
        }
        let mut tree_changed = false;
        for path in batch {
            let Ok(rel) = path.strip_prefix(&root) else { continue };
            if rel.as_os_str().is_empty() || rel_is_ignored(rel) {
                continue;
            }
            if path.is_dir() {
                tree_changed = true;
                continue;
            }
            let etag = etag_of(&path);
            let prev = known.insert(path.clone(), etag.clone());
            if prev.as_ref() == Some(&etag) {
                continue;
            }
            if prev.is_none() || etag.is_none() || matches!(prev, Some(None)) {
                tree_changed = true;
            }
            let writer = etag
                .as_deref()
                .map(|e| state.watchers.writer_for(&path, e))
                .unwrap_or_default();
            state.publish(json!({
                "type": "file",
                "projectId": project_id,
                "path": rel.to_string_lossy().replace('\\', "/"),
                "etag": etag,
                "deleted": etag.is_none(),
                "writer": writer,
            }));
        }
        if tree_changed {
            state.publish(json!({ "type": "tree", "projectId": project_id }));
        }
    }
}
