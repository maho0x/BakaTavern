use axum::extract::State;
use axum::{Json, Router, routing};
use bt_store::repo::characters::{self, CharacterSummary};
use bt_store::repo::chats::{self, Chat};
use bt_store::repo::jobs::{self, JobInfo};
use bt_store::repo::lorebooks::{self, LorebookInfo};
use bt_store::repo::personas::{self, Persona};
use bt_store::repo::presets::{self, PresetInfo};
use bt_store::repo::secrets::{self, SecretInfo};
use bt_store::repo::settings::{self, SettingsDoc};
use bt_store::repo::tags::{self, Tag};
use bt_store::repo::users::{self, User};
use serde::Serialize;
use serde_json::json;
use ts_rs::TS;

use crate::auth::CurrentUser;
use crate::error::ApiResult;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/health", routing::get(health))
        .route("/api/bootstrap", routing::get(bootstrap))
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

/// Everything the app needs on startup, in one request.
#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Bootstrap {
    pub version: String,
    pub user: User,
    pub auth_required: bool,
    pub settings: Vec<SettingsDoc>,
    pub characters: Vec<CharacterSummary>,
    pub personas: Vec<Persona>,
    pub tags: Vec<Tag>,
    pub lorebooks: Vec<LorebookInfo>,
    pub presets: Vec<PresetInfo>,
    pub secrets: Vec<SecretInfo>,
    pub recent_chats: Vec<Chat>,
    pub pending_jobs: Vec<JobInfo>,
}

async fn bootstrap(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Bootstrap>> {
    let auth_required = state.config.auth_required();
    let data = state
        .db
        .read(move |c| {
            let id = &user.id;
            Ok(Bootstrap {
                version: env!("CARGO_PKG_VERSION").into(),
                user: users::get(c, id)?,
                auth_required,
                settings: settings::list(c, id)?,
                characters: characters::list(c, id)?,
                personas: personas::list(c, id)?,
                tags: tags::list(c, id)?,
                lorebooks: lorebooks::list(c, id)?,
                presets: presets::list(c, id, None)?,
                secrets: secrets::list(c, id)?,
                recent_chats: chats::list_recent(c, id, 20)?,
                pending_jobs: jobs::pending(c, id, None)?,
            })
        })
        .await?;
    Ok(Json(data))
}
