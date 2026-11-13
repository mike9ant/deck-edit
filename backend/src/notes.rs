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
    text: String,
}

async fn create(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Json(b): Json<CreateBody>,
) -> Result<Json<Note>> {
    state.projects.get(&id)?;
    let note = Note {
        id: uuid::Uuid::new_v4().to_string()[..8].to_string(),
        deck: b.deck,
        slide_id: b.slide_id,
        slide_index: b.slide_index,
        x: b.x.clamp(0.0, 1.0),
        y: b.y.clamp(0.0, 1.0),
        shape_name: b.shape_name,
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
