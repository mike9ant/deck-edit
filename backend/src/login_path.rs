//! The PATH the Claude Code CLI is found and run with.
//!
//! An app opened from the Finder or the Dock gets a bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`):
//! neither `claude` nor the tools the agent runs (python3, git, brew-installed commands) would be
//! found. So the PATH is the one the user's interactive login shell sets up, plus the places
//! `claude` is usually installed — the official installer's `~/.local/bin`, Homebrew, and the
//! npm / Node version managers (nvm, volta, asdf, bun, a custom npm prefix).
//!
//! It is worked out at startup (`adopt_at_startup`, before any threads) and again when `claude`
//! isn't found (`refresh`): a user who installs it — or edits their shell profile — while the app
//! runs is picked up without a restart. Every `claude` process is started through `command`, with
//! this PATH (an npm-installed `claude` is a Node script: it needs `node` on its PATH too).
//!
//! Windows: an app gets the user's full PATH already (no login shell to ask); `claude` is
//! `claude.exe` (native installer, `~\.local\bin`) or `claude.cmd` (npm, `%APPDATA%\npm`), found
//! through PATHEXT; PATH entries are separated by `;`; processes start without a console window.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::RwLock;
use std::time::{Duration, Instant};

const MARK: &str = "__DECK_EDIT_PATH__";
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

static CURRENT: RwLock<Option<String>> = RwLock::new(None);

/// The PATH list separator: `;` on Windows, `:` elsewhere.
pub const SEP: char = if cfg!(windows) { ';' } else { ':' };

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

/// `dirs` joined into a PATH value.
pub fn join(dirs: &[&str]) -> String {
    dirs.iter().filter(|d| !d.is_empty()).copied().collect::<Vec<_>>().join(&SEP.to_string())
}

/// Where `claude` (and Node) usually live, whether or not they exist yet — so an install made
/// while the app runs is found. Node version managers' versioned folders: the newest first.
fn usual_dirs() -> Vec<PathBuf> {
    let home = home();
    if cfg!(windows) {
        let env = |k: &str| std::env::var(k).map(PathBuf::from).ok();
        let mut dirs = vec![home.join(".local").join("bin"), home.join(".claude").join("local")];
        dirs.extend(env("APPDATA").map(|d| d.join("npm")));
        dirs.extend(env("ProgramFiles").map(|d| d.join("nodejs")));
        dirs.extend(env("LOCALAPPDATA").map(|d| d.join("Volta").join("bin")));
        dirs.push(home.join(".bun").join("bin"));
        return dirs;
    }
    let mut dirs = vec![
        home.join(".local/bin"),
        home.join(".claude/local"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".npm-global/bin"),
        home.join(".volta/bin"),
        home.join(".asdf/shims"),
        home.join(".bun/bin"),
        home.join("Library/pnpm"),
    ];
    for versions in [home.join(".nvm/versions/node"), home.join(".fnm/node-versions")] {
        let mut found: Vec<PathBuf> = std::fs::read_dir(&versions)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .map(|p| if p.join("installation/bin").is_dir() { p.join("installation/bin") } else { p.join("bin") })
            .filter(|p| p.is_dir())
            .collect();
        found.sort_by(|a, b| version_key(b).cmp(&version_key(a)));
        dirs.extend(found);
    }
    dirs
}

/// "v20.11.1" (in a path) → [20, 11, 1], for newest-first ordering.
fn version_key(p: &Path) -> Vec<u64> {
    let name = p.components().rev().find_map(|c| c.as_os_str().to_str().filter(|s| s.starts_with('v')).map(str::to_string)).unwrap_or_default();
    name.trim_start_matches('v').split('.').map(|n| n.parse().unwrap_or(0)).collect()
}

/// The login shell's PATH (`$SHELL -ilc`), or None if it fails or takes too long. (None on
/// Windows: there's no login shell to ask, and an app gets the user's PATH anyway.)
fn shell_path_blocking() -> Option<String> {
    if cfg!(windows) {
        return None;
    }
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = std::process::Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A slow or interactive shell profile mustn't hold things up.
    let deadline = Instant::now() + SHELL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
    let out = child.wait_with_output().ok()?;
    parse_marked(&String::from_utf8_lossy(&out.stdout))
}

fn parse_marked(text: &str) -> Option<String> {
    let start = text.find(MARK)? + MARK.len();
    let end = start + text[start..].find(MARK)?;
    Some(text[start..end].to_string())
}

