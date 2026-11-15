//! Slide notes: sticky notes the user (or the agent) pins on a slide or PDF
//! page. Open notes are fed into every agent turn's context; the agent resolves
//! them through its MCP tools (`resolve_note`) and the user sees them flip to
//! "resolved" live.
//!
//! Stored per project in `<data_dir>/notes/<project>.json` — outside the deck,
//! so a note never touches the PPTX/PDF.
//!
//! A note is anchored to the slide's stable `slideId` (the `p:sldId/@id` in
//! presentation.xml, which survives reordering) plus a position as fractions of
//! the slide (0..1). For PDFs `slideId` is empty and `slideIndex` is the page.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::extract::{Path as AxPath, Query, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{AppError, Result};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub id: String,
    /// Deck path relative to the project folder.
    pub deck: String,
    #[serde(default)]
    pub slide_id: String,
    /// 1-based slide/page number when the note was created (or last synced).
    pub slide_index: u32,
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shape_name: Option<String>,
    /// A freehand mark (circle, underline, arrow…) the user drew instead of
    /// pinning a point: polylines of `[x, y]` slide fractions. `x`/`y` above is
    /// then where the pin sits (the mark's top-right corner).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub strokes: Vec<Vec<[f64; 2]>>,
    /// For a drawn note on a slide: the shapes the mark covers, most-covered
    /// first, as `name — "text excerpt"`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub shapes: Vec<String>,
    /// A note on selected text in a text/code/Markdown file: the text it's about…
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote: Option<String>,
    /// …and its lines ("12" or "12–14").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lines: Option<String>,
    /// Where a quote note is, besides a file: "speakerNotes" (the speaker notes
    /// of slide `slide_id` in deck `deck`) or "chat" (a message in the chat
    /// `slide_id`; such a note is shown only to that chat's agent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    pub text: String,
    /// "user" | "agent"
    pub author: String,
    pub created_at: String,
    /// "open" | "resolved"
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_by: Option<String>,
}

/// Bounding box of a drawn note, as slide fractions.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Region {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    /// The mark is a closed loop (the user circled something) rather than an
    /// open line (underline, arrow, strike-through).
    pub closed: bool,
}

