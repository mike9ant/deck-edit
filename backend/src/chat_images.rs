//! Images attached to a chat message (pasted, dropped or picked in the
//! composer). Ported from ma-code-navigator's `routes/chat_images.rs`.
//!
//! Each message's images are validated by content (PNG/JPEG/GIF/WebP only,
//! ≤ 5 MB each, ≤ 4 per message), stored under
//! `<data_dir>/chat-images/<chat>/<uuid>.<ext>` so the transcript can show
//! them later (`GET /api/chats/{cid}/images/{file}`), and handed to the CLI
//! as base64 image blocks on a stream-json stdin message — the only headless
//! path that carries image content. The stored path is also given to the
//! agent so it can place the image on a slide.

use std::path::{Path, PathBuf};

use axum::extract::{Path as AxPath, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use base64::Engine;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::{AppError, Result};
use crate::state::AppState;

pub const MAX_IMAGES: usize = 4;
pub const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingImage {
    /// Base64 of the bytes (no `data:` prefix).
    pub data: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
}

/// What the transcript keeps about an attached image.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatImage {
    /// Stored file name (`{uuid}.{ext}`), served by the images route.
    pub file: String,
    pub media_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// A stored image ready to send to the CLI.
pub struct AttachedImage {
    pub meta: ChatImage,
    pub path: PathBuf,
    pub data: String,
}

fn sniff(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}

fn media_type_for(file: &str) -> Option<&'static str> {
    match file.rsplit_once('.')?.1 {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

/// Only file names of our own minting (`{uuid}.{ext}`) are ever served.
fn valid_image_file(file: &str) -> bool {
    file.rsplit_once('.')
        .is_some_and(|(stem, _)| Uuid::parse_str(stem).is_ok_and(|u| u.hyphenated().to_string() == stem))
        && media_type_for(file).is_some()
}

pub fn images_dir(data_dir: &Path, chat_id: &str) -> PathBuf {
    data_dir.join("chat-images").join(chat_id)
}

fn clean_name(name: &str) -> Option<String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String = base.chars().filter(|c| !c.is_control()).take(120).collect();
    let cleaned = cleaned.trim().to_string();
    (!cleaned.is_empty()).then_some(cleaned)
}

/// Validate and store a message's images; rejects the whole message on the
/// first bad one (a turn must never run with an attachment silently missing).
pub fn store_images(data_dir: &Path, chat_id: &str, incoming: Vec<IncomingImage>) -> Result<Vec<AttachedImage>> {
    if incoming.is_empty() {
        return Ok(Vec::new());
    }
    if incoming.len() > MAX_IMAGES {
        return Err(AppError::BadRequest(format!("a message can carry at most {MAX_IMAGES} images")));
    }
    let dir = images_dir(data_dir, chat_id);
    let mut out = Vec::with_capacity(incoming.len());
    for (i, img) in incoming.into_iter().enumerate() {
        let n = i + 1;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(img.data.as_bytes())
            .map_err(|_| AppError::BadRequest(format!("image {n} is not valid base64")))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err(AppError::BadRequest(format!("image {n} is larger than {} MB", MAX_IMAGE_BYTES / (1024 * 1024))));
        }
        let Some((media_type, ext)) = sniff(&bytes) else {
            return Err(AppError::BadRequest(format!("image {n} is not a PNG, JPEG, GIF or WebP image")));
        };
        std::fs::create_dir_all(&dir)?;
        let file = format!("{}.{ext}", Uuid::new_v4());
        let path = dir.join(&file);
        std::fs::write(&path, &bytes)?;
        out.push(AttachedImage {
            meta: ChatImage {
                file,
                media_type: media_type.to_string(),
                width: img.width,
                height: img.height,
                bytes: bytes.len() as u64,
                name: img.name.as_deref().and_then(clean_name),
            },
            path,
            data: img.data,
        });
    }
    Ok(out)
}

/// `GET /api/chats/{cid}/images/{file}` — a stored attachment, for the transcript.
pub async fn serve_image(State(state): State<AppState>, AxPath((cid, file)): AxPath<(String, String)>) -> Result<Response> {
    if Uuid::parse_str(&cid).is_err() || !valid_image_file(&file) {
        return Err(AppError::NotFound("no such image".into()));
    }
    let path = images_dir(&state.data_dir, &cid).join(&file);
    let bytes = tokio::fs::read(&path).await.map_err(|_| AppError::NotFound("no such image".into()))?;
    let mime = media_type_for(&file).unwrap_or("application/octet-stream");
    Ok(([(header::CONTENT_TYPE, mime), (header::CACHE_CONTROL, "private, max-age=31536000, immutable")], bytes).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_and_stores() {
        let dir = tempfile::tempdir().unwrap();
        let png = base64::engine::general_purpose::STANDARD.encode(b"\x89PNG\r\n\x1a\nrest");
        let out = store_images(dir.path(), "c", vec![IncomingImage { data: png, name: Some("/x/shot.png".into()), width: Some(2), height: Some(1) }]).unwrap();
        assert_eq!(out[0].meta.media_type, "image/png");
        assert_eq!(out[0].meta.name.as_deref(), Some("shot.png"));
        assert!(out[0].path.exists());
        assert!(valid_image_file(&out[0].meta.file));

        let bad = base64::engine::general_purpose::STANDARD.encode(b"<svg/>");
        assert!(store_images(dir.path(), "c", vec![IncomingImage { data: bad, name: None, width: None, height: None }]).is_err());
        assert!(!valid_image_file("../../etc/passwd.png"));
    }
}
