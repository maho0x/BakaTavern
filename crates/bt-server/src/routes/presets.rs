use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing};
use bt_store::repo::presets::{self, Preset, PresetInfo};
use serde::Deserialize;
use serde_json::Value;
use ts_rs::TS;

use crate::auth::{ClientId, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/presets", routing::get(list).put(upsert))
        .route(
            "/api/presets/{id}",
            routing::get(get).patch(update).delete(delete),
        )
}

#[derive(Deserialize)]
struct ListQuery {
    kind: Option<String>,
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Vec<PresetInfo>>> {
    Ok(Json(
        state
            .db
            .read(move |c| presets::list(c, &user.id, q.kind.as_deref()))
            .await?,
    ))
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Preset>> {
    Ok(Json(
        state
            .db
            .read(move |c| presets::get(c, &user.id, &id))
            .await?,
    ))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct UpsertPreset {
    pub kind: String,
    pub name: String,
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
}

/// `PUT /api/presets`: creates the preset or replaces the one with the same kind and name.
async fn upsert(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<UpsertPreset>,
) -> ApiResult<Json<Preset>> {
    if !body.data.is_object() {
        return Err(ApiError::bad_request("preset data must be a JSON object"));
    }
    let user_id = user.id.clone();
    let preset = state
        .db
        .write(move |c| presets::upsert(c, &user_id, &body.kind, &body.name, &body.data))
        .await?;
    state.notify(
        &user.id,
        "preset",
        "updated",
        &preset.info.id,
        Some(preset.info.rev),
        &origin,
    );
    Ok(Json(preset))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UpdatePreset {
    pub name: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub data: Option<Value>,
    pub rev: Option<i64>,
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<UpdatePreset>,
) -> ApiResult<Json<Preset>> {
    if body.data.as_ref().is_some_and(|d| !d.is_object()) {
        return Err(ApiError::bad_request("preset data must be a JSON object"));
    }
    let user_id = user.id.clone();
    let preset = state
        .db
        .write(move |c| {
            presets::update(
                c,
                &user_id,
                &id,
                body.name.as_deref(),
                body.data.as_ref(),
                body.rev,
            )
        })
        .await?;
    state.notify(
        &user.id,
        "preset",
        "updated",
        &preset.info.id,
        Some(preset.info.rev),
        &origin,
    );
    Ok(Json(preset))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, preset_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| presets::delete(c, &user_id, &preset_id))
        .await?;
    state.notify(&user.id, "preset", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}
