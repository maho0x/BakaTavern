use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing};
use bt_store::BlobStore;
use bt_store::repo::files::{self, FileRecord};
use serde::Deserialize;

use super::{read_multipart, single_upload};
use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::media;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/files", routing::post(upload))
        .route("/api/files/{hash}", routing::get(download))
        .route("/api/thumbs/{hash}", routing::get(thumbnail))
}

/// Stores bytes in the blob store and records their type.
pub async fn store_file(state: &AppState, bytes: Vec<u8>) -> ApiResult<FileRecord> {
    let mime = media::sniff_mime(&bytes);
    let dims = if media::is_image(mime) {
        media::dimensions(&bytes)
    } else {
        None
    };
    let size = bytes.len() as i64;
    let blobs = state.blobs.clone();
    let hash = tokio::task::spawn_blocking(move || blobs.put(&bytes))
        .await
        .map_err(ApiError::internal)??;
    Ok(state
        .db
        .write(move |c| files::insert_if_absent(c, &hash, mime, size, dims))
        .await?)
}

async fn upload(
    State(state): State<AppState>,
    _user: CurrentUser,
    multipart: Multipart,
) -> ApiResult<Json<FileRecord>> {
    let (uploads, _) = read_multipart(multipart).await?;
    let upload = single_upload(uploads)?;
    Ok(Json(store_file(&state, upload.bytes).await?))
}

const IMMUTABLE: &str = "private, max-age=31536000, immutable";

async fn download(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(hash): Path<String>,
) -> ApiResult<Response> {
    if !BlobStore::is_valid_hash(&hash) {
        return Err(ApiError::not_found());
    }
    let lookup = hash.clone();
    let record = state
        .db
        .read(move |c| files::get(c, &lookup))
        .await?
        .ok_or_else(ApiError::not_found)?;
    let blobs = state.blobs.clone();
    let bytes = tokio::task::spawn_blocking(move || blobs.read(&hash))
        .await
        .map_err(ApiError::internal)?
        .map_err(|_| ApiError::not_found())?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    if let Ok(mime) = HeaderValue::from_str(&record.mime) {
        headers.insert(header::CONTENT_TYPE, mime);
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
    Ok(response)
}

#[derive(Deserialize)]
struct ThumbQuery {
    w: Option<u32>,
}

async fn thumbnail(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(hash): Path<String>,
    Query(query): Query<ThumbQuery>,
) -> ApiResult<Response> {
    if !BlobStore::is_valid_hash(&hash) {
        return Err(ApiError::not_found());
    }
    // A small set of widths keeps the cache bounded.
    let width = match query.w.unwrap_or(256) {
        0..=96 => 96,
        97..=256 => 256,
        _ => 512,
    };
    let cache_dir = state.config.cache_dir().join("thumbs").join(&hash[..2]);
    let blobs = state.blobs.clone();
    let result =
        tokio::task::spawn_blocking(move || -> anyhow::Result<Option<(Vec<u8>, &'static str)>> {
            for (ext, mime) in [("jpg", "image/jpeg"), ("png", "image/png")] {
                let path = cache_dir.join(format!("{hash}-{width}.{ext}"));
                if let Ok(bytes) = std::fs::read(&path) {
                    return Ok(Some((bytes, mime)));
                }
            }
            let Ok(original) = blobs.read(&hash) else {
                return Ok(None);
            };
            let (bytes, mime) = match media::thumbnail(&original, width) {
                Ok(thumb) => thumb,
                // Formats the decoder does not know are served as they are.
                Err(_) => return Ok(Some((original, "application/octet-stream"))),
            };
            let ext = if mime == "image/png" { "png" } else { "jpg" };
            std::fs::create_dir_all(&cache_dir)?;
            std::fs::write(cache_dir.join(format!("{hash}-{width}.{ext}")), &bytes)?;
            Ok(Some((bytes, mime)))
        })
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    let _ = user;
    let (bytes, mime) = result.ok_or_else(ApiError::not_found)?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    if mime != "application/octet-stream" {
        headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    }
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(IMMUTABLE));
    Ok(response)
}
