//! Shared application state handed to every route.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

use crate::chat::ChatRegistry;
use crate::conversations::ConversationIndex;
use crate::notes::NotesStore;
use crate::permissions::Permissions;
use crate::projects::ProjectStore;
use crate::settings::SettingsStore;
use crate::watcher::WatcherRegistry;

#[derive(Clone)]
pub struct AppState {
    pub data_dir: PathBuf,
    pub port: u16,
    /// Secret the spawned CLI's hooks and MCP client present (`X-DeckEdit-Token`),
    /// so only the harness we launched can approve tool calls or call our tools.
    pub token: String,
    /// The Python env (python-pptx, pymupdf…) whose `bin` goes first on the
    /// agent's PATH, when present (the desktop app may still be setting it up).
    pub python: Arc<crate::python_env::PythonEnv>,
    pub projects: Arc<ProjectStore>,
    pub watchers: Arc<WatcherRegistry>,
    pub events: broadcast::Sender<Value>,
    pub chats: Arc<ChatRegistry>,
    pub perms: Arc<Permissions>,
    /// Files held by the agents' running tool calls (several agents in one project; agent_locks.rs).
    pub locks: Arc<crate::agent_locks::AgentLocks>,
    pub notes: Arc<NotesStore>,
    pub settings: Arc<SettingsStore>,
    /// The user's past Claude conversations on this machine (CLI, desktop Code, Cowork).
    pub conversations: Arc<ConversationIndex>,
    /// project id → what the user is looking at (deck, slide, selection),
    /// reported by the frontend; read by the agent's `get_user_view` tool.
    pub views: Arc<Mutex<HashMap<String, Value>>>,
    /// (project id, deck path) → slide list `[{slideId, index, title}]`,
    /// reported by the frontend whenever a deck loads.
    pub deck_maps: Arc<Mutex<HashMap<(String, String), Value>>>,
    /// screenshot (or deck comparison) request id → resolver for the PNG data URL (or the
    /// comparison's text) the frontend posts back.
    pub screenshots: Arc<Mutex<HashMap<String, oneshot::Sender<String>>>>,
}

impl AppState {
    /// Broadcast one event to every connected browser (`GET /api/events`).
    pub fn publish(&self, event: Value) {
        let _ = self.events.send(event);
    }
}
