//! Folder tree + raw file access for a project's folder.
//!
//! - `GET  /projects/{id}/tree`            — recursive listing (hidden/vendor dirs skipped)
//! - `GET  /projects/{id}/file?path=`      — raw bytes; `x-etag` header identifies the version
//! - `PUT  /projects/{id}/file?path=`      — atomic write of the raw body. `x-if-etag`
//!   (optional) rejects the write with 409 when the file changed underneath the
//!   client; `x-client-id` tags the resulting watcher event so the writer can
//!   skip reloading its own save.
//! - `POST /projects/{id}/open?path=`      — open with the default macOS app (PowerPoint…)
//! - `POST /projects/{id}/reveal?path=`    — reveal in Finder
//! - `POST /pick-folder`                   — native folder chooser (osascript)

use std::path::{Component, Path, PathBuf};
use std::time::UNIX_EPOCH;

use axum::body::Bytes;
use axum::extract::{Path as AxPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::error::{AppError, Result};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{id}/tree", get(tree))
        .route("/projects/{id}/file", get(read_file).put(write_file))
        .route("/projects/{id}/upload", post(upload))
        .route("/projects/{id}/open", post(open_external))
        .route("/projects/{id}/reveal", post(reveal))
        .route("/pick-folder", post(pick_folder))
}

/// Directory names never listed, watched or backed up.
pub const SKIP_DIRS: &[&str] = &["node_modules", "__pycache__", "target", "venv", "dist", "build"];

/// Is this path component something we hide (dotfiles, Office lock files, our temp files)?
pub fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.') || name.starts_with("~$") || name.ends_with(".deckedit-tmp") || name.ends_with(".pdfedit-tmp")
}

pub fn is_skipped_dir(name: &str) -> bool {
    is_hidden_name(name) || SKIP_DIRS.contains(&name)
}

/// True when any component of `rel` is hidden or a skipped directory.
pub fn rel_is_ignored(rel: &Path) -> bool {
    rel.components().any(|c| match c {
        Component::Normal(n) => {
            let n = n.to_string_lossy();
            is_skipped_dir(&n)
        }
        _ => false,
    })
}

/// Resolve a client-supplied relative path under `root`, refusing anything that
/// could escape it (absolute paths, `..`).
pub fn resolve_under(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel_path = Path::new(rel.trim_start_matches('/'));
    for c in rel_path.components() {
        match c {
            Component::Normal(_) | Component::CurDir => {}
            _ => return Err(AppError::BadRequest(format!("invalid path: {rel}"))),
        }
    }
    Ok(root.join(rel_path))
}

/// Version token for a file: modification time (ns) + size.
pub fn etag_of(path: &Path) -> Option<String> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some(format!("{mtime}-{}", md.len()))
}

/// Write via a temp file in the same directory + rename, so readers (the
/// watcher, PowerPoint, the agent) never see a half-written file.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    let tmp = path.with_file_name(format!(".{name}.{}.deckedit-tmp", std::process::id()));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    name: String,
    path: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<TreeNode>>,
}

const MAX_TREE_ENTRIES: usize = 6000;
const MAX_TREE_DEPTH: usize = 10;

fn build_tree(root: &Path, dir: &Path, depth: usize, count: &mut usize) -> Vec<TreeNode> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name().to_string_lossy().to_lowercase());
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for e in entries {
        if *count >= MAX_TREE_ENTRIES {
            break;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        let Ok(ft) = e.file_type() else { continue };
        let path = e.path();
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        if ft.is_dir() {
            if is_skipped_dir(&name) {
                continue;
            }
            *count += 1;
            let children = if depth < MAX_TREE_DEPTH {
                build_tree(root, &path, depth + 1, count)
            } else {
                Vec::new()
            };
            dirs.push(TreeNode { name, path: rel, kind: "dir", size: None, children: Some(children) });
        } else if ft.is_file() {
            if is_hidden_name(&name) {
                continue;
            }
            *count += 1;
            let size = e.metadata().ok().map(|m| m.len());
            files.push(TreeNode { name, path: rel, kind: "file", size, children: None });
        }
    }
    dirs.extend(files);
    dirs
}