impl Note {
    pub fn region(&self) -> Option<Region> {
        let pts: Vec<&[f64; 2]> = self.strokes.iter().flatten().collect();
        if pts.is_empty() {
            return None;
        }
        let (mut x1, mut y1, mut x2, mut y2) = (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
        for p in &pts {
            x1 = x1.min(p[0]);
            y1 = y1.min(p[1]);
            x2 = x2.max(p[0]);
            y2 = y2.max(p[1]);
        }
        let diag = ((x2 - x1).powi(2) + (y2 - y1).powi(2)).sqrt();
        let closed = self.strokes.iter().any(|s| match (s.first(), s.last()) {
            (Some(a), Some(b)) if s.len() > 8 => {
                ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt() < (diag * 0.25).max(0.01)
            }
            _ => false,
        });
        Some(Region { x1, y1, x2, y2, closed })
    }

    /// One line for the agent: where the note is and what it covers.
    /// Whether the agent of chat `chat_id` should see this note (a note on a chat message is for that chat only).
    pub fn visible_in_chat(&self, chat_id: &str) -> bool {
        self.target.as_deref() != Some("chat") || self.slide_id == chat_id
    }

    pub fn describe_place(&self) -> String {
        if let Some(q) = &self.quote {
            let q: String = q.chars().take(400).collect();
            match self.target.as_deref() {
                Some("speakerNotes") => return format!("{} slide {}, in the speaker notes, on the text: \"{q}\"", self.deck, self.slide_index),
                Some("chat") => return format!("this chat (an earlier message), on the text: \"{q}\""),
                _ => {}
            }
            if self.deck.to_lowercase().ends_with(".pdf") {
                return format!("{} page {}, on the text: \"{q}\"", self.deck, self.slide_index);
            }
            let lines = self.lines.as_deref().map(|l| format!(" line{} {l}", if l.contains('–') || l.contains('-') { "s" } else { "" })).unwrap_or_default();
            return format!("{}{lines}, on the text: \"{q}\"", self.deck);
        }
        if is_sheet(&self.deck) {
            // Positions are in cell units: column/row number + the fraction into that cell.
            let mut out = format!("{} sheet \"{}\"", self.deck, self.slide_id);
            if let Some(r) = self.region() {
                let range = format!("{}:{}", cell_ref(r.x1, r.y1), cell_ref(r.x2, r.y2));
                out.push_str(&format!(", {} the cells {range}", if r.closed { "circled" } else { "marked (open stroke: underline/arrow/line)" }));
                if !self.shapes.is_empty() {
                    out.push_str(&format!(", covering {}", self.shapes.join("; ")));
                }
            } else {
                out.push_str(&format!(" at cell {}", cell_ref(self.x, self.y)));
                if let Some(s) = &self.shape_name {
                    out.push_str(&format!(" ({s})"));
                }
            }
            return out;
        }
        let unit = if self.deck.to_lowercase().ends_with(".pdf") { "page" } else if is_image(&self.deck) { "image" } else { "slide" };
        let mut out = if unit == "image" { format!("{} (image)", self.deck) } else { format!("{} {unit} {}", self.deck, self.slide_index) };
        if let Some(r) = self.region() {
            let pct = |v: f64| (v * 100.0).round() as i64;
            out.push_str(&format!(
                ", {} the area x {}–{}%, y {}–{}% of the {unit} (from top-left)",
                if r.closed { "circled" } else { "marked (open stroke: underline/arrow/line)" },
                pct(r.x1),
                pct(r.x2),
                pct(r.y1),
                pct(r.y2),
            ));
            if !self.shapes.is_empty() {
                out.push_str(&format!(", covering {}", self.shapes.join("; ")));
            }
        } else if let Some(s) = &self.shape_name {
            out.push_str(&format!(" near \"{s}\""));
        } else if unit != "slide" {
            // A pin on a page or image: where it is.
            out.push_str(&format!(", at x {}%, y {}% of the {unit} (from top-left)", (self.x * 100.0).round(), (self.y * 100.0).round()));
        }
        out
    }
}

pub fn is_image(deck: &str) -> bool {
    let d = deck.to_lowercase();
    [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"].iter().any(|e| d.ends_with(e))
}

pub fn is_sheet(deck: &str) -> bool {
    let d = deck.to_lowercase();
    d.ends_with(".xlsx") || d.ends_with(".xlsm")
}

/// 1 → A, 27 → AA.
fn col_name(mut n: u32) -> String {
    let mut s = Vec::new();
    while n > 0 {
        s.push(b'A' + ((n - 1) % 26) as u8);
        n = (n - 1) / 26;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

/// A position in cell units (column + fraction, row + fraction) → "B7".
fn cell_ref(x: f64, y: f64) -> String {
    format!("{}{}", col_name(x.floor().max(1.0) as u32), y.floor().max(1.0) as u32)
}

/// Keep stored drawings bounded: on the slide (fractions 0..1), or — on a
/// spreadsheet, where positions are in cell units — just non-negative.
fn clean_strokes(strokes: Vec<Vec<[f64; 2]>>, unit_square: bool) -> Vec<Vec<[f64; 2]>> {
    let lim = |v: f64| if unit_square { v.clamp(0.0, 1.0) } else { v.max(0.0) };
    strokes
        .into_iter()
        .take(30)
        .map(|s| {
            s.into_iter()
                .filter(|p| p[0].is_finite() && p[1].is_finite())
                .take(500)
                .map(|p| [lim(p[0]), lim(p[1])])
                .collect::<Vec<_>>()
        })
        .filter(|s| !s.is_empty())
        .collect()
}

pub struct NotesStore {
    dir: PathBuf,
    lock: Mutex<()>,
}

impl NotesStore {
    pub fn new(data_dir: &Path) -> Self {
        Self { dir: data_dir.join("notes"), lock: Mutex::new(()) }
    }

    fn file(&self, project_id: &str) -> PathBuf {
        self.dir.join(format!("{project_id}.json"))
    }

    pub fn all(&self, project_id: &str) -> Vec<Note> {
        let _g = self.lock.lock().unwrap();
        self.read(project_id)
    }

    fn read(&self, project_id: &str) -> Vec<Note> {
        std::fs::read_to_string(self.file(project_id))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn write(&self, project_id: &str, notes: &[Note]) -> Result<()> {
        let text = serde_json::to_string_pretty(notes)?;
        crate::files::write_atomic(&self.file(project_id), text.as_bytes())?;
        Ok(())
    }

    pub fn add(&self, project_id: &str, note: Note) -> Result<Note> {
        let _g = self.lock.lock().unwrap();
        let mut notes = self.read(project_id);
        notes.push(note.clone());
        self.write(project_id, &notes)?;
        Ok(note)
    }

    pub fn update(&self, project_id: &str, id: &str, f: impl FnOnce(&mut Note)) -> Result<Note> {
        let _g = self.lock.lock().unwrap();
        let mut notes = self.read(project_id);
        let n = notes
            .iter_mut()
            .find(|n| n.id == id)
            .ok_or_else(|| AppError::NotFound(format!("note {id} not found")))?;
        f(n);
        let out = n.clone();
        self.write(project_id, &notes)?;
        Ok(out)
    }

    /// A deck (or a folder of decks) was renamed/moved: its notes follow. Returns whether any changed.
    pub fn rename_deck_paths(&self, project_id: &str, from: &str, to: &str) -> Result<bool> {
        let _g = self.lock.lock().unwrap();
        let mut notes = self.read(project_id);
        let mut changed = false;
        for n in notes.iter_mut() {
            if n.deck == from {
                n.deck = to.to_string();
                changed = true;
            } else if let Some(rest) = n.deck.strip_prefix(&format!("{from}/")) {
                n.deck = format!("{to}/{rest}");
                changed = true;
            }
        }
        if changed {
            self.write(project_id, &notes)?;
        }
        Ok(changed)
    }

    pub fn remove(&self, project_id: &str, id: &str) -> Result<()> {
        let _g = self.lock.lock().unwrap();
        let mut notes = self.read(project_id);
        notes.retain(|n| n.id != id);
        self.write(project_id, &notes)
    }
}

/// Fill in each note's CURRENT slide number from the deck's latest slide map
/// (slides may have been reordered since the note was pinned).
pub fn with_current_index(state: &AppState, project_id: &str, mut notes: Vec<Note>) -> Vec<Note> {
    let maps = state.deck_maps.lock().unwrap();
    for n in notes.iter_mut() {
        if n.slide_id.is_empty() {
            continue;
        }
        if let Some(slides) = maps
            .get(&(project_id.to_string(), n.deck.clone()))
            .and_then(|m| m.as_array())
        {
            if let Some(idx) = slides
                .iter()
                .find(|s| s.get("slideId").and_then(|v| v.as_str()) == Some(n.slide_id.as_str()))
                .and_then(|s| s.get("index").and_then(|v| v.as_u64()))
            {
                n.slide_index = idx as u32;
            }
        }
    }
    notes
}

pub fn notify_changed(state: &AppState, project_id: &str) {
    state.publish(json!({ "type": "notes", "projectId": project_id }));
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects/{id}/notes", get(list).post(create))
        .route("/projects/{id}/notes/{nid}", patch(update).delete(remove))
        .route("/projects/{id}/deck-map", axum::routing::put(put_deck_map))
        .route("/projects/{id}/view", axum::routing::put(put_view))
}

#[derive(Deserialize)]
struct DeckQuery {
    deck: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Query(q): Query<DeckQuery>,
) -> Result<Json<Vec<Note>>> {
    let notes: Vec<Note> = state
        .notes
        .all(&id)
        .into_iter()
        .filter(|n| q.deck.as_deref().is_none_or(|d| d == n.deck))
        .collect();
    Ok(Json(with_current_index(&state, &id, notes)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    deck: String,
    #[serde(default)]
    slide_id: String,
    slide_index: u32,
    x: f64,
    y: f64,
    #[serde(default)]
    shape_name: Option<String>,
    #[serde(default)]
    strokes: Vec<Vec<[f64; 2]>>,
    #[serde(default)]
    shapes: Vec<String>,
    #[serde(default)]
    quote: Option<String>,
    #[serde(default)]
    lines: Option<String>,
    #[serde(default)]
    target: Option<String>,
    text: String,
}

async fn create(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Json(b): Json<CreateBody>,
) -> Result<Json<Note>> {
    state.projects.get(&id)?;
    let sheet = is_sheet(&b.deck);
    let note = Note {
        id: uuid::Uuid::new_v4().to_string()[..8].to_string(),
        deck: b.deck,
        slide_id: b.slide_id,
        slide_index: b.slide_index,
        x: if sheet { b.x.max(0.0) } else { b.x.clamp(0.0, 1.0) },
        y: if sheet { b.y.max(0.0) } else { b.y.clamp(0.0, 1.0) },
        shape_name: b.shape_name,
        strokes: clean_strokes(b.strokes, !sheet),
        quote: b.quote.map(|q| q.chars().take(2000).collect()),
        lines: b.lines,
        target: b.target.filter(|t| t == "speakerNotes" || t == "chat"),
        shapes: b.shapes.into_iter().take(12).collect(),
        text: b.text,
        author: "user".into(),
        created_at: chrono::Utc::now().to_rfc3339(),
        status: "open".into(),
        resolution: None,
        resolved_at: None,
        resolved_by: None,
    };
    let note = state.notes.add(&id, note)?;
    notify_changed(&state, &id);
    Ok(Json(note))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    text: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
    status: Option<String>,
    slide_index: Option<u32>,
    slide_id: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    AxPath((id, nid)): AxPath<(String, String)>,
    Json(b): Json<UpdateBody>,
) -> Result<Json<Note>> {
    let note = state.notes.update(&id, &nid, |n| {
        if let Some(t) = b.text {
            n.text = t;
        }
        if let Some(x) = b.x {
            n.x = x.clamp(0.0, 1.0);
        }
        if let Some(y) = b.y {
            n.y = y.clamp(0.0, 1.0);
        }
        if let Some(i) = b.slide_index {
            n.slide_index = i;
        }
        if let Some(s) = b.slide_id {
            n.slide_id = s;
        }
        if let Some(s) = b.status {
            if s == "resolved" && n.status != "resolved" {
                n.resolved_at = Some(chrono::Utc::now().to_rfc3339());
                n.resolved_by = Some("user".into());
            }
            if s == "open" {
                n.resolved_at = None;
                n.resolved_by = None;
                n.resolution = None;
            }
            n.status = s;
        }
    })?;
    notify_changed(&state, &id);
    Ok(Json(note))
}

async fn remove(
    State(state): State<AppState>,
    AxPath((id, nid)): AxPath<(String, String)>,
) -> Result<Json<Value>> {
    state.notes.remove(&id, &nid)?;
    notify_changed(&state, &id);
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct DeckMapBody {
    deck: String,
    slides: Value,
}

async fn put_deck_map(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Json(b): Json<DeckMapBody>,
) -> Json<Value> {
    state.deck_maps.lock().unwrap().insert((id, b.deck), b.slides);
    Json(json!({ "ok": true }))
}

async fn put_view(State(state): State<AppState>, AxPath(id): AxPath<String>, Json(b): Json<Value>) -> Json<Value> {
    state.views.lock().unwrap().insert(id, b);
    Json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(strokes: Vec<Vec<[f64; 2]>>) -> Note {
        Note {
            id: "n1".into(),
            deck: "deck.pptx".into(),
            slide_id: "256".into(),
            slide_index: 3,
            x: 0.5,
            y: 0.5,
            shape_name: Some("Title 1".into()),
            strokes,
            shapes: vec!["Chart 4".into()],
            quote: None,
            lines: None,
            target: None,
            text: "bigger".into(),
            author: "user".into(),
            created_at: String::new(),
            status: "open".into(),
            resolution: None,
            resolved_at: None,
            resolved_by: None,
        }
    }

    #[test]
    fn a_pin_note_has_no_region() {
        let n = note(vec![]);
        assert_eq!(n.region(), None);
        assert_eq!(n.describe_place(), "deck.pptx slide 3 near \"Title 1\"");
    }

    #[test]
    fn a_loop_reads_as_circled_and_a_line_as_marked() {
        let circle: Vec<[f64; 2]> = (0..=24)
            .map(|i| {
                let a = i as f64 / 24.0 * std::f64::consts::TAU;
                [0.3 + 0.1 * a.cos(), 0.5 + 0.1 * a.sin()]
            })
            .collect();
        let n = note(vec![circle]);
        let r = n.region().unwrap();
        assert!(r.closed);
        assert!((r.x1 - 0.2).abs() < 1e-9 && (r.x2 - 0.4).abs() < 1e-9);
        assert_eq!(
            n.describe_place(),
            "deck.pptx slide 3, circled the area x 20–40%, y 40–60% of the slide (from top-left), covering Chart 4"
        );

        let line: Vec<[f64; 2]> = (0..=20).map(|i| [0.1 + i as f64 * 0.02, 0.8]).collect();
        let n = note(vec![line]);
        assert!(!n.region().unwrap().closed);
        assert!(n.describe_place().contains("marked (open stroke"));
    }

    #[test]
    fn strokes_are_clamped_and_bounded() {
        let s = clean_strokes(vec![vec![[-0.5, 2.0], [f64::NAN, 0.1], [0.4, 0.4]], vec![]], true);
        assert_eq!(s, vec![vec![[0.0, 1.0], [0.4, 0.4]]]);
    }
}

#[cfg(test)]
mod sheet_and_text_tests {
    use super::*;

    fn base(deck: &str) -> Note {
        Note {
            id: "n".into(), deck: deck.into(), slide_id: "Summary".into(), slide_index: 1, x: 2.4, y: 7.5,
            shape_name: Some("B7 = \"$3,584,568\"".into()), strokes: vec![], shapes: vec![], quote: None, lines: None, target: None,
            text: "check".into(), author: "user".into(), created_at: String::new(), status: "open".into(),
            resolution: None, resolved_at: None, resolved_by: None,
        }
    }

    #[test]
    fn sheet_notes_name_cells() {
        let n = base("model.xlsx");
        assert_eq!(n.describe_place(), "model.xlsx sheet \"Summary\" at cell B7 (B7 = \"$3,584,568\")");
        let mut d = base("model.xlsx");
        d.strokes = vec![vec![[2.2, 4.1], [4.8, 4.1], [4.8, 9.6], [2.2, 9.6], [2.25, 4.2], [2.2, 4.15], [2.2, 4.1], [2.21, 4.1], [2.2, 4.12]]];
        d.shapes = vec!["B4 \"$2,500,000\"".into()];
        assert_eq!(d.describe_place(), "model.xlsx sheet \"Summary\", circled the cells B4:D9, covering B4 \"$2,500,000\"");
        assert_eq!(col_name(28), "AB");
    }

    #[test]
    fn pdf_and_image_notes_say_where() {
        let mut q = base("report.pdf");
        q.slide_index = 4;
        q.quote = Some("Revenue grew".into());
        assert_eq!(q.describe_place(), "report.pdf page 4, on the text: \"Revenue grew\"");
        let mut pin = base("report.pdf");
        pin.shape_name = None;
        pin.slide_index = 2;
        pin.x = 0.4;
        pin.y = 0.25;
        assert_eq!(pin.describe_place(), "report.pdf page 2, at x 40%, y 25% of the page (from top-left)");
        let mut img = base("team-photo.png");
        img.shape_name = None;
        img.x = 0.5;
        img.y = 0.1;
        assert_eq!(img.describe_place(), "team-photo.png (image), at x 50%, y 10% of the image (from top-left)");
        img.strokes = vec![vec![[0.1, 0.2], [0.3, 0.6]]];
        assert!(img.describe_place().starts_with("team-photo.png (image), marked (open stroke"));
        assert!(img.describe_place().contains("of the image"));
    }

    #[test]
    fn text_notes_quote_their_text() {
        let mut n = base("notes.md");
        n.quote = Some("Medicine should be engineered".into());
        n.lines = Some("12–14".into());
        assert_eq!(n.describe_place(), "notes.md lines 12–14, on the text: \"Medicine should be engineered\"");
    }

    #[test]
    fn speaker_notes_and_chat_notes_say_where_they_are() {
        let mut n = base("deck.pptx");
        n.slide_index = 3;
        n.quote = Some("Say the line, pause".into());
        n.target = Some("speakerNotes".into());
        assert_eq!(n.describe_place(), "deck.pptx slide 3, in the speaker notes, on the text: \"Say the line, pause\"");

        let mut c = base("");
        c.slide_id = "chat-1".into();
        c.quote = Some("3 at development candidate".into());
        c.target = Some("chat".into());
        assert_eq!(c.describe_place(), "this chat (an earlier message), on the text: \"3 at development candidate\"");
        // A note on a chat message is for that chat's agent only; other notes are for every chat.
        assert!(c.visible_in_chat("chat-1"));
        assert!(!c.visible_in_chat("chat-2"));
        assert!(n.visible_in_chat("chat-2"));
    }
}
