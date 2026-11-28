//! Deck Edit as a desktop app (Tauri).
//!
//! Runs the app's server in-process on a background task and shows it in a
//! window — no terminal, no separate server. Flow: take the login shell's PATH
//! → bind a sticky localhost port → show a static splash (`splash/index.html`)
//! → start the server → point the window at `http://127.0.0.1:{port}/` once
//! it's ready. Logs: `~/.deck-edit/logs/desktop.log`.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, Wry};

#[cfg(target_os = "macos")]
mod menu_bar;

use deck_edit::{default_data_dir, init_logging, repo_frontend_dist, run_server, ServerConfig};

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

/// Links out of the app (a web page in a chat answer, a Markdown link) open in the default browser
/// (macOS `open`; Windows Explorer — not `cmd /c start`, which would read `&` in a URL as its own).
fn open_in_browser(url: &tauri::Url) {
    if !matches!(url.scheme(), "http" | "https" | "mailto") {
        return;
    }
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(not(any(target_os = "macos", windows)))]
    let program = "xdg-open";
    let _ = Command::new(program).arg(url.as_str()).spawn();
}

/// The page has written its decks (or had nothing to write) since the window / app was asked to close.
static FLUSHED: AtomicBool = AtomicBool::new(false);
/// A flush is under way (a second close / quit request meanwhile just waits for it).
static FLUSHING: AtomicBool = AtomicBool::new(false);

/// Before the window closes or the app quits: the page writes the decks' unsaved edits (they're
/// written ~10 s after an edit otherwise — `window.__deckeditFlush`, frontend deckStore.ts). Waits
/// for it up to 5 s, then `then()` (closes / quits again, this time letting it happen).
fn flush_page_then(window: tauri::WebviewWindow<Wry>, then: impl FnOnce() + Send + 'static) {
    if FLUSHING.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = window.eval("window.__deckeditFlushed = false; Promise.resolve(window.__deckeditFlush?.()).finally(() => { window.__deckeditFlushed = true })");
    std::thread::spawn(move || {
        let done = Arc::new(AtomicBool::new(false));
        for _ in 0..50 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            if done.load(Ordering::SeqCst) {
                break;
            }
            let d = done.clone();
            let asked = window.eval_with_callback("window.__deckeditFlushed !== false", move |r| {
                if r.trim() == "true" {
                    d.store(true, Ordering::SeqCst);
                }
            });
            if asked.is_err() {
                break; // the page is gone
            }
        }
        FLUSHED.store(true, Ordering::SeqCst);
        then();
    });
}

fn main() {
    // The login shell's PATH (an app opened from the Finder gets a bare one): see login_path.rs.
    deck_edit::login_path::adopt_at_startup();
    let builder = tauri::Builder::default();
    // The menu bar: macOS only (see menu_bar.rs).
    #[cfg(target_os = "macos")]
    let builder = builder.menu(menu_bar::app_menu).on_menu_event(menu_bar::on_menu);
    builder
        .on_window_event(|window, event| {
            // Closing the window: the decks' edits are written first.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if FLUSHED.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                    let again = w.clone();
                    flush_page_then(w, move || {
                        let _ = again.close();
                    });
                }
            }
        })
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
                .title("Deck Edit")
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
            #[cfg(target_os = "macos")]
            menu_bar::poll_menu_state(window.clone());

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
                        let _ = window.eval("window.__bootError('Deck Edit could not start. Details are in ~/.deck-edit/logs/desktop.log.')");
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Deck Edit app")
        .run(|app, event| {
            // Quitting (⌘Q): the decks' edits are written first.
            if let tauri::RunEvent::ExitRequested { code: None, api, .. } = &event {
                if FLUSHED.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                let app = app.clone();
                match app.get_webview_window("main") {
                    Some(w) => flush_page_then(w, move || app.exit(0)),
                    None => app.exit(0),
                }
            }
        });
}
