//! Per-turn backups ("snapshots") of a project folder, so an agent turn can be
//! reverted with one click.
//!
//! Before every agent turn the backend snapshots the folder's files into
//! `<data_dir>/backups/<project>/<snapshot>/files/…` and writes a manifest.
//! A file unchanged since the previous snapshot (same size and modified time)
//! is hard-linked to that snapshot's copy — no bytes copied, no extra space, on
//! every OS. Only new or changed files are copied (on APFS `std::fs::copy`
//! clones copy-on-write, so even those are near-free on macOS). Snapshots are
//! never written to after creation, so sharing a file between them is safe,
//! and pruning one leaves the others' links intact. After the turn, `changes()` compares the folder with the manifest;
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
    /// Every (tracked) folder at snapshot time, so a revert can recreate
    /// folders a turn removed and remove folders it added.
    #[serde(default)]
    pub dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub path: String,
    /// "modified" | "created" | "deleted" | "moved"
    pub kind: String,
    /// For "moved": where the file was before the turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    /// Whether restore() can bring this file back.
    pub restorable: bool,
}

fn snapshots_dir(data_dir: &Path, project_id: &str) -> PathBuf {
    data_dir.join("backups").join(project_id)
}

fn snapshot_dir(data_dir: &Path, project_id: &str, id: &str) -> PathBuf {
    snapshots_dir(data_dir, project_id).join(id)
}

/// Whether a snapshot is still kept (only the latest `KEEP` are; older ones are pruned).
pub fn exists(data_dir: &Path, project_id: &str, id: &str) -> bool {
    !id.contains('/') && !id.contains("..") && snapshot_dir(data_dir, project_id, id).join("manifest.json").is_file()
}

fn stat(path: &Path) -> Option<(u64, u128)> {
    let md = std::fs::metadata(path).ok()?;
    let mtime = md.modified().ok()?.duration_since(UNIX_EPOCH).ok()?.as_nanos();
    Some((md.len(), mtime))
}

fn tracked_walker(root: &Path) -> impl Iterator<Item = walkdir::DirEntry> {
    WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                !is_skipped_dir(&name)
            } else {
                !is_hidden_name(&name)
            }
        })
        .filter_map(|e| e.ok())
}

/// Every tracked folder under `root` (relative, excluding the root itself).
fn list_dirs(root: &Path) -> Vec<String> {
    tracked_walker(root)
        .filter(|e| e.depth() > 0 && e.file_type().is_dir())
        .filter_map(|e| e.path().strip_prefix(root).ok().map(|r| r.to_string_lossy().replace('\\', "/")))
        .collect()
}

