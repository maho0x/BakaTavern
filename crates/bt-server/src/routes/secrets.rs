use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing};
use bt_store::repo::secrets::{self, NewSecret, SecretInfo, SecretPatch};
use serde::Deserialize;
use ts_rs::TS;

use crate::auth::{ClientId, CurrentUser};
use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::net::normalize_origin;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/secrets", routing::get(list).post(create))
        .route("/api/secrets/{id}", routing::patch(update).delete(delete))
}

fn origins(input: &[String]) -> ApiResult<Vec<String>> {
    let mut out = Vec::new();
    for item in input {
        let origin = normalize_origin(item)
            .ok_or_else(|| ApiError::bad_request(format!("invalid origin {item:?}")))?;
        if !out.contains(&origin) {
            out.push(origin);
        }
    }
    Ok(out)
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<SecretInfo>>> {
    Ok(Json(
        state.db.read(move |c| secrets::list(c, &user.id)).await?,
    ))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct CreateSecret {
    /// Provider id, e.g. `openai`, `claude`, `custom`.
    pub provider: String,
    pub label: Option<String>,
    pub value: String,
    /// Origins the key may be sent to, e.g. `https://api.openai.com`.
    pub allowed_origins: Vec<String>,
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<CreateSecret>,
) -> ApiResult<Json<SecretInfo>> {
    let value = body.value.trim().to_string();
    if value.is_empty() {
        return Err(ApiError::bad_request("the key is empty"));
    }
    let allowed = origins(&body.allowed_origins)?;
    if allowed.is_empty() {
        return Err(ApiError::bad_request(
            "at least one allowed origin is required",
        ));
    }
    let masked = crypto::mask(&value);
    let ciphertext = state.secrets.seal(value.as_bytes());
    let label = body
        .label
        .filter(|l| !l.trim().is_empty())
        .unwrap_or_else(|| masked.clone());
    let user_id = user.id.clone();
    let info = state
        .db
        .write(move |c| {
            secrets::create(
                c,
                &user_id,
                NewSecret {
                    provider: &body.provider,
                    label: &label,
                    masked: &masked,
                    ciphertext: &ciphertext,
                    allowed_origins: &allowed,
                },
            )
        })
        .await?;
    state.notify(&user.id, "secret", "created", &info.id, None, &origin);
    Ok(Json(info))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UpdateSecret {
    pub label: Option<String>,
    pub value: Option<String>,
    pub allowed_origins: Option<Vec<String>>,
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<UpdateSecret>,
) -> ApiResult<Json<SecretInfo>> {
    let allowed = body.allowed_origins.as_deref().map(origins).transpose()?;
    if allowed.as_ref().is_some_and(Vec::is_empty) {
        return Err(ApiError::bad_request(
            "at least one allowed origin is required",
        ));
    }
    let value = body
        .value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let sealed = value
        .as_ref()
        .map(|v| (crypto::mask(v), state.secrets.seal(v.as_bytes())));
    let user_id = user.id.clone();
    let info = state
        .db
        .write(move |c| {
            secrets::update(
                c,
                &user_id,
                &id,
                SecretPatch {
                    label: body.label.as_deref(),
                    allowed_origins: allowed.as_deref(),
                    value: sealed.as_ref().map(|(m, ct)| (m.as_str(), ct.as_slice())),
                },
            )
        })
        .await?;
    state.notify(&user.id, "secret", "updated", &info.id, None, &origin);
    Ok(Json(info))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, secret_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| secrets::delete(c, &user_id, &secret_id))
        .await?;
    state.notify(&user.id, "secret", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}
