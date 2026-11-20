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

/// The project list. Another Deck Edit may share the data folder (the desktop app and the browser
/// version, say), so every change re-reads the file first and writes it back at once — neither
/// drops the other's projects — and `list` reads it fresh. Lookups use the copy in memory, refreshed
/// when a project isn't in it (one the other just created).
pub struct ProjectStore {
    file: PathBuf,
    projects: Mutex<Vec<Project>>,
}

impl ProjectStore {
    pub fn load(data_dir: &Path) -> Self {
        let file = data_dir.join("projects.json");
        let projects = read_list(&file).unwrap_or_default();
        Self { file, projects: Mutex::new(projects) }
    }

    fn save(&self, projects: &[Project]) -> Result<()> {
        let text = serde_json::to_string_pretty(projects)?;
        crate::files::write_atomic(&self.file, text.as_bytes())?;
        Ok(())
    }

    /// The list as it is on disk now (kept as is when the file can't be read, rather than lose projects).
    fn fresh(&self) -> std::sync::MutexGuard<'_, Vec<Project>> {
        let mut all = self.projects.lock().unwrap();
        if let Some(disk) = read_list(&self.file) {
            *all = disk;
        }
        all
    }

    pub fn list(&self) -> Vec<Project> {
        self.fresh().clone()
    }

    pub fn get(&self, id: &str) -> Result<Project> {
        let find = |all: &[Project]| all.iter().find(|p| p.id == id).cloned();
        if let Some(p) = find(&self.projects.lock().unwrap()) {
            return Ok(p);
        }
        find(&self.fresh()).ok_or_else(|| AppError::NotFound(format!("project {id} not found")))
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
        let mut all = self.fresh();
        all.push(project.clone());
        self.save(&all)?;
        Ok(project)
    }

    pub fn update(&self, id: &str, f: impl FnOnce(&mut Project)) -> Result<Project> {
        let mut all = self.fresh();
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
        let mut all = self.fresh();
        all.retain(|p| p.id != id);
        self.save(&all)
    }
}

/// The list in `file`: empty when there's no file yet; None when it can't be read or parsed.
fn read_list(file: &Path) -> Option<Vec<Project>> {
    match std::fs::read_to_string(file) {
        Ok(s) => serde_json::from_str(&s).ok(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(Vec::new()),
        Err(_) => None,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_apps_sharing_the_data_folder_keep_each_others_projects() {
        let dir = tempfile::tempdir().unwrap();
        // The desktop app and the browser server, both started on the same data folder.
        let desktop = ProjectStore::load(dir.path());
        let browser = ProjectStore::load(dir.path());
        let a = desktop.create("xlang".into(), "/x".into()).unwrap();
        // The browser server never saw "xlang" in memory; its own change must not drop it.
        let b = browser.create("Biz".into(), "/b".into()).unwrap();
        browser.update(&b.id, |p| p.last_opened_at = Some("now".into())).unwrap();
        let names = |s: &ProjectStore| { let mut n: Vec<String> = s.list().into_iter().map(|p| p.name).collect(); n.sort(); n };
        assert_eq!(names(&desktop), vec!["Biz", "xlang"]);
        assert_eq!(names(&browser), vec!["Biz", "xlang"]);
        // A project the other app created is found by id.
        assert_eq!(browser.get(&a.id).unwrap().name, "xlang");
        desktop.delete(&b.id).unwrap();
        assert_eq!(names(&browser), vec!["xlang"]);
    }
}
