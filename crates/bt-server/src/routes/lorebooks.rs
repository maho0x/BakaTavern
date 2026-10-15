use axum::extract::{Multipart, Path, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing};
use bt_formats::worldinfo;
use bt_store::repo::lorebooks::{self, Lorebook, LorebookInfo};
use serde::Deserialize;
use serde_json::{Value, json};
use ts_rs::TS;

use super::{field, read_multipart, single_upload};
use crate::auth::{ClientId, CurrentUser};
use crate::convert::{attachment, sanitize_file_name};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/lorebooks", routing::get(list).post(create))
        .route("/api/lorebooks/import", routing::post(import))
        .route(
            "/api/lorebooks/{id}",
            routing::get(get).put(replace).patch(rename).delete(delete),
        )
        .route("/api/lorebooks/{id}/entries", routing::put(upsert_entry))
        .route(
            "/api/lorebooks/{id}/entries/{uid}",
            routing::delete(delete_entry),
        )
        .route("/api/lorebooks/{id}/export", routing::get(export))
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<LorebookInfo>>> {
    Ok(Json(
        state.db.read(move |c| lorebooks::list(c, &user.id)).await?,
    ))
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Lorebook>> {
    Ok(Json(
        state
            .db
            .read(move |c| lorebooks::get(c, &user.id, &id))
            .await?,
    ))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct CreateLorebook {
    pub name: String,
    #[ts(optional, type = "Record<string, unknown>")]
    pub data: Option<Value>,
    #[ts(optional, type = "Array<Record<string, unknown>>")]
    pub entries: Option<Vec<Value>>,
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<CreateLorebook>,
) -> ApiResult<Json<Lorebook>> {
    let user_id = user.id.clone();
    let data = body
        .data
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let book = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let book = lorebooks::create(
                &tx,
                &user_id,
                &body.name,
                &data,
                body.entries.unwrap_or_default(),
            )?;
            tx.commit()?;
            Ok(book)
        })
        .await?;
    state.notify(
        &user.id,
        "lorebook",
        "created",
        &book.id,
        Some(book.rev),
        &origin,
    );
    Ok(Json(book))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct ReplaceLorebook {
    #[ts(optional, type = "Record<string, unknown>")]
    pub data: Option<Value>,
    #[ts(type = "Array<Record<string, unknown>>")]
    pub entries: Vec<Value>,
    pub rev: Option<i64>,
}

async fn replace(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<ReplaceLorebook>,
) -> ApiResult<Json<Lorebook>> {
    let user_id = user.id.clone();
    let book = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let current = lorebooks::get(&tx, &user_id, &id)?;
            let data = body.data.filter(Value::is_object).unwrap_or(current.data);
            let book = lorebooks::replace(&tx, &user_id, &id, &data, body.entries, body.rev)?;
            tx.commit()?;
            Ok(book)
        })
        .await?;
    state.notify(
        &user.id,
        "lorebook",
        "updated",
        &book.id,
        Some(book.rev),
        &origin,
    );
    Ok(Json(book))
}

#[derive(Deserialize)]
struct RenameBody {
    name: String,
}

async fn rename(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<RenameBody>,
) -> ApiResult<Json<Lorebook>> {
    let user_id = user.id.clone();
    let book = state
        .db
        .write(move |c| {
            lorebooks::rename(c, &user_id, &id, &body.name)?;
            lorebooks::get(c, &user_id, &id)
        })
        .await?;
    state.notify(
        &user.id,
        "lorebook",
        "updated",
        &book.id,
        Some(book.rev),
        &origin,
    );
    Ok(Json(book))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, book_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| lorebooks::delete(c, &user_id, &book_id))
        .await?;
    state.notify(&user.id, "lorebook", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

async fn upsert_entry(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(entry): Json<Value>,
) -> ApiResult<Json<Value>> {
    let (user_id, book_id) = (user.id.clone(), id.clone());
    let stored = state
        .db
        .write(move |c| lorebooks::upsert_entry(c, &user_id, &book_id, entry))
        .await?;
    state.notify(&user.id, "lorebook", "updated", &id, None, &origin);
    Ok(Json(stored))
}

async fn delete_entry(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path((id, uid)): Path<(String, i64)>,
) -> ApiResult<StatusCode> {
    let (user_id, book_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| lorebooks::delete_entry(c, &user_id, &book_id, uid))
        .await?;
    state.notify(&user.id, "lorebook", "updated", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

async fn import(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    multipart: Multipart,
) -> ApiResult<Json<Lorebook>> {
    let (uploads, fields) = read_multipart(multipart).await?;
    let upload = single_upload(uploads)?;
    let value: Value = serde_json::from_slice(&upload.bytes)
        .map_err(|e| ApiError::bad_request(format!("invalid JSON: {e}")))?;
    let world = worldinfo::parse(value)?;
    let base = field(&fields, "name")
        .map(str::to_string)
        .unwrap_or_else(|| upload.file_name.trim_end_matches(".json").to_string());
    let user_id = user.id.clone();
    let book = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let mut name = base.trim().to_string();
            let mut n = 2;
            while lorebooks::id_by_name(&tx, &user_id, &name)?.is_some() {
                name = format!("{} ({n})", base.trim());
                n += 1;
            }
            let book = lorebooks::create(
                &tx,
                &user_id,
                &name,
                &Value::Object(world.data),
                world.entries,
            )?;
            tx.commit()?;
            Ok(book)
        })
        .await?;
    state.notify(
        &user.id,
        "lorebook",
        "created",
        &book.id,
        Some(book.rev),
        &origin,
    );
    Ok(Json(book))
}

async fn export(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let book = state
        .db
        .read(move |c| lorebooks::get(c, &user.id, &id))
        .await?;
    let body = serde_json::to_vec_pretty(&worldinfo::to_json(&book.data, &book.entries))
        .map_err(ApiError::internal)?;
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    let name = format!("{}.json", sanitize_file_name(&book.name));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&attachment(&name)).map_err(ApiError::internal)?,
    );
    Ok(response)
}
