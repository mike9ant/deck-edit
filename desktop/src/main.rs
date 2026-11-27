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
use std::sync::{Arc, Mutex, OnceLock};

use tauri::menu::{AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::NewWindowResponse;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, Wry};

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

/// The menu bar's items the page carries out: (id, label, shortcut, checkable). They're greyed out
/// until the page says they apply (see `poll_menu_state`), and choosing one sends the page a
/// `deckedit-menu` DOM event (frontend/src/desktopMenu.ts). The browser build has no menu bar.
type PageItemSpec = (&'static str, &'static str, Option<&'static str>, bool);

const SETTINGS: PageItemSpec = ("settings", "Settings…", Some("CmdOrCtrl+Comma"), false);
const FILE: &[PageItemSpec] = &[
    ("new-project", "New Project…", Some("CmdOrCtrl+Shift+N"), false),
    ("-", "", None, false),
    ("save", "Save", Some("CmdOrCtrl+S"), false),
    ("close-tab", "Close Tab", Some("CmdOrCtrl+W"), false),
];
const FILE_END: &[PageItemSpec] = &[("-", "", None, false), ("reveal", "Reveal in Finder", Some("Alt+CmdOrCtrl+R"), false)];
const FIND: &[PageItemSpec] = &[
    ("find", "Find…", Some("CmdOrCtrl+F"), false),
    ("find-next", "Find Next", Some("CmdOrCtrl+G"), false),
    ("find-prev", "Find Previous", Some("CmdOrCtrl+Shift+G"), false),
];
const VIEW: &[PageItemSpec] = &[
    ("toggle-files", "Files Panel", None, true),
    ("toggle-chat", "AI Agent Panel", None, true),
    ("toggle-notes", "Speaker Notes", None, true),
    ("toggle-comments", "Review Comments", None, true),
    ("toggle-resolved", "Resolved Notes for AI", None, true),
    ("-", "", None, false),
    ("next-slide", "Next Slide", Some("Alt+CmdOrCtrl+Down"), false),
    ("prev-slide", "Previous Slide", Some("Alt+CmdOrCtrl+Up"), false),
];
const DECK: &[PageItemSpec] = &[
    ("new-text-box", "New Text Box", None, false),
    ("duplicate-slide", "Duplicate Slide", None, false),
    ("delete-slide", "Delete Slide", None, false),
    ("-", "", None, false),
    ("note-for-ai", "Note for AI", None, true),
    ("-", "", None, false),
    ("compare-with", "Compare With…", None, false),
    ("review-changes", "Review Changes", None, true),
    ("close-compare", "Close Comparison", None, false),
    ("-", "", None, false),
    ("open-powerpoint", "Open in PowerPoint", None, false),
];
const AGENT: &[PageItemSpec] = &[
    ("new-chat", "New Chat", Some("CmdOrCtrl+N"), false),
    ("-", "", None, false),
    ("stop-agent", "Stop Agent", Some("CmdOrCtrl+Period"), false),
    ("split-chat", "Continue in a Fresh Conversation", None, false),
    ("revert-last-turn", "Revert Last Turn…", None, false),
];

enum PageItem {
    Plain(MenuItem<Wry>),
    Check(CheckMenuItem<Wry>),
}

/// The page items, built once with the menu, for `poll_menu_state` to grey out / tick.
static PAGE_MENU: OnceLock<Vec<(&'static str, PageItem)>> = OnceLock::new();
/// The page's last reported state (`enabled ids|checked ids`): the menu is only touched when it changes.
static LAST_STATE: Mutex<String> = Mutex::new(String::new());
/// The window's zoom (View → Zoom In / Out / Actual Size).
static ZOOM: Mutex<f64> = Mutex::new(1.0);
const ZOOM_STEPS: &[f64] = &[0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0];

/// Add page items to a submenu ("-" is a separator), keeping them for `poll_menu_state`.
fn add_page_items<'a>(
    app: &tauri::AppHandle<Wry>,
    mut sub: SubmenuBuilder<'a, Wry, tauri::AppHandle<Wry>>,
    specs: &[PageItemSpec],
    items: &mut Vec<(&'static str, PageItem)>,
) -> tauri::Result<SubmenuBuilder<'a, Wry, tauri::AppHandle<Wry>>> {
    for &(id, label, accel, check) in specs {
        if id == "-" {
            sub = sub.separator();
            continue;
        }
        if check {
            let mut b = CheckMenuItemBuilder::with_id(id, label).enabled(false);
            if let Some(a) = accel {
                b = b.accelerator(a);
            }
            let item = b.build(app)?;
            sub = sub.item(&item);
            items.push((id, PageItem::Check(item)));
        } else {
            let mut b = MenuItemBuilder::with_id(id, label).enabled(false);
            if let Some(a) = accel {
                b = b.accelerator(a);
            }
            let item = b.build(app)?;
            sub = sub.item(&item);
            items.push((id, PageItem::Plain(item)));
        }
    }
    Ok(sub)
}

/// A menu choice: zoom and Close Window are the app's own; the rest go to the page.
fn on_menu(app: &tauri::AppHandle<Wry>, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    let Some(window) = app.get_webview_window("main") else { return };
    match id {
        "zoom-in" | "zoom-out" | "zoom-reset" => {
            let mut zoom = ZOOM.lock().unwrap();
            let at = ZOOM_STEPS.iter().position(|z| (z - *zoom).abs() < 0.01).unwrap_or(5);
            *zoom = match id {
                "zoom-in" => ZOOM_STEPS[(at + 1).min(ZOOM_STEPS.len() - 1)],
                "zoom-out" => ZOOM_STEPS[at.saturating_sub(1)],
                _ => 1.0,
            };
            let _ = window.set_zoom(*zoom);
        }
        "close-window" => {
            let _ = window.close();
        }
        _ if PAGE_MENU.get().is_some_and(|items| items.iter().any(|(i, _)| *i == id)) => {
            let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('deckedit-menu', {{ detail: '{id}' }}))"));
        }
        _ => {}
    }
}

