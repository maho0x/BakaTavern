use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing};
use bt_store::repo::personas::{self, Persona, PersonaInput};
use serde::Deserialize;
use ts_rs::TS;

use super::{read_multipart, single_upload, store_file};
use crate::auth::{ClientId, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::media;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/personas", routing::get(list).post(create))
        .route("/api/personas/default", routing::put(set_default))
        .route(
            "/api/personas/{id}",
            routing::get(get).put(update).delete(delete),
        )
        .route("/api/personas/{id}/avatar", routing::put(set_avatar))
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Vec<Persona>>> {
    Ok(Json(
        state.db.read(move |c| personas::list(c, &user.id)).await?,
    ))
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Persona>> {
    Ok(Json(
        state
            .db
            .read(move |c| personas::get(c, &user.id, &id))
            .await?,
    ))
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(input): Json<PersonaInput>,
) -> ApiResult<Json<Persona>> {
    let user_id = user.id.clone();
    let persona = state
        .db
        .write(move |c| personas::create(c, &user_id, &input, None, None))
        .await?;
    state.notify(
        &user.id,
        "persona",
        "created",
        &persona.id,
        Some(persona.rev),
        &origin,
    );
    Ok(Json(persona))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UpdatePersona {
    #[serde(flatten)]
    pub input: PersonaInput,
    pub rev: Option<i64>,
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<UpdatePersona>,
) -> ApiResult<Json<Persona>> {
    let user_id = user.id.clone();
    let persona = state
        .db
        .write(move |c| personas::update(c, &user_id, &id, &body.input, body.rev))
        .await?;
    state.notify(
        &user.id,
        "persona",
        "updated",
        &persona.id,
        Some(persona.rev),
        &origin,
    );
    Ok(Json(persona))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, persona_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| personas::delete(c, &user_id, &persona_id))
        .await?;
    state.notify(&user.id, "persona", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

async fn set_avatar(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    multipart: Multipart,
) -> ApiResult<Json<Persona>> {
    let (uploads, _) = read_multipart(multipart).await?;
    let upload = single_upload(uploads)?;
    if !media::is_image(media::sniff_mime(&upload.bytes)) {
        return Err(ApiError::bad_request("the avatar must be an image"));
    }
    let record = store_file(&state, upload.bytes).await?;
    let user_id = user.id.clone();
    let persona = state
        .db
        .write(move |c| personas::set_avatar(c, &user_id, &id, Some(&record.hash)))
        .await?;
    state.notify(
        &user.id,
        "persona",
        "updated",
        &persona.id,
        Some(persona.rev),
        &origin,
    );
    Ok(Json(persona))
}

#[derive(Deserialize)]
struct DefaultBody {
    id: Option<String>,
}

async fn set_default(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<DefaultBody>,
) -> ApiResult<StatusCode> {
    let user_id = user.id.clone();
    let id = body.id.clone();
    state
        .db
        .write(move |c| {
            if let Some(id) = &id {
                personas::get(c, &user_id, id)?;
            }
            personas::set_default(c, &user_id, id.as_deref())
        })
        .await?;
    state.notify(
        &user.id,
        "persona",
        "updated",
        body.id.as_deref().unwrap_or(""),
        None,
        &origin,
    );
    Ok(StatusCode::NO_CONTENT)
}
