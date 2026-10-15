use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing};
use bt_store::repo::tags::{self, Tag};
use serde::Deserialize;

use crate::auth::{ClientId, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/tags", routing::get(list).post(create))
        .route("/api/tags/{id}", routing::put(update).delete(delete))
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Vec<Tag>>> {
    Ok(Json(state.db.read(move |c| tags::list(c, &user.id)).await?))
}

#[derive(Deserialize)]
struct CreateTag {
    name: String,
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<CreateTag>,
) -> ApiResult<Json<Tag>> {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Err(ApiError::bad_request("the tag name is empty"));
    }
    let user_id = user.id.clone();
    let tag = state
        .db
        .write(move |c| tags::ensure(c, &user_id, &name))
        .await?;
    state.notify(&user.id, "tag", "created", &tag.id, None, &origin);
    Ok(Json(tag))
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(mut tag): Json<Tag>,
) -> ApiResult<Json<Tag>> {
    if !matches!(tag.folder.as_str(), "none" | "open" | "closed") {
        return Err(ApiError::bad_request("folder must be none, open or closed"));
    }
    tag.id = id;
    let user_id = user.id.clone();
    let tag = state
        .db
        .write(move |c| tags::update(c, &user_id, &tag))
        .await?;
    state.notify(&user.id, "tag", "updated", &tag.id, None, &origin);
    Ok(Json(tag))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, tag_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| tags::delete(c, &user_id, &tag_id))
        .await?;
    state.notify(&user.id, "tag", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}