async fn tree(State(state): State<AppState>, AxPath(id): AxPath<String>) -> Result<Json<Vec<TreeNode>>> {
    let root = state.projects.folder(&id)?;
    state.watchers.ensure(&state, &id, &root);
    let nodes = tokio::task::spawn_blocking(move || {
        let mut count = 0;
        build_tree(&root, &root, 0, &mut count)
    })
    .await
    .map_err(|e| AppError::Internal(e.to_string()))?;
    Ok(Json(nodes))
}

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

async fn read_file(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Query(q): Query<PathQuery>,
) -> Result<Response> {
    let root = state.projects.folder(&id)?;
    let path = resolve_under(&root, &q.path)?;
    // Read the version token before AND after so a write racing the read is
    // reported as a stale version (the client re-fetches on the next event).
    let etag = etag_of(&path).ok_or_else(|| AppError::NotFound(format!("{} not found", q.path)))?;
    let bytes = tokio::fs::read(&path).await?;
    let mime = mime_guess::from_path(&path).first_or_octet_stream();
    let mut resp = (StatusCode::OK, bytes).into_response();
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(mime.as_ref()).unwrap());
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-etag", HeaderValue::from_str(&etag).unwrap());
    Ok(resp)
}

async fn write_file(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Query(q): Query<PathQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>> {
    let root = state.projects.folder(&id)?;
    let path = resolve_under(&root, &q.path)?;
    if let Some(expected) = headers.get("x-if-etag").and_then(|v| v.to_str().ok()) {
        if !expected.is_empty() {
            if let Some(current) = etag_of(&path) {
                if current != expected {
                    return Err(AppError::Conflict(format!(
                        "{} changed on disk since it was loaded",
                        q.path
                    )));
                }
            }
        }
    }
    let client = headers
        .get("x-client-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let p2 = path.clone();
    tokio::task::spawn_blocking(move || write_atomic(&p2, &body))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    let etag = etag_of(&path).unwrap_or_default();
    state.watchers.note_self_write(&path, &etag, &client);
    Ok(Json(json!({ "etag": etag })))
}

/// `path` itself if free, else `name (2).ext`, `name (3).ext`, …
pub fn unique_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = path.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (2..)
        .map(|n| path.with_file_name(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// `POST /projects/{id}/upload?path=` — add a file dropped from Finder. Never
/// overwrites: a taken name gets " (2)", " (3)"… Returns the path written.
async fn upload(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Query(q): Query<PathQuery>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<serde_json::Value>> {
    let root = state.projects.folder(&id)?;
    let wanted = resolve_under(&root, &q.path)?;
    if wanted.file_name().is_none() || q.path.trim().is_empty() {
        return Err(AppError::BadRequest("missing file name".into()));
    }
    let path = unique_path(&wanted);
    let p2 = path.clone();
    tokio::task::spawn_blocking(move || write_atomic(&p2, &body))
        .await
        .map_err(|e| AppError::Internal(e.to_string()))??;
    let client = headers.get("x-client-id").and_then(|v| v.to_str().ok()).unwrap_or("");
    state.watchers.note_self_write(&path, &etag_of(&path).unwrap_or_default(), client);
    let rel = path.strip_prefix(&root).map(|p| p.to_string_lossy().replace('\\', "/")).unwrap_or_default();
    Ok(Json(json!({ "path": rel })))
}

async fn open_external(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Query(q): Query<PathQuery>,
) -> Result<Json<serde_json::Value>> {
    let root = state.projects.folder(&id)?;
    let path = resolve_under(&root, &q.path)?;
    open_path(&path, false).await?;
    Ok(Json(json!({ "ok": true })))
}

async fn reveal(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Query(q): Query<PathQuery>,
) -> Result<Json<serde_json::Value>> {
    let root = state.projects.folder(&id)?;
    let path = resolve_under(&root, &q.path)?;
    open_path(&path, true).await?;
    Ok(Json(json!({ "ok": true })))
}

/// Open a file with its app (PowerPoint for a deck), or show it in the file manager (`reveal`):
/// macOS `open` / `open -R`; Windows Explorer (`explorer /select,`, or the file itself: its default
/// app — not `cmd /c start`, which would read `&` in a name as its own); elsewhere `xdg-open`
/// (the folder, for reveal).
async fn open_path(path: &Path, reveal: bool) -> Result<()> {
    let p = path.to_string_lossy().into_owned();
    #[cfg(target_os = "macos")]
    let (program, args, check): (&str, Vec<String>, bool) = ("open", if reveal { vec!["-R".into(), p] } else { vec![p] }, true);
    // (Explorer's exit code says nothing about success.)
    #[cfg(windows)]
    let (program, args, check): (&str, Vec<String>, bool) = ("explorer", vec![if reveal { format!("/select,{p}") } else { p }], false);
    #[cfg(not(any(target_os = "macos", windows)))]
    let (program, args, check): (&str, Vec<String>, bool) =
        ("xdg-open", vec![if reveal { path.parent().map(|d| d.to_string_lossy().into_owned()).unwrap_or(p) } else { p }], true);
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(&args);
    crate::login_path::no_window(&mut cmd);
    let status = cmd.status().await.map_err(|e| AppError::Internal(format!("{program}: {e}")))?;
    if check && !status.success() {
        return Err(AppError::Internal(format!("{program} failed")));
    }
    Ok(())
}

async fn pick_folder() -> Result<Json<serde_json::Value>> {
    #[cfg(target_os = "macos")]
    {
        let out = tokio::process::Command::new("osascript")
            .arg("-e")
            .arg(r#"POSIX path of (choose folder with prompt "Choose the project folder")"#)
            .output()
            .await
            .map_err(|e| AppError::Internal(format!("folder dialog: {e}")))?;
        let path = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let path = path.trim_end_matches('/').to_string();
        Ok(Json(json!({ "path": if path.is_empty() { None } else { Some(path) } })))
    }
    // Windows: the system folder dialog (WinForms, from PowerShell), on top of the app.
    #[cfg(windows)]
    {
        let script = "Add-Type -AssemblyName System.Windows.Forms; \
            $owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }; \
            $d = New-Object System.Windows.Forms.FolderBrowserDialog; \
            $d.Description = 'Choose the project folder'; $d.ShowNewFolderButton = $true; \
            if ($d.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }";
        let mut cmd = tokio::process::Command::new("powershell");
        cmd.args(["-NoProfile", "-STA", "-NonInteractive", "-Command", script]);
        crate::login_path::no_window(&mut cmd);
        let out = cmd.output().await.map_err(|e| AppError::Internal(format!("folder dialog: {e}")))?;
        let path = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('\\').to_string();
        Ok(Json(json!({ "path": if path.is_empty() { None } else { Some(path) } })))
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        Err(AppError::Internal("the folder picker isn't available here; type the path instead".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_rejects_escapes() {
        let root = Path::new("/tmp/root");
        assert!(resolve_under(root, "../etc/passwd").is_err());
        assert!(resolve_under(root, "a/../../b").is_err());
        assert_eq!(resolve_under(root, "a/b.pptx").unwrap(), root.join("a/b.pptx"));
        // A leading slash is treated as root-relative, not absolute.
        assert_eq!(resolve_under(root, "/a.md").unwrap(), root.join("a.md"));
    }

    #[test]
    fn ignored_paths() {
        assert!(rel_is_ignored(Path::new(".git/config")));
        assert!(rel_is_ignored(Path::new("a/node_modules/x.js")));
        assert!(rel_is_ignored(Path::new("~$deck.pptx")));
        assert!(!rel_is_ignored(Path::new("decks/a.pptx")));
    }

    #[test]
    fn unique_names_never_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("deck.pptx");
        assert_eq!(unique_path(&p), p);
        std::fs::write(&p, b"x").unwrap();
        assert_eq!(unique_path(&p), dir.path().join("deck (2).pptx"));
        std::fs::write(dir.path().join("deck (2).pptx"), b"x").unwrap();
        assert_eq!(unique_path(&p), dir.path().join("deck (3).pptx"));
    }

    #[test]
    fn atomic_write_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("sub/x.bin");
        write_atomic(&p, b"hello").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"hello");
        // No temp files left behind.
        let names: Vec<_> = std::fs::read_dir(dir.path().join("sub"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["x.bin".to_string()]);
    }
}