/// Every 250 ms, ask the page which of its menu items apply now (and which are ticked), and grey out
/// / tick the menu to match — so a shortcut for something that doesn't apply does nothing.
fn poll_menu_state(window: tauri::WebviewWindow<Wry>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let js = "typeof window.__deckeditMenuState === 'function' ? window.__deckeditMenuState() : ''";
        if window.eval_with_callback(js, apply_menu_state).is_err() {
            break; // the window is gone
        }
    });
}

fn apply_menu_state(result: String) {
    // The result is a JSON string: "enabled,ids|checked,ids" (ids are plain [a-z-]).
    let state = result.trim().trim_matches('"').to_string();
    {
        let mut last = LAST_STATE.lock().unwrap();
        if *last == state {
            return;
        }
        *last = state.clone();
    }
    let (enabled, checked) = state.split_once('|').unwrap_or((state.as_str(), ""));
    let enabled: Vec<&str> = enabled.split(',').collect();
    let checked: Vec<&str> = checked.split(',').collect();
    for (id, item) in PAGE_MENU.get().map(|v| v.as_slice()).unwrap_or_default() {
        match item {
            PageItem::Plain(i) => {
                let _ = i.set_enabled(enabled.contains(id));
            }
            PageItem::Check(i) => {
                let _ = i.set_enabled(enabled.contains(id));
                let _ = i.set_checked(checked.contains(id));
            }
        }
    }
}

/// The macOS menu bar: the standard menus (with an About panel that shows the app's purpose, author
/// and as-is notice), plus the app's own: File, Find in Edit, View, Deck and AI Agent.
fn app_menu(app: &tauri::AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
    let version = app.package_info().version.to_string(); // "0.1.0", as in Settings → About
    let about = AboutMetadataBuilder::new()
        .name(Some("Deck Edit"))
        .version(Some(version.clone()))
        .short_version(Some(version))
        .copyright(Some(AUTHOR))
        .credits(Some(format!("{PURPOSE}\n\n{AS_IS}")))
        .build();
    let mut items = Vec::new();
    let app_menu = SubmenuBuilder::new(app, "Deck Edit").about(Some(about)).separator();
    let app_menu = add_page_items(app, app_menu, &[SETTINGS], &mut items)?
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = add_page_items(app, SubmenuBuilder::new(app, "File"), FILE, &mut items)?
        .item(&MenuItemBuilder::with_id("close-window", "Close Window").accelerator("CmdOrCtrl+Shift+W").build(app)?);
    let file = add_page_items(app, file, FILE_END, &mut items)?.build()?;
    let edit = SubmenuBuilder::new(app, "Edit").undo().redo().separator().cut().copy().paste().select_all().separator();
    let edit = add_page_items(app, edit, FIND, &mut items)?.build()?;
    let view = add_page_items(app, SubmenuBuilder::new(app, "View"), VIEW, &mut items)?
        .separator()
        .item(&MenuItemBuilder::with_id("zoom-in", "Zoom In").accelerator("CmdOrCtrl+Equal").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-out", "Zoom Out").accelerator("CmdOrCtrl+Minus").build(app)?)
        .item(&MenuItemBuilder::with_id("zoom-reset", "Actual Size").accelerator("CmdOrCtrl+0").build(app)?)
        .separator()
        .fullscreen()
        .build()?;
    let deck = add_page_items(app, SubmenuBuilder::new(app, "Deck"), DECK, &mut items)?.build()?;
    let agent = add_page_items(app, SubmenuBuilder::new(app, "AI Agent"), AGENT, &mut items)?.build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    let _ = PAGE_MENU.set(items);
    MenuBuilder::new(app).items(&[&app_menu, &file, &edit, &view, &deck, &agent, &window]).build()
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
    tauri::Builder::default()
        .menu(app_menu)
        .on_menu_event(on_menu)
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
            poll_menu_state(window.clone());

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