/// Every regular file under `root` the app tracks (same skip rules as the tree).
pub(crate) fn list_files(root: &Path) -> Vec<(String, u64, u128)> {
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

/// The most recent existing snapshot (ids start with a UTC timestamp, so they sort by time).
fn latest(data_dir: &Path, project_id: &str) -> Option<Manifest> {
    let dir = snapshots_dir(data_dir, project_id);
    let mut ids: Vec<String> = std::fs::read_dir(&dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().join("manifest.json").is_file())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    ids.sort();
    ids.into_iter().rev().find_map(|id| load(data_dir, project_id, &id).ok())
}

/// How a snapshot was made (for the log, and tests).
#[derive(Debug, Default, Clone, Copy, PartialEq)]
pub struct SnapshotStats {
    pub linked: usize,
    pub copied: usize,
    pub copied_bytes: u64,
    pub skipped: usize,
}

/// Snapshot the folder and return its manifest.
pub fn create(data_dir: &Path, project_id: &str, root: &Path) -> Result<Manifest> {
    create_with_stats(data_dir, project_id, root).map(|(m, _)| m)
}

pub fn create_with_stats(data_dir: &Path, project_id: &str, root: &Path) -> Result<(Manifest, SnapshotStats)> {
    let started = std::time::Instant::now();
    // Unchanged files are linked to the previous snapshot's copies.
    let prev = latest(data_dir, project_id);
    let prev_files: HashMap<&str, &FileEntry> = prev
        .as_ref()
        .map(|m| m.files.iter().filter(|f| f.copied).map(|f| (f.rel.as_str(), f)).collect())
        .unwrap_or_default();
    let prev_dir = prev.as_ref().map(|m| snapshot_dir(data_dir, project_id, &m.id).join("files"));

    let id = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f"),
        &uuid::Uuid::new_v4().to_string()[..8]
    );
    let dir = snapshot_dir(data_dir, project_id, &id);
    let files_dir = dir.join("files");
    std::fs::create_dir_all(&files_dir)?;
    let mut stats = SnapshotStats::default();
    let mut files = Vec::new();
    for (rel, size, mtime_ns) in list_files(root) {
        let dst = files_dir.join(&rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)?;
        }
        // Same size and modified time as in the previous snapshot: share its copy.
        let linked = prev_files
            .get(rel.as_str())
            .filter(|f| f.size == size && f.mtime_ns == mtime_ns)
            .and_then(|_| prev_dir.as_ref().map(|d| d.join(&rel)))
            .is_some_and(|src| std::fs::hard_link(&src, &dst).is_ok());
        let copied = linked
            || (size <= MAX_FILE_BYTES && stats.copied_bytes + size <= MAX_TOTAL_BYTES && {
                match std::fs::copy(root.join(&rel), &dst) {
                    Ok(_) => true,
                    Err(e) => {
                        tracing::warn!("backup copy {rel}: {e}");
                        false
                    }
                }
            });
        if linked {
            stats.linked += 1;
        } else if copied {
            stats.copied += 1;
            stats.copied_bytes += size;
        } else {
            stats.skipped += 1;
        }
        files.push(FileEntry { rel, size, mtime_ns, copied });
    }
    tracing::info!(
        "backup {id}: {} unchanged (linked), {} copied ({:.1} MB), {} skipped, {:?}",
        stats.linked,
        stats.copied,
        stats.copied_bytes as f64 / 1_048_576.0,
        stats.skipped,
        started.elapsed()
    );
    let manifest = Manifest {
        id: id.clone(),
        created_at: chrono::Utc::now().to_rfc3339(),
        root: root.to_string_lossy().into_owned(),
        files,
        dirs: list_dirs(root),
    };
    std::fs::write(dir.join("manifest.json"), serde_json::to_vec_pretty(&manifest)?)?;
    prune(data_dir, project_id);
    Ok((manifest, stats))
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
/// What changed in `root` since the snapshot was taken. A file that vanished
/// from one path and appeared at another with the same size and modified time
/// (a move/rename keeps both) is reported once, as "moved".
pub fn changes(m: &Manifest, root: &Path) -> Vec<Change> {
    let before: HashMap<&str, &FileEntry> = m.files.iter().map(|f| (f.rel.as_str(), f)).collect();
    let now = list_files(root);
    let mut out = Vec::new();
    let mut created: Vec<(String, u64, u128)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (rel, size, mtime) in &now {
        seen.insert(rel.clone());
        match before.get(rel.as_str()) {
            None => created.push((rel.clone(), *size, *mtime)),
            Some(f) if f.size != *size || f.mtime_ns != *mtime => out.push(Change {
                path: rel.clone(),
                kind: "modified".into(),
                from: None,
                restorable: f.copied,
            }),
            _ => {}
        }
    }
    let mut deleted: Vec<&FileEntry> = m.files.iter().filter(|f| !seen.contains(&f.rel)).collect();
    for (rel, size, mtime) in created {
        // Prefer a vanished file with the same name (moved to another folder), then any.
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let pick = deleted
            .iter()
            .position(|f| f.size == size && f.mtime_ns == mtime && f.rel.rsplit('/').next() == Some(name.as_str()))
            .or_else(|| deleted.iter().position(|f| f.size == size && f.mtime_ns == mtime && size > 0));
        match pick {
            Some(i) => {
                let from = deleted.remove(i);
                out.push(Change { path: rel, kind: "moved".into(), from: Some(from.rel.clone()), restorable: true });
            }
            None => out.push(Change { path: rel, kind: "created".into(), from: None, restorable: true }),
        }
    }
    for f in deleted {
        out.push(Change { path: f.rel.clone(), kind: "deleted".into(), from: None, restorable: f.copied });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

/// Put the folder back the way the snapshot recorded it — or, with `only`, just those
/// files (a turn's own changes: other agents' and the user's later work elsewhere stays).
/// Returns the id of the safety snapshot taken first (restore it to undo the revert).
pub fn restore(data_dir: &Path, project_id: &str, id: &str, root: &Path, only: Option<&std::collections::HashSet<String>>) -> Result<String> {
    let m = load(data_dir, project_id, id)?;
    let safety = create(data_dir, project_id, root)?;
    let dir = snapshot_dir(data_dir, project_id, id);
    let created_dir = dir.join("created").join(&safety.id);
    let mut all = changes(&m, root);
    if let Some(only) = only {
        all.retain(|c| only.contains(&c.path) || c.from.as_ref().is_some_and(|f| only.contains(f)));
    }
    // Moves first: put each moved file back where it was (a rename — no copy,
    // and it works even for files too big to have been backed up). Doing these
    // before anything else frees the old paths and empties the new folders.
    for c in all.iter().filter(|c| c.kind == "moved") {
        let (Some(from), target) = (c.from.as_deref(), root.join(&c.path)) else { continue };
        let back = root.join(from);
        if let Some(parent) = back.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if std::fs::rename(&target, &back).is_err() {
            std::fs::copy(&target, &back)?;
            std::fs::remove_file(&target)?;
        }
    }
    for c in all.iter().filter(|c| c.kind != "moved") {
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
    if only.is_none() {
        restore_dirs(&m, root);
    } else {
        // Folders the turn created for files now taken away: removed once empty (never one with files).
        for c in all.iter().filter(|c| c.kind == "created") {
            let mut dir = Path::new(&c.path).parent();
            while let Some(d) = dir.filter(|d| !d.as_os_str().is_empty()) {
                if std::fs::remove_dir(root.join(d)).is_err() {
                    break;
                }
                dir = d.parent();
            }
        }
    }
    Ok(safety.id)
}

/// Make the folder structure match the snapshot: recreate folders it had
/// (e.g. emptied and removed by the turn), and remove folders the turn added
/// once they are empty. Folders that still hold files are never removed.
/// Snapshots taken before folders were recorded skip this.
fn restore_dirs(m: &Manifest, root: &Path) {
    let mut keep: std::collections::HashSet<String> = m.dirs.iter().cloned().collect();
    // Parents of every snapshot file existed too (covers old manifests without `dirs`).
    for f in &m.files {
        let mut p = Path::new(&f.rel).parent();
        while let Some(d) = p.filter(|d| !d.as_os_str().is_empty()) {
            keep.insert(d.to_string_lossy().replace('\\', "/"));
            p = d.parent();
        }
    }
    for d in &m.dirs {
        let _ = std::fs::create_dir_all(root.join(d));
    }
    // Deepest first, so a new folder whose new subfolders empty out goes too.
    let mut now = list_dirs(root);
    now.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    for d in now {
        if !keep.contains(&d) {
            let _ = std::fs::remove_dir(root.join(&d)); // only succeeds when empty
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A second snapshot shares unchanged files with the first (hard links:
    /// same inode) and copies only what changed — and pruning or restoring
    /// through shared files keeps every snapshot's contents intact.
    #[test]
    fn unchanged_files_are_linked_not_copied() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("big.pptx"), vec![7u8; 100_000]).unwrap();
        std::fs::write(root.path().join("notes.md"), b"v1").unwrap();
        let (m1, s1) = create_with_stats(data.path(), "p", root.path()).unwrap();
        assert_eq!((s1.linked, s1.copied), (0, 2));

        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(root.path().join("notes.md"), b"v2-changed").unwrap();
        let (m2, s2) = create_with_stats(data.path(), "p", root.path()).unwrap();
        assert_eq!((s2.linked, s2.copied), (1, 1), "big.pptx linked, notes.md copied");
        assert_eq!(s2.copied_bytes, 10);

        let f = |m: &Manifest, rel: &str| data.path().join("backups/p").join(&m.id).join("files").join(rel);
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let ino = |p: PathBuf| std::fs::metadata(p).unwrap().ino();
            assert_eq!(ino(f(&m1, "big.pptx")), ino(f(&m2, "big.pptx")));
            assert_ne!(ino(f(&m1, "notes.md")), ino(f(&m2, "notes.md")));
        }
        // Each snapshot still holds its own version.
        assert_eq!(std::fs::read(f(&m1, "notes.md")).unwrap(), b"v1");
        assert_eq!(std::fs::read(f(&m2, "notes.md")).unwrap(), b"v2-changed");

        // Removing the first snapshot leaves the second's linked copy readable.
        std::fs::remove_dir_all(data.path().join("backups/p").join(&m1.id)).unwrap();
        assert_eq!(std::fs::read(f(&m2, "big.pptx")).unwrap().len(), 100_000);

        // Restoring writes new files into the folder; the backup copies are untouched.
        std::fs::write(root.path().join("big.pptx"), b"agent rewrote it").unwrap();
        restore(data.path(), "p", &m2.id, root.path(), None).unwrap();
        assert_eq!(std::fs::read(root.path().join("big.pptx")).unwrap().len(), 100_000);
        assert_eq!(std::fs::read(f(&m2, "big.pptx")).unwrap().len(), 100_000);
    }

    /// Only the latest `KEEP` snapshots stay; `exists` tells a pruned one (whose turn can then no
    /// longer be reverted or compared) from a kept one, and refuses path-like ids.
    #[test]
    fn exists_reports_pruned_snapshots() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("a.md"), b"x").unwrap();
        let ids: Vec<String> = (0..=KEEP).map(|_| create(data.path(), "p", root.path()).unwrap().id).collect();
        assert!(!exists(data.path(), "p", &ids[0]), "the oldest was pruned");
        assert!(exists(data.path(), "p", &ids[1]));
        assert!(exists(data.path(), "p", &ids[KEEP]));
        assert!(!exists(data.path(), "p", "../p"));
        assert!(!exists(data.path(), "other", &ids[KEEP]));
    }

    /// A turn that reorganizes the folder (moves files into new folders,
    /// renames one, removes a folder) is reported as moves and reverts to the
    /// exact old structure — by moving files back, which also works for files
    /// that were too big to back up.
    #[test]
    fn reorganization_reverts_to_the_old_structure() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        let r = root.path();
        std::fs::create_dir_all(r.join("old/sub")).unwrap();
        std::fs::create_dir_all(r.join("empty-folder")).unwrap();
        std::fs::write(r.join("deck.pptx"), vec![1u8; 5000]).unwrap();
        std::fs::write(r.join("old/sub/notes.md"), b"notes").unwrap();
        std::fs::write(r.join("old/huge.mov"), vec![2u8; 3000]).unwrap();
        let m = create(data.path(), "p", r).unwrap();
        // Pretend huge.mov was too big to back up.
        let mut m2 = m.clone();
        for f in m2.files.iter_mut() {
            if f.rel == "old/huge.mov" {
                f.copied = false;
            }
        }
        let mpath = data.path().join("backups/p").join(&m.id).join("manifest.json");
        std::fs::write(&mpath, serde_json::to_vec(&m2).unwrap()).unwrap();

        // The "agent" reorganizes.
        std::fs::create_dir_all(r.join("decks/2026")).unwrap();
        std::fs::rename(r.join("deck.pptx"), r.join("decks/2026/Investor Deck.pptx")).unwrap();
        std::fs::create_dir_all(r.join("media")).unwrap();
        std::fs::rename(r.join("old/huge.mov"), r.join("media/huge.mov")).unwrap();
        std::fs::create_dir_all(r.join("docs")).unwrap();
        std::fs::rename(r.join("old/sub/notes.md"), r.join("docs/notes.md")).unwrap();
        std::fs::remove_dir_all(r.join("old")).unwrap();
        std::fs::remove_dir(r.join("empty-folder")).unwrap();
        std::fs::write(r.join("docs/new-file.md"), b"brand new").unwrap();

        let ch = changes(&m2, r);
        let moved: Vec<(&str, &str)> = ch.iter().filter(|c| c.kind == "moved").map(|c| (c.from.as_deref().unwrap(), c.path.as_str())).collect();
        assert_eq!(moved.len(), 3, "{ch:?}");
        assert!(moved.contains(&("deck.pptx", "decks/2026/Investor Deck.pptx")));
        assert!(moved.contains(&("old/huge.mov", "media/huge.mov")));
        assert!(ch.iter().any(|c| c.kind == "created" && c.path == "docs/new-file.md"));

        restore(data.path(), "p", &m.id, r, None).unwrap();
        assert_eq!(std::fs::read(r.join("deck.pptx")).unwrap().len(), 5000);
        assert_eq!(std::fs::read(r.join("old/sub/notes.md")).unwrap(), b"notes");
        assert_eq!(std::fs::read(r.join("old/huge.mov")).unwrap().len(), 3000, "un-backed-up file moved back");
        assert!(r.join("empty-folder").is_dir(), "removed empty folder recreated");
        for gone in ["decks", "media", "docs"] {
            assert!(!r.join(gone).exists(), "{gone} should be gone after revert");
        }
    }

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

        let safety = restore(data.path(), "p", &m.id, root.path(), None).unwrap();
        assert_eq!(std::fs::read(root.path().join("a.pptx")).unwrap(), b"v1");
        assert_eq!(std::fs::read(root.path().join("keep.md")).unwrap(), b"same");
        assert!(!root.path().join("new.pdf").exists());

        // The revert itself can be undone.
        restore(data.path(), "p", &safety, root.path(), None).unwrap();
        assert_eq!(std::fs::read(root.path().join("a.pptx")).unwrap(), b"v2-longer");
        assert!(root.path().join("new.pdf").exists());
    }

    #[test]
    fn a_turn_reverts_only_its_own_files() {
        let data = tempfile::tempdir().unwrap();
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("mine.pptx"), b"v1").unwrap();
        std::fs::write(root.path().join("theirs.pptx"), b"t1").unwrap();
        let m = create(data.path(), "p", root.path()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        // This turn changed mine.pptx and created out/chart.png; another agent changed theirs.pptx.
        std::fs::write(root.path().join("mine.pptx"), b"v2-longer").unwrap();
        std::fs::create_dir(root.path().join("out")).unwrap();
        std::fs::write(root.path().join("out/chart.png"), b"png").unwrap();
        std::fs::write(root.path().join("theirs.pptx"), b"t2-longer").unwrap();
        let only: std::collections::HashSet<String> = ["mine.pptx".to_string(), "out/chart.png".to_string()].into();
        restore(data.path(), "p", &m.id, root.path(), Some(&only)).unwrap();
        assert_eq!(std::fs::read(root.path().join("mine.pptx")).unwrap(), b"v1");
        assert!(!root.path().join("out").exists(), "the emptied folder the turn made is gone");
        assert_eq!(std::fs::read(root.path().join("theirs.pptx")).unwrap(), b"t2-longer", "the other agent's work stays");
    }
}
