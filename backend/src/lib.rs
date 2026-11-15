//! PPTX Edit backend: a local server for the slide/PDF editor.
//!
//! Serves the built frontend plus a JSON API under `/api`: projects (a folder +
//! chats), the folder tree and raw file read/write, live file-change events,
//! slide notes, agent chats running the Claude Code CLI, per-turn backups, and
//! an MCP endpoint the agent calls back into.
//!
//! Run by the `pdf-edit` binary (`./run.sh`, port 3101) and, in-process, by
//! the desktop app (`desktop/`), which shows it in its own window.

mod backups;
mod chat;
mod chat_images;
mod claude_cli;
mod conversations;
mod error;
mod events;
mod file_ops;
mod files;
mod mcp;
mod notes;
mod permissions;
mod projects;
mod python_env;
mod settings;
mod state;
mod watcher;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum::{Json, Router};
use tokio::sync::oneshot;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

pub struct ServerConfig {
    /// Projects, chats, settings, backups, logs (`~/.ppt-edit`).
    pub data_dir: PathBuf,
    /// The built frontend (`frontend/dist`).
    pub frontend_dist: PathBuf,
    /// Set up a Python env in `<data dir>/venv` (in the background) when none
    /// is found — the desktop app, which may run without the repo's `.venv`.
    pub provision_python: bool,
}

/// The repo checkout this was built from.
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

/// The checkout's built frontend (the dev server's, and the desktop app's in debug builds).
pub fn repo_frontend_dist() -> PathBuf {
    repo_root().join("frontend/dist")
}

/// `PDFEDIT_DATA_DIR`, else `~/.ppt-edit`. Data from before the rename (in
/// `~/.pdf-edit`) is moved there the first time.
pub fn default_data_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("PDFEDIT_DATA_DIR") {
        return PathBuf::from(dir);
    }
    let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
    let dir = home.join(".ppt-edit");
    let old = home.join(".pdf-edit");
    if !dir.exists() && old.is_dir() {
        let _ = std::fs::rename(&old, &dir);
    }
    dir
}

/// Log to stderr, or (the desktop app) append to `log_file`.
pub fn init_logging(log_file: Option<&Path>) {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "pdf_edit=info,tower_http=warn".into());
    let file = log_file.and_then(|p| {
        if let Some(dir) = p.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
    });
    match file {
        Some(f) => tracing_subscriber::fmt().with_env_filter(filter).with_ansi(false).with_writer(Mutex::new(f)).init(),
        None => tracing_subscriber::fmt().with_env_filter(filter).init(),
    }
}

/// Serve on `listener` until the process ends. `ready` fires once the server is
/// about to accept requests (the desktop app then points its window at it).
pub async fn run_server(listener: std::net::TcpListener, config: ServerConfig, ready: Option<oneshot::Sender<()>>) -> anyhow::Result<()> {
    let ServerConfig { data_dir, frontend_dist, provision_python } = config;
    std::fs::create_dir_all(&data_dir)?;
    listener.set_nonblocking(true)?;
    let addr = listener.local_addr()?;

    let python = Arc::new(python_env::PythonEnv::locate(&data_dir, &repo_root()));
    if python.bin().is_none() {
        if provision_python {
            python.clone().provision(data_dir.clone());
        } else {
            tracing::warn!("no Python env found (.venv) — run `./run.sh setup` so the agent has python-pptx");
        }
    }

    let (events, _) = tokio::sync::broadcast::channel(4096);
    let state = AppState {
        data_dir: data_dir.clone(),
        port: addr.port(),
        token: uuid::Uuid::new_v4().to_string(),
        python,
        projects: Arc::new(projects::ProjectStore::load(&data_dir)),
        watchers: Arc::new(watcher::WatcherRegistry::default()),
        events,
        chats: Arc::new(chat::ChatRegistry::load(&data_dir)),
        perms: Arc::new(permissions::Permissions::default()),
        notes: Arc::new(notes::NotesStore::new(&data_dir)),
        settings: Arc::new(settings::SettingsStore::load(&data_dir)),
        conversations: Arc::new(conversations::ConversationIndex::default()),
        views: Arc::new(Mutex::new(HashMap::new())),
        deck_maps: Arc::new(Mutex::new(HashMap::new())),
        screenshots: Arc::new(Mutex::new(HashMap::new())),
    };

    let api = Router::new()
        .route("/health", get(|| async { Json(serde_json::json!({ "ok": true })) }))
        .merge(projects::routes())
        .merge(files::routes())
        .merge(file_ops::routes())
        .merge(events::routes())
        .merge(notes::routes())
        .merge(chat::routes())
        .merge(permissions::routes())
        .merge(mcp::routes())
        .merge(settings::routes())
        .merge(conversations::routes());

    let static_files = ServeDir::new(&frontend_dist).not_found_service(ServeFile::new(frontend_dist.join("index.html")));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let listener = tokio::net::TcpListener::from_std(listener)?;
    tracing::info!("PPTX Edit listening on http://{addr} (data: {}, frontend: {})", data_dir.display(), frontend_dist.display());
    if let Some(ready) = ready {
        let _ = ready.send(());
    }
    axum::serve(listener, app).await?;
    Ok(())
}
