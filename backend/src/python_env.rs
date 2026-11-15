//! The Python env the agent uses for decks (python-pptx, pymupdf, pypdf,
//! pillow, openpyxl): its `bin` directory goes first on the agent's PATH.
//!
//! Looked for, in order: `DECKEDIT_PYTHON_BIN`, the app's own env
//! (`<data dir>/venv`, made by `provision`), the repo checkout's `.venv`
//! (`./run.sh setup`). The desktop app provisions its own env on first launch
//! when none is found, in the background — so it works without the repo.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, RwLock};

use anyhow::{bail, Context};

const PACKAGES: [&str; 5] = ["python-pptx", "pymupdf", "pypdf", "pillow", "openpyxl"];
/// Written into `<data dir>/venv` once every package installed: a half-made env (no network, …) isn't used.
const READY_MARKER: &str = ".deck-edit-ready";
/// The marker an env made before the rename to Deck Edit carries.
const OLD_READY_MARKER: &str = ".pdf-edit-ready";

#[derive(Default)]
pub struct PythonEnv {
    bin: RwLock<Option<PathBuf>>,
    /// While provisioning (or after it failed): what to tell the user.
    status: Mutex<Option<String>>,
}

impl PythonEnv {
    pub fn locate(data_dir: &Path, repo_root: &Path) -> Self {
        let own = data_dir.join("venv");
        let candidates = [
            std::env::var("DECKEDIT_PYTHON_BIN").ok().map(PathBuf::from),
            (own.join(READY_MARKER).exists() || own.join(OLD_READY_MARKER).exists()).then(|| own.join("bin")),
            Some(repo_root.join(".venv/bin")),
        ];
        let bin = candidates.into_iter().flatten().find(|b| b.join("python3").exists());
        Self { bin: RwLock::new(bin), status: Mutex::new(None) }
    }

    pub fn bin(&self) -> Option<PathBuf> {
        self.bin.read().unwrap().clone()
    }

    pub fn status(&self) -> Option<String> {
        self.status.lock().unwrap().clone()
    }

    /// Make `<data dir>/venv` with the packages, in the background.
    pub fn provision(self: Arc<Self>, data_dir: PathBuf) {
        *self.status.lock().unwrap() = Some("Setting up the Python env for the agent (python-pptx…) — first launch, about a minute".into());
        tracing::info!("no Python env found — creating {}", data_dir.join("venv").display());
        tokio::task::spawn_blocking(move || match create(&data_dir) {
            Ok(bin) => {
                tracing::info!("Python env ready at {}", bin.display());
                *self.bin.write().unwrap() = Some(bin);
                *self.status.lock().unwrap() = None;
            }
            Err(e) => {
                tracing::warn!("couldn't set up the Python env: {e:#}");
                *self.status.lock().unwrap() = Some(format!("Couldn't set up the Python env: {e:#}"));
            }
        });
    }
}

fn create(data_dir: &Path) -> anyhow::Result<PathBuf> {
    let venv = data_dir.join("venv");
    let python = which("python3").unwrap_or_else(|| PathBuf::from("/usr/bin/python3"));
    run(Command::new(&python).arg("-m").arg("venv").arg("--clear").arg(&venv)).with_context(|| format!("{} -m venv", python.display()))?;
    run(Command::new(venv.join("bin/pip")).args(["install", "-q", "--upgrade"]).args(PACKAGES)).context("pip install")?;
    std::fs::write(venv.join(READY_MARKER), PACKAGES.join("\n"))?;
    Ok(venv.join("bin"))
}

fn run(cmd: &mut Command) -> anyhow::Result<()> {
    let out = cmd.output()?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.trim().chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
        bail!("{tail}");
    }
    Ok(())
}

fn which(bin: &str) -> Option<PathBuf> {
    std::env::var("PATH").ok()?.split(':').map(|d| Path::new(d).join(bin)).find(|p| p.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_half_made_own_env_is_not_used() {
        let dir = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join("venv/bin")).unwrap();
        std::fs::write(dir.path().join("venv/bin/python3"), "").unwrap();
        assert_eq!(PythonEnv::locate(dir.path(), repo.path()).bin(), None);
        std::fs::write(dir.path().join("venv").join(READY_MARKER), "").unwrap();
        assert_eq!(PythonEnv::locate(dir.path(), repo.path()).bin(), Some(dir.path().join("venv/bin")));
    }

    #[test]
    fn the_repo_env_is_the_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(repo.path().join(".venv/bin")).unwrap();
        std::fs::write(repo.path().join(".venv/bin/python3"), "").unwrap();
        assert_eq!(PythonEnv::locate(dir.path(), repo.path()).bin(), Some(repo.path().join(".venv/bin")));
    }
}
