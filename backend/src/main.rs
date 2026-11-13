//! PPTX Edit backend: a local server for the slide/PDF editor.
//!
//! Serves the built frontend plus a JSON API under `/api`: projects (a folder +
//! chats), the folder tree and raw file read/write, live file-change events,
//! slide notes, agent chats running the Claude Code CLI, per-turn backups, and
//! an MCP endpoint the agent calls back into.

mod backups;
mod chat;
mod chat_images;
mod claude_cli;
mod conversations;
mod error;
mod events;
mod files;
mod mcp;
mod notes;
mod permissions;
mod projects;
mod settings;
mod state;
mod watcher;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use axum::extract::DefaultBodyLimit;
use axum::routing::get;
use axum::{Json, Router};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use crate::state::AppState;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn python_bin() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("PDFEDIT_PYTHON_BIN") {
        return Some(PathBuf::from(p));
    }
    let candidate = repo_root().join(".venv/bin");
    candidate.join("python3").exists().then_some(candidate)
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "pdf_edit=info,tower_http=warn".into()),
        )
        .init();

    let port: u16 = std::env::args()
        .skip_while(|a| a != "--port")
        .nth(1)
        .and_then(|p| p.parse().ok())
        .or_else(|| std::env::var("PDFEDIT_PORT").ok().and_then(|p| p.parse().ok()))
        .unwrap_or(3101);

    let data_dir = std::env::var("PDFEDIT_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")).join(".pdf-edit"));
    std::fs::create_dir_all(&data_dir)?;

    let (events, _) = tokio::sync::broadcast::channel(4096);
    let python_bin = python_bin();
    if python_bin.is_none() {
        tracing::warn!("no Python env found (.venv) — run `./run.sh setup` so the agent has python-pptx");
    }
    let state = AppState {
        data_dir: data_dir.clone(),
        port,
        token: uuid::Uuid::new_v4().to_string(),
        python_bin,
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
        .merge(events::routes())
        .merge(notes::routes())
        .merge(chat::routes())
        .merge(permissions::routes())
        .merge(mcp::routes())
        .merge(settings::routes())
        .merge(conversations::routes());

    let dist = repo_root().join("frontend/dist");
    let static_files = ServeDir::new(&dist).not_found_service(ServeFile::new(dist.join("index.html")));

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(static_files)
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024))
        .layer(CorsLayer::permissive())
        .with_state(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!("PPTX Edit listening on http://{addr} (data: {})", data_dir.display());
    axum::serve(listener, app).await?;
    Ok(())
}
