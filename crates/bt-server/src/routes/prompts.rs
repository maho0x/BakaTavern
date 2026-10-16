//! Prompt logs: what each generation sent, as the web app recorded it for its prompt viewer
//! (SillyTavern keeps these "itemized prompts" in the browser instead).

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing};
use bt_store::repo::{chats, prompt_logs};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/chats/{id}/prompts", routing::get(get).post(put))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PutPrompt {
    /// When the generation started: the reply's `gen_started`.
    pub started_at: String,
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PromptQuery {
    started_at: String,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct PromptLog {
    #[ts(type = "Record<string, unknown> | null")]
    pub prompt: Option<Value>,
    /// The chat's prompt before this one, to compare with.
    #[ts(type = "Record<string, unknown> | null")]
    pub previous: Option<Value>,
}

fn check(started_at: &str) -> ApiResult<()> {
    if started_at.is_empty() || started_at.len() > 64 {
        return Err(ApiError::bad_request("startedAt must be a date"));
    }
    Ok(())
}

async fn put(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Json(body): Json<PutPrompt>,
) -> ApiResult<StatusCode> {
    check(&body.started_at)?;
    state
        .db
        .write(move |c| {
            chats::ensure_owner(c, &user.id, &id)?;
            prompt_logs::put(c, &id, &body.started_at, &body.data)
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<PromptQuery>,
) -> ApiResult<Json<PromptLog>> {
    check(&q.started_at)?;
    let log = state
        .db
        .read(move |c| {
            chats::ensure_owner(c, &user.id, &id)?;
            Ok(PromptLog {
                prompt: prompt_logs::get(c, &id, &q.started_at)?,
                previous: prompt_logs::previous(c, &id, &q.started_at)?,
            })
        })
        .await?;
    Ok(Json(log))
}
