//! PPTX Edit as a desktop app (Tauri).
//!
//! Runs the app's server in-process on a background task and shows it in a
//! window — no terminal, no separate server. Flow: take the login shell's PATH
//! → bind a sticky localhost port → show a static splash (`splash/index.html`)
//! → start the server → point the window at `http://127.0.0.1:{port}/` once
//! it's ready. Logs: `~/.pdf-edit/logs/desktop.log`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use tauri::menu::{AboutMetadataBuilder, Menu, MenuBuilder, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

use pdf_edit::{default_data_dir, init_logging, repo_frontend_dist, run_server, ServerConfig};

/// Bind the port saved from the last run, falling back to a fresh ephemeral
/// port (saved for next time). A stable port keeps the window's origin — and
/// with it the app's localStorage (open project, tabs, panel sizes, drafts) —
/// the same across launches.
fn bind_sticky(port_file: &Path) -> anyhow::Result<TcpListener> {
    if let Some(port) = std::fs::read_to_string(port_file).ok().and_then(|s| s.trim().parse::<u16>().ok()) {
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", port)) {
            return Ok(listener);
        }
        tracing::warn!("saved port {port} unavailable, picking a new one");
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let port = listener.local_addr()?.port();
    if let Some(parent) = port_file.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(port_file, port.to_string())?;
    Ok(listener)
}

/// An app opened from the Finder or the Dock gets a bare PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`): neither `claude` nor the tools the agent
/// runs (python3, git, brew-installed commands) would be found. Take the PATH
/// the user's interactive login shell sets up, plus the usual install places.
fn adopt_login_path() {
    const MARK: &str = "__PPTX_EDIT_PATH__";
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let from_shell = Command::new(&shell)
        .args(["-ilc", &format!("printf '{MARK}%s{MARK}' \"$PATH\"")])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()
        .and_then(|mut child| {
            // A slow or interactive shell profile mustn't hold up the app.
            let deadline = Instant::now() + Duration::from_secs(5);
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
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            let start = text.find(MARK)? + MARK.len();
            let end = start + text[start..].find(MARK)?;
            Some(text[start..end].to_string())
        })
        .unwrap_or_default();
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    let extra = [
        home.join(".local/bin"),
        home.join(".claude/local"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    let mut dirs: Vec<String> = Vec::new();
    for d in from_shell.split(':').map(str::to_string).chain(extra.iter().map(|p| p.to_string_lossy().into_owned())).chain(current.split(':').map(str::to_string)) {
        if !d.is_empty() && !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    std::env::set_var("PATH", dirs.join(":"));
}

/// The built frontend: the repo's in debug builds (`cargo run` after
/// `npm run build`), the bundled copy in the packaged .app.
fn frontend_dist(app: &tauri::App) -> anyhow::Result<PathBuf> {
    if cfg!(debug_assertions) {
        Ok(repo_frontend_dist())
    } else {
        Ok(app.path().resource_dir()?.join("frontend-dist"))
    }
}

/// Pages of the app itself: the splash (tauri://) and the local server.
fn is_app_page(url: &tauri::Url) -> bool {
    url.scheme() == "tauri" || matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("tauri.localhost"))
}

/// Links out of the app (a web page in a chat answer, a Markdown link) open in the default browser.
fn open_in_browser(url: &tauri::Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        let _ = Command::new("open").arg(url.as_str()).spawn();
    }
}

/// What Settings → About in the app says too (frontend/src/chat/AgentSettings.tsx).
const PURPOSE: &str = "To enable efficient editing of PowerPoint / PPTX files, and related supporting content folders, with help of Claude Code.";
const AS_IS: &str = "Provided as-is, with no warranty of any kind.";
const AUTHOR: &str = "Developed by Michael Antonov.";

/// The macOS menu bar: Tauri's default menu, with an About panel that shows
/// the app's purpose, author and as-is notice.
fn app_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let v = &app.package_info().version;
    let version = format!("{}.{}", v.major, v.minor); // "0.1", as in Settings → About
    let about = AboutMetadataBuilder::new()
        .name(Some("PPTX Edit"))
        .version(Some(version.clone()))
        .short_version(Some(version))
        .copyright(Some(AUTHOR))
        .credits(Some(format!("{PURPOSE}\n\n{AS_IS}")))
        .build();
    let app_menu = SubmenuBuilder::new(app, "PPTX Edit")
        .about(Some(about))
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().build()?;
    let view = SubmenuBuilder::new(app, "View").fullscreen().build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().separator().close_window().build()?;
    MenuBuilder::new(app).items(&[&app_menu, &edit, &view, &window]).build()
}

fn main() {
    adopt_login_path();
    tauri::Builder::default()
        .menu(app_menu)
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let data_dir = default_data_dir();
            init_logging(Some(&data_dir.join("logs").join("desktop.log")));
            let listener = bind_sticky(&data_dir.join("desktop.port"))?;
            let port = listener.local_addr()?.port();
            let dist = frontend_dist(app)?;
            tracing::info!("desktop app: server on port {port}, frontend at {dist:?}");

            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("PPTX Edit")
                .inner_size(1440.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // The page handles dropped files itself (images onto slides, files into the chat);
                // the native handler would swallow those drops.
                .disable_drag_drop_handler()
                .on_navigation(|url| {
                    if is_app_page(url) {
                        return true;
                    }
                    open_in_browser(url);
                    false
                })
                .on_new_window(|url, _features| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                })
                .build()?;

            let (ready_tx, ready_rx) = tokio::sync::oneshot::channel();
            tauri::async_runtime::spawn(async move {
                let config = ServerConfig { data_dir, frontend_dist: dist, provision_python: true };
                if let Err(e) = run_server(listener, config, Some(ready_tx)).await {
                    tracing::error!("server exited: {e:#}");
                }
            });
            tauri::async_runtime::spawn(async move {
                match ready_rx.await {
                    Ok(()) => {
                        let url = format!("http://127.0.0.1:{port}/").parse().expect("valid localhost url");
                        if let Err(e) = window.navigate(url) {
                            tracing::error!("failed to open the app page: {e}");
                        }
                    }
                    Err(_) => {
                        // run_server returned before it was ready: startup failed.
                        let _ = window.eval("window.__bootError('PPTX Edit could not start. Details are in ~/.pdf-edit/logs/desktop.log.')");
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the PPTX Edit app");
}
