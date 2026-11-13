//! Per-turn backups ("snapshots") of a project folder, so an agent turn can be
//! reverted with one click.
//!
//! Before every agent turn the backend copies the folder's files into
//! `<data_dir>/backups/<project>/<snapshot>/files/…` and writes a manifest. On
//! APFS `std::fs::copy` clones (copy-on-write), so this is cheap even for big
//! decks. After the turn, `changes()` compares the folder with the manifest;
//! `restore()` puts modified/deleted files back and moves files the turn
//! created into the snapshot's `created/` folder (never deleted outright).
//! Restoring first takes a fresh snapshot, so a revert can itself be undone.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};
use walkdir::WalkDir;

use crate::error::{AppError, Result};
use crate::files::{is_hidden_name, is_skipped_dir};

/// Files bigger than this are listed in the manifest but not copied (and so
/// can't be restored) — keeps a stray video from blowing up backup space.
const MAX_FILE_BYTES: u64 = 300 * 1024 * 1024;
/// Total copied bytes per snapshot.
const MAX_TOTAL_BYTES: u64 = 3 * 1024 * 1024 * 1024;
/// Snapshots kept per project (oldest pruned first).
const KEEP: usize = 40;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub rel: String,
    pub size: u64,
    pub mtime_ns: u128,
    pub copied: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub id: String,
    pub created_at: String,
    pub root: String,
    pub files: Vec<FileEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// "modified" | "created" | "deleted"
    pub kind: String,
    /// Whether restore() can bring this file back.
    pub restorable: bool,
}

fn snapshots_dir(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir.join("backups").join(project_id)
}

fn snapshot_dir(data_dir: &Path, project_id: &str, id: &str) -> PathBuf {
    snapshots_dir(data_dir, project_id).join(id)
}

fn stat(path: &Path) -> Option<(u64, u128)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some((md.len(), mtime))
}

/// Every regular file under `root` the app tracks (same skip rules as the tree).
fn list_files(root: &Path) -> Vec<(String, u64, u128)> {
    let mut out = Vec::new();
    let walker = WalkDir::new(root).follow_links(false).into_iter().filter_entry(|e| {
        if e.depth() == 0 {
            return true;
        }
        let name = e.file_name().to_string_lossy();
        if e.file_type().is_dir() {
            !is_skipped_dir(&name)
        } else {
            !is_hidden_name(&name)
        }
    });
    for e in walker.filter_map(|e| e.ok()) {
        if !e.file_type().is_file() {
            continue;
        }
        let Ok(rel) = e.path().strip_prefix(root) else { continue };
        if let Some((size, mtime)) = stat(e.path()) {
            out.push((rel.to_string_lossy().replace('\\', "/"), size, mtime));
        }
    }
    out
}

/// Copy the folder into a new snapshot and return its manifest.
pub fn create(data_dir: &Path, project_id: &str, root: &Path) -> Result<Manifest> {
    let id = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S"),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let dir = snapshot_dir(data_dir, project_id, &id);
    let files_dir = dir.join("files");
    std::fs::create_dir_all(&files_dir)?;
    let mut total = 0u64;
    let mut files = Vec::new();
    for (rel, size, mtime_ns) in list_files(root) {
        let copied = size <= MAX_FILE_BYTES && total + size <= MAX_TOTAL_BYTES && {
            let dst = files_dir.join(&rel);
            if let Some(parent) = dst.parent() {
                std::fs::create_dir_all(parent)?;
            }
            match std::fs::copy(root.join(&rel), &dst) {
                Ok(_) => true,
                Err(e) => {
                    tracing::warn!("backup copy {rel}: {e}");
                    false
                }
            }
        };
        if copied {
            total += size;
        }
        files.push(FileEntry { rel, size, mtime_ns, copied });
    }
    let manifest = Manifest {
        id: id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        root: root.to_string_lossy().into_owned(),
        files,
    };
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;
    prune(data_dir, project_id);
    Ok(manifest)
}

fn prune(data_dir: &Path, project_id: &str) {
    let dir = snapshots_dir(data_dir, project_id);
    let Ok(rd) = std::fs::read_dir(&dir) else { return };
    let mut ids: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    if ids.len() > KEEP {
        for id in &ids[..ids.len() - KEEP] {
            let _ = std::fs::remove_dir_all(dir.join(id));
        }
    }
}

