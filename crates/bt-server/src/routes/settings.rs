use axum::extract::{Path, State};
use axum::{Json, Router, routing};
use bt_store::repo::settings::{self, SettingsDoc};
use serde::Deserialize;
use serde_json::Value;
use ts_rs::TS;

use crate::auth::{ClientId, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/settings", routing::get(list))
        .route("/api/settings/{namespace}", routing::get(get).put(put))
}

fn valid_namespace(ns: &str) -> bool {
    !ns.is_empty()
        && ns.len() <= 64
        && ns
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<SettingsDoc>>> {
    Ok(Json(
        state.db.read(move |c| settings::list(c, &user.id)).await?,
    ))
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(ns): Path<String>,
) -> ApiResult<Json<SettingsDoc>> {
    let doc = state
        .db
        .read(move |c| settings::get(c, &user.id, &ns))
        .await?;
    doc.map(Json).ok_or_else(ApiError::not_found)
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct PutSettings {
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
    /// Expected revision; 0 when creating. Omit to overwrite unconditionally.
    pub rev: Option<i64>,
}

async fn put(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(ns): Path<String>,
    Json(body): Json<PutSettings>,
) -> ApiResult<Json<SettingsDoc>> {
    if !valid_namespace(&ns) {
        return Err(ApiError::bad_request("invalid settings namespace"));
    }
    if !body.data.is_object() {
        return Err(ApiError::bad_request("settings must be a JSON object"));
    }
    let user_id = user.id.clone();
    let doc = state
        .db
        .write(move |c| settings::put(c, &user_id, &ns, &body.data, body.rev))
        .await?;
    state.notify(
        &user.id,
        "settings",
        "updated",
        &doc.namespace,
        Some(doc.rev),
        &origin,
    );
    Ok(Json(doc))
}
