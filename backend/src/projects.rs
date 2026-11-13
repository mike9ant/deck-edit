//! Projects: a project is simply a folder plus the AI chats that work on it.
//! Persisted as one JSON file (`<data_dir>/projects.json`).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use axum::extract::{Path as AxPath, State};
use axum::routing::{get, patch};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub folder: String,
    pub created_at: String,
    #[serde(default)]
    pub last_opened_at: Option<String>,
}

pub struct ProjectStore {
    file: PathBuf,
    projects: Mutex<Vec<Project>>,
}

impl ProjectStore {
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("projects.json");
        let projects = std::fs::read_to_string(&file)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self { file, projects: Mutex::new(projects) }
    }

    fn save(&self, projects: &[Project]) -> Result<()> {
        let text = serde_json::to_string_pretty(projects)?;
        crate::files::write_atomic(&self.file, text.as_bytes())?;
        Ok(())
    }

    pub fn list(&self) -> Vec<Project> {
        self.projects.lock().unwrap().clone()
    }

    pub fn get(&self, id: &str) -> Result<Project> {
        self.projects
            .lock()
            .unwrap()
            .iter()
            .find(|p| p.id == id)
            .cloned()
            .ok_or_else(|| AppError::NotFound(format!("project {id} not found")))
    }

    /// The project's folder as a canonical path.
    pub fn folder(&self, id: &str) -> Result<PathBuf> {
        let p = self.get(id)?;
        let folder = PathBuf::from(&p.folder);
        folder
            .canonicalize()
            .map_err(|e| AppError::NotFound(format!("project folder {}: {e}", p.folder)))
    }

    pub fn create(&self, name: String, folder: String) -> Result<Project> {
        let project = Project {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            folder,
            created_at: chrono::Utc::now().to_rfc3339(),
            last_opened_at: None,
        };
        let mut all = self.projects.lock().unwrap();
        all.push(project.clone());
        self.save(&all)?;
        Ok(project)
    }

    pub fn update(&self, id: &str, f: impl FnOnce(&mut Project)) -> Result<Project> {
        let mut all = self.projects.lock().unwrap();
        let p = all
            .iter_mut()
            .find(|p| p.id == id)
            .ok_or_else(|| AppError::NotFound(format!("project {id} not found")))?;
        f(p);
        let out = p.clone();
        self.save(&all)?;
        Ok(out)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut all = self.projects.lock().unwrap();
        all.retain(|p| p.id != id);
        self.save(&all)
    }
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/projects", get(list).post(create))
        .route("/projects/{id}", patch(update).delete(delete).get(get_one))
}

async fn list(State(state): State<AppState>) -> Json<Vec<Project>> {
    let mut all = state.projects.list();
    // Most recently opened first.
    all.sort_by(|a, b| {
        b.last_opened_at
            .as_deref()
            .unwrap_or(&b.created_at)
            .cmp(a.last_opened_at.as_deref().unwrap_or(&a.created_at))
    });
    Json(all)
}

async fn get_one(State(state): State<AppState>, AxPath(id): AxPath<String>) -> Result<Json<Project>> {
    Ok(Json(state.projects.get(&id)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateBody {
    name: Option<String>,
    folder: String,
    /// Create the folder when it doesn't exist yet.
    #[serde(default)]
    create_folder: bool,
}

async fn create(State(state): State<AppState>, Json(body): Json<CreateBody>) -> Result<Json<Project>> {
    let folder = PathBuf::from(body.folder.trim());
    if !folder.is_absolute() {
        return Err(AppError::BadRequest("folder must be an absolute path".into()));
    }
    if !folder.exists() {
        if body.create_folder {
            std::fs::create_dir_all(&folder)?;
        } else {
            return Err(AppError::BadRequest(format!("{} does not exist", folder.display())));
        }
    }
    if !folder.is_dir() {
        return Err(AppError::BadRequest(format!("{} is not a folder", folder.display())));
    }
    let folder = folder.canonicalize()?;
    let name = body
        .name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or_else(|| {
            folder
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Project".to_string())
        });
    let project = state.projects.create(name, folder.to_string_lossy().into_owned())?;
    Ok(Json(project))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateBody {
    name: Option<String>,
    #[serde(default)]
    touch: bool,
}

async fn update(
    State(state): State<AppState>,
    AxPath(id): AxPath<String>,
    Json(body): Json<UpdateBody>,
) -> Result<Json<Project>> {
    let p = state.projects.update(&id, |p| {
        if let Some(n) = body.name.filter(|n| !n.trim().is_empty()) {
            p.name = n;
        }
        if body.touch {
            p.last_opened_at = Some(chrono::Utc::now().to_rfc3339());
        }
    })?;
    Ok(Json(p))
}

async fn delete(State(state): State<AppState>, AxPath(id): AxPath<String>) -> Result<Json<serde_json::Value>> {
    state.projects.delete(&id)?;
    Ok(Json(serde_json::json!({ "ok": true })))
}