pub fn load(data_dir: &Path, project_id: &str, id: &str) -> Result<Manifest> {
    if id.contains('/') || id.contains("..") {
        return Err(AppError::BadRequest("bad snapshot id".into()));
    }
    let path = snapshot_dir(data_dir, project_id, id).join("manifest.json");
    let text = std::fs::read_to_string(&path)
        .map_err(|_| AppError::NotFound(format!("snapshot {id} not found")))?;
    Ok(serde_json::from_str(&text)?)
}

/// Path of a file's backed-up copy (when it was copied).
pub fn backup_file(data_dir: &Path, project_id: &str, id: &str, rel: &str) -> Result<PathBuf> {
    let m = load(data_dir, project_id, id)?;
    let entry = m
        .files
        .iter()
        .find(|f| f.rel == rel && f.copied)
        .ok_or_else(|| AppError::NotFound(format!("{rel} is not in snapshot {id}")))?;
    Ok(snapshot_dir(data_dir, project_id, id).join("files").join(&entry.rel))
}

/// What changed in `root` since the snapshot was taken.
pub fn changes(m: &Manifest, root: &Path) -> Vec<Change> {
    let before: HashMap<&str, &FileEntry> = m.files.iter().map(|f| (f.rel.as_str(), f)).collect();
    let now = list_files(root);
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (rel, size, mtime) in &now {
        seen.insert(rel.clone());
        match before.get(rel.as_str()) {
            None => out.push(Change { path: rel.clone(), kind: "created".into(), restorable: true }),
            Some(f) if f.size != *size || f.mtime_ns != *mtime => out.push(Change {
                path: rel.clone(),
                kind: "modified".into(),
                restorable: f.copied,
            }),
            _ => {}
        }
    }
    for f in &m.files {
        if !seen.contains(&f.rel) {
            out.push(Change { path: f.rel.clone(), kind: "deleted".into(), restorable: f.copied });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Put the folder back the way the snapshot recorded it. Returns the id of the
/// safety snapshot taken first (restore it to undo the revert).
pub fn restore(data_dir: &Path, project_id: &str, id: &str, root: &Path) -> Result<String> {
    let m = load(data_dir, project_id, id)?;
    let safety = create(data_dir, project_id, root)?;
    let dir = snapshot_dir(data_dir, project_id, id);
    let created_dir = dir.join("created").join(&safety.id);
    for c in changes(&m, root) {
        let target = root.join(&c.path);
        match c.kind.as_str() {
            "created" => {
                let dst = created_dir.join(&c.path);
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                if std::fs::rename(&target, &dst).is_err() {
                    std::fs::copy(&target, &dst)?;
                    std::fs::remove_file(&target)?;
                }
            }
            _ if c.restorable => {
                let src = dir.join("files").join(&c.path);
                let bytes = std::fs::read(&src)?;
                crate::files::write_atomic(&target, &bytes)?;
            }
            _ => tracing::warn!("cannot restore {} (not backed up)", c.path),
        }
    }
    Ok(safety.id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_changes_and_restore() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.pptx"), b"v1").unwrap();
        std::fs::write(root.path().join("keep.md"), b"same").unwrap();
        std::fs::create_dir(root.path().join(".git")).unwrap();
        std::fs::write(root.path().join(".git/HEAD"), b"x").unwrap();

        let m = create(data.path(), "p", root.path()).unwrap();
        assert_eq!(m.files.len(), 2, "hidden dirs are skipped");

        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(root.path().join("a.pptx"), b"v2-longer").unwrap();
        std::fs::write(root.path().join("new.pdf"), b"n").unwrap();
        std::fs::remove_file(root.path().join("keep.md")).unwrap();

        let ch = changes(&m, root.path());
        let kinds: Vec<_> = ch.iter().map(|c| (c.path.as_str(), c.kind.as_str())).collect();
        assert_eq!(kinds, vec![("a.pptx", "modified"), ("keep.md", "deleted"), ("new.pdf", "created")]);

        let safety = restore(data.path(), "p", &m.id, root.path()).unwrap();
        assert_eq!(std::fs::read(root.path().join("a.pptx")).unwrap(), b"v1");
        assert_eq!(std::fs::read(root.path().join("keep.md")).unwrap(), b"same");
        assert!(!root.path().join("new.pdf").exists());

        // The revert itself can be undone.
        restore(data.path(), "p", &safety, root.path()).unwrap();
        assert_eq!(std::fs::read(root.path().join("a.pptx")).unwrap(), b"v2-longer");
        assert!(root.path().join("new.pdf").exists());
    }
}