/// The shell's PATH, then the usual places, then `rest` — each folder once.
fn merge(shell: &str, rest: &str) -> String {
    let mut dirs: Vec<String> = Vec::new();
    let usual: Vec<String> = usual_dirs().iter().map(|p| p.to_string_lossy().into_owned()).collect();
    for d in shell.split(SEP).map(str::to_string).chain(usual).chain(rest.split(SEP).map(str::to_string)) {
        if !d.is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs.join(&SEP.to_string())
}

/// At startup, before any threads (the desktop app): adopt the login shell's PATH for the whole
/// process, so the agent's tools are found too.
pub fn adopt_at_startup() {
    let path = merge(&shell_path_blocking().unwrap_or_default(), &std::env::var("PATH").unwrap_or_default());
    std::env::set_var("PATH", &path);
    *CURRENT.write().unwrap() = Some(path);
}

/// The PATH to find and run `claude` with.
pub fn path() -> String {
    if let Some(p) = CURRENT.read().unwrap().clone() {
        return p;
    }
    let p = merge("", &std::env::var("PATH").unwrap_or_default());
    *CURRENT.write().unwrap() = Some(p.clone());
    p
}

/// Ask the login shell again (it may have learned of a new install) and re-scan the usual places.
pub async fn refresh() {
    let shell = tokio::task::spawn_blocking(shell_path_blocking).await.ok().flatten().unwrap_or_default();
    let next = merge(&shell, &path());
    *CURRENT.write().unwrap() = Some(next);
}

/// The file names `bin` may have: itself, and on Windows with each PATHEXT extension
/// (`claude` → `claude.exe`, `claude.cmd`…) when it has none.
fn candidates(bin: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(bin).extension().is_some() {
        return vec![bin.to_string()];
    }
    let exts = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
    exts.split(';').filter(|e| !e.is_empty()).map(|e| format!("{bin}{}", e.to_ascii_lowercase())).collect()
}

/// Where `bin` is: itself if it's a path, else the first match on `path()`.
pub fn which(bin: &str) -> Option<PathBuf> {
    if bin.contains('/') || bin.contains('\\') {
        let p = PathBuf::from(bin);
        return candidates(bin).into_iter().map(PathBuf::from).find(|c| c.is_file()).or(p.is_file().then_some(p));
    }
    let names = candidates(bin);
    path().split(SEP).find_map(|d| names.iter().map(|n| Path::new(d).join(n)).find(|p| p.is_file()))
}

/// The PATH to run `bin` with: its own folder first (for a Node script's `node`), then `path()`.
pub fn run_path(bin: &str) -> String {
    match which(bin).as_deref().and_then(Path::parent) {
        Some(dir) => format!("{}{SEP}{}", dir.display(), path()),
        None => path(),
    }
}

/// A command for `bin` (resolved on `path()`), run with `run_path`.
pub fn command(bin: &str) -> tokio::process::Command {
    let resolved = which(bin);
    let mut cmd = tokio::process::Command::new(resolved.as_deref().unwrap_or(Path::new(bin)));
    cmd.env("PATH", run_path(bin));
    no_window(&mut cmd);
    cmd
}

/// Windows: start the process without a console window (the app has none; each `claude` or tool
/// run would flash one). Nothing elsewhere.
pub fn no_window(cmd: &mut tokio::process::Command) {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let _ = cmd;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_marked_path_past_profile_noise() {
        assert_eq!(parse_marked(&format!("Welcome!\n{MARK}/a:/b{MARK}")), Some("/a:/b".into()));
        assert_eq!(parse_marked("no marks"), None);
    }

    #[test]
    fn merges_each_folder_once_shell_first() {
        let m = merge(&join(&["/shell/bin", "/usr/bin"]), &join(&["/usr/bin", "/rest/bin"]));
        let dirs: Vec<&str> = m.split(SEP).collect();
        assert_eq!(dirs[0], "/shell/bin");
        assert_eq!(dirs.iter().filter(|d| **d == "/usr/bin").count(), 1);
        assert!(dirs.contains(&"/rest/bin"));
        assert!(dirs.iter().any(|d| Path::new(d).ends_with(Path::new(".local").join("bin"))));
    }

    #[test]
    fn finds_a_bin_by_its_windows_extensions() {
        let c = candidates("claude");
        if cfg!(windows) {
            assert!(c.contains(&"claude.exe".to_string()) && c.contains(&"claude.cmd".to_string()));
        } else {
            assert_eq!(c, vec!["claude".to_string()]);
        }
        assert_eq!(candidates("python.exe"), vec!["python.exe".to_string()]);
    }

    #[test]
    fn orders_node_versions_newest_first() {
        let mut v = vec![PathBuf::from("/n/v18.2.0/bin"), PathBuf::from("/n/v20.11.1/bin"), PathBuf::from("/n/v9.0.0/bin")];
        v.sort_by(|a, b| version_key(b).cmp(&version_key(a)));
        assert_eq!(v[0], PathBuf::from("/n/v20.11.1/bin"));
        assert_eq!(v[2], PathBuf::from("/n/v9.0.0/bin"));
    }
}
