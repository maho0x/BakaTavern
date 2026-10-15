mod bootstrap;
mod characters;
mod chats;
mod files;
mod lorebooks;
mod personas;
mod presets;
mod secrets;
mod settings;
mod tags;

use axum::Router;
use axum::extract::Multipart;

use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub use files::store_file;

pub fn routes() -> Router<AppState> {
    Router::new()
        .merge(bootstrap::routes())
        .merge(characters::routes())
        .merge(chats::routes())
        .merge(files::routes())
        .merge(lorebooks::routes())
        .merge(personas::routes())
        .merge(presets::routes())
        .merge(secrets::routes())
        .merge(settings::routes())
        .merge(tags::routes())
}

/// An uploaded file from a multipart form.
pub struct Upload {
    pub file_name: String,
    pub bytes: Vec<u8>,
}

/// Reads every file part, plus plain text fields as `(name, value)`.
pub async fn read_multipart(
    mut multipart: Multipart,
) -> ApiResult<(Vec<Upload>, Vec<(String, String)>)> {
    let mut files = Vec::new();
    let mut fields = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request(e.to_string()))?
    {
        let name = field.name().unwrap_or_default().to_string();
        match field.file_name().map(str::to_string) {
            Some(file_name) => {
                let bytes = field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::bad_request(e.to_string()))?;
                files.push(Upload {
                    file_name,
                    bytes: bytes.to_vec(),
                });
            }
            None => {
                let text = field
                    .text()
                    .await
                    .map_err(|e| ApiError::bad_request(e.to_string()))?;
                fields.push((name, text));
            }
        }
    }
    Ok((files, fields))
}

pub fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
}

pub fn single_upload(files: Vec<Upload>) -> ApiResult<Upload> {
    files
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::bad_request("no file was uploaded"))
}
