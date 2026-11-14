//! Managing the project's files from the file panel.
//!
//! - `POST /projects/{id}/mkdir`  `{ path }`       — new folder; a taken name gets " (2)"… Returns its path.
//! - `POST /projects/{id}/rename` `{ from, to }`   — rename or move one file/folder. Never
//!   overwrites (409), never moves a folder into itself; notes pinned on a moved
//!   deck (or on decks in a moved folder) follow it.
//! - `POST /projects/{id}/delete` `{ paths }`      — files go to the system Trash (recoverable);
//!   folders only when empty.

use std::path::{Path, PathBuf};

use axum::extract::{Path as AxPath, State};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::files::{is_hidden_name, resolve_under, unique_path};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{id}/mkdir", post(mkdir))
        .route("/projects/{id}/rename", post(rename))
        .route("/projects/{id}/delete", post(delete))
}

fn rel_of(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).map(|r| r.to_string_lossy().replace('\\', "/")).unwrap_or_default()
}

/// A path inside the project that names something (not the project root, not hidden).
fn project_path(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.trim().trim_matches('/');
    if rel.is_empty() {
        return Err(AppError::BadRequest("that's the project folder itself".into()));
    }
    let p = resolve_under(root, rel)?;
    if p.file_name().map(|n| is_hidden_name(&n.to_string_lossy())).unwrap_or(true) {
        return Err(AppError::BadRequest(format!("invalid name: {rel}")));
    }
    Ok(p)
}

#[derive(Deserialize)]
struct MkdirBody {
    path: String,
}

async fn mkdir(State(state): State<AppState>, AxPath(id): AxPath<String>, Json(b): Json<MkdirBody>) -> Result<Json<Value>> {
    let root = state.projects.folder(&id)?;
    let wanted = project_path(&root, &b.path)?;
    if !wanted.parent().is_some_and(|p| p.is_dir()) {
        return Err(AppError::BadRequest("the parent folder doesn't exist".into()));
    }
    let dir = unique_path(&wanted);
    std::fs::create_dir(&dir)?;
    Ok(Json(json!({ "path": rel_of(&root, &dir) })))
}

#[derive(Deserialize)]
struct RenameBody {
    from: String,
    to: String,
}

/// Why a rename/move can't happen, if it can't.
pub fn check_move(from: &Path, to: &Path) -> std::result::Result<(), String> {
    if !from.exists() {
        return Err("it no longer exists".into());
    }
    if to.exists() && to != from {
        return Err(format!("“{}” already exists there", to.file_name().unwrap_or_default().to_string_lossy()));
    }
    if from.is_dir() && to.starts_with(from) && to != from {
        return Err("a folder can't be moved into itself".into());
    }
    if !to.parent().is_some_and(|p| p.is_dir()) {
        return Err("the destination folder doesn't exist".into());
    }
    Ok(())
}

async fn rename(State(state): State<AppState>, AxPath(id): AxPath<String>, Json(b): Json<RenameBody>) -> Result<Json<Value>> {
    let root = state.projects.folder(&id)?;
    let from = project_path(&root, &b.from)?;
    let to = project_path(&root, &b.to)?;
    if from == to {
        return Ok(Json(json!({ "path": rel_of(&root, &to) })));
    }
    check_move(&from, &to).map_err(|why| AppError::Conflict(format!("Can't move {}: {why}", b.from)))?;
    std::fs::rename(&from, &to)?;
    let (from_rel, to_rel) = (rel_of(&root, &from), rel_of(&root, &to));
    if state.notes.rename_deck_paths(&id, &from_rel, &to_rel)? {
        crate::notes::notify_changed(&state, &id);
    }
    Ok(Json(json!({ "path": to_rel })))
}

#[derive(Deserialize)]
struct DeleteBody {
    paths: Vec<String>,
}

/// A folder holding nothing but macOS's .DS_Store counts as empty.
fn dir_is_empty(dir: &Path) -> std::io::Result<bool> {
    for e in std::fs::read_dir(dir)? {
        if e?.file_name() != ".DS_Store" {
            return Ok(false);
        }
    }
    Ok(true)
}

async fn delete(State(state): State<AppState>, AxPath(id): AxPath<String>, Json(b): Json<DeleteBody>) -> Result<Json<Value>> {
    let root = state.projects.folder(&id)?;
    let mut targets = Vec::new();
    for rel in &b.paths {
        let p = project_path(&root, rel)?;
        if !p.exists() {
            continue;
        }
        if p.is_dir() && !dir_is_empty(&p)? {
            return Err(AppError::Conflict(format!("“{rel}” isn't empty — only empty folders can be deleted here")));
        }
        targets.push(p);
    }
    let deleted: Vec<String> = targets.iter().map(|p| rel_of(&root, p)).collect();
    tokio::task::spawn_blocking(move || trash::delete_all(&targets))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))?
        .map_err(|e| AppError::Internal(format!("couldn't move to the Trash: {e}")))?;
    Ok(Json(json!({ "deleted": deleted })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_are_checked() {
        let tmp = tempfile::tempdir().unwrap();
        let r = tmp.path();
        std::fs::create_dir_all(r.join("a/b")).unwrap();
        std::fs::write(r.join("x.md"), "x").unwrap();
        std::fs::write(r.join("a/x.md"), "taken").unwrap();
        assert!(check_move(&r.join("x.md"), &r.join("y.md")).is_ok());
        assert!(check_move(&r.join("x.md"), &r.join("a/x.md")).unwrap_err().contains("already exists"));
        assert!(check_move(&r.join("a"), &r.join("a/b/a")).unwrap_err().contains("into itself"));
        assert!(check_move(&r.join("x.md"), &r.join("nope/x.md")).unwrap_err().contains("doesn't exist"));
        assert!(check_move(&r.join("gone.md"), &r.join("y.md")).unwrap_err().contains("no longer exists"));
    }

    #[test]
    fn only_empty_folders_count_as_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("d");
        std::fs::create_dir(&d).unwrap();
        std::fs::write(d.join(".DS_Store"), "").unwrap();
        assert!(dir_is_empty(&d).unwrap());
        std::fs::write(d.join("f.txt"), "").unwrap();
        assert!(!dir_is_empty(&d).unwrap());
    }
}
