//! Moving to and from SillyTavern: importing a backup zip, exporting a SillyTavern user folder.

use std::io::{Seek, SeekFrom};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, State};
use axum::http::{HeaderValue, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncWriteExt;
use ts_rs::TS;

use crate::auth::{ClientId, CurrentUser};
use crate::convert::attachment;
use crate::error::{ApiError, ApiResult};
use crate::st_export::{self, StExportNames};
use crate::st_import::{self, ImportOptions, StImportReport};
use crate::state::AppState;

pub fn routes(max_import_mb: u64) -> Router<AppState> {
    Router::new()
        .route("/api/export/st/names", get(export_names))
        .route("/api/export/st", post(export_st))
        .route("/api/import/st", post(import_st))
        // Backups with images can be large; they are written to disk, not held in memory.
        .layer(DefaultBodyLimit::max(
            (max_import_mb as usize).saturating_mul(1024 * 1024),
        ))
}

async fn import_st(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    mut multipart: Multipart,
) -> ApiResult<Json<StImportReport>> {
    let temp = tempfile::tempdir().map_err(ApiError::internal)?;
    let zip_path = temp.path().join("backup.zip");
    let mut options = ImportOptions::default();
    let mut received = false;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?
    {
        match field.name() {
            Some("secrets") => {
                options.secrets = field.text().await.unwrap_or_default() == "true";
            }
            Some("file") => {
                let mut out = tokio::fs::File::create(&zip_path)
                    .await
                    .map_err(ApiError::internal)?;
                while let Some(chunk) = field
                    .chunk()
                    .await
                    .map_err(|e| ApiError::bad_request(e.to_string()))?
                {
                    out.write_all(&chunk).await.map_err(ApiError::internal)?;
                }
                out.flush().await.map_err(ApiError::internal)?;
                received = true;
            }
            _ => {}
        }
    }
    if !received {
        return Err(ApiError::bad_request("no file was uploaded"));
    }
    let extracted = temp.path().join("data");
    let source = zip_path.clone();
    let target = extracted.clone();
    tokio::task::spawn_blocking(move || {
        st_import::extract_zip(std::fs::File::open(source)?, &target)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(|e| ApiError::bad_request(format!("not a readable zip archive: {e}")))?;
    let report = st_import::import(&state, &user.id, &extracted, options).await?;
    st_import::notify_imported(&state, &user.id, &origin);
    Ok(Json(report))
}

async fn export_names(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<StExportNames>> {
    Ok(Json(st_export::names(&state, &user.id).await?))
}

#[derive(Deserialize, TS)]
#[ts(export)]
pub struct StExportRequest {
    /// SillyTavern `settings.json`, written by the web app with the names from `/api/export/st/names`.
    #[ts(type = "Record<string, unknown>")]
    pub settings: Value,
}

async fn export_st(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<StExportRequest>,
) -> ApiResult<Response> {
    // An unnamed temporary file: the archive can be larger than is comfortable to keep in memory.
    let file = tokio::task::spawn_blocking(tempfile::tempfile)
        .await
        .map_err(ApiError::internal)?
        .map_err(ApiError::internal)?;
    let mut file = st_export::write_zip(&state, &user.id, body.settings, file).await?;
    file.seek(SeekFrom::Start(0)).map_err(ApiError::internal)?;
    let stream = tokio_util::io::ReaderStream::new(tokio::fs::File::from_std(file));
    let mut response = Body::from_stream(stream).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/zip"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&attachment("sillytavern-data.zip")).map_err(ApiError::internal)?,
    );
    Ok(response)
}
