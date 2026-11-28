//! The macOS menu bar (macOS only — on Windows the app has no menu bar: its shortcuts, ⌘/Ctrl+S,
//! F, G…, are the page's own). Standard menus plus the app's: File, Find in Edit, View, Deck and
//! AI Agent. Their items are greyed out / ticked from the page's state, polled; a chosen item is
//! sent to the page as a `deckedit-menu` event (frontend/src/desktopMenu.ts).

use std::sync::{Mutex, OnceLock};

use tauri::menu::{AboutMetadataBuilder, CheckMenuItem, CheckMenuItemBuilder, Menu, MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::{Manager, Wry};

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
pub fn on_menu(app: &tauri::AppHandle<Wry>, event: tauri::menu::MenuEvent) {
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
pub fn poll_menu_state(window: tauri::WebviewWindow<Wry>) {
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
pub fn app_menu(app: &tauri::AppHandle<Wry>) -> tauri::Result<Menu<Wry>> {
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
