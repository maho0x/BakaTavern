use axum::extract::{Multipart, Path, State};
use axum::http::StatusCode;
use axum::{Json, Router, routing};
use bt_store::repo::chats::{self, Chat};
use bt_store::repo::groups::{self, Group, GroupMember, GroupPatch, NewGroup};
use bt_store::repo::tags;
use serde::Deserialize;
use serde_json::{Value, json};
use ts_rs::TS;

use super::{read_multipart, single_upload, store_file};
use crate::auth::{ClientId, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::media;
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/groups", routing::get(list).post(create))
        .route(
            "/api/groups/{id}",
            routing::get(get).patch(update).delete(delete),
        )
        .route(
            "/api/groups/{id}/avatar",
            routing::put(set_avatar).delete(clear_avatar),
        )
        .route("/api/groups/{id}/tags", routing::put(set_tags))
        .route("/api/groups/{id}/chats", routing::get(list_chats))
}

async fn list(State(state): State<AppState>, user: CurrentUser) -> ApiResult<Json<Vec<Group>>> {
    Ok(Json(
        state.db.read(move |c| groups::list(c, &user.id)).await?,
    ))
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Group>> {
    Ok(Json(
        state
            .db
            .read(move |c| groups::get(c, &user.id, &id))
            .await?,
    ))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct CreateGroup {
    pub name: String,
    pub members: Vec<GroupMember>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub settings: Option<Value>,
    pub fav: Option<bool>,
    pub tags: Option<Vec<String>>,
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<CreateGroup>,
) -> ApiResult<Json<Group>> {
    let user_id = user.id.clone();
    let group = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let group = groups::create(
                &tx,
                &user_id,
                NewGroup {
                    name: body.name,
                    avatar: None,
                    fav: body.fav.unwrap_or(false),
                    members: body.members,
                    settings: body.settings.unwrap_or_else(|| json!({})),
                    source_id: None,
                    created_at: None,
                },
            )?;
            if let Some(tag_ids) = &body.tags {
                tags::set_entity_tags(&tx, groups::ENTITY, &group.id, tag_ids)?;
            }
            let group = groups::get(&tx, &user_id, &group.id)?;
            tx.commit()?;
            Ok(group)
        })
        .await?;
    state.notify(
        &user.id,
        "group",
        "created",
        &group.id,
        Some(group.rev),
        &origin,
    );
    Ok(Json(group))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UpdateGroup {
    #[serde(flatten)]
    pub patch: GroupPatch,
    pub rev: Option<i64>,
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<UpdateGroup>,
) -> ApiResult<Json<Group>> {
    if body.patch.settings.as_ref().is_some_and(|s| !s.is_object()) {
        return Err(ApiError::bad_request("settings must be an object"));
    }
    let user_id = user.id.clone();
    let group = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let group = groups::update(&tx, &user_id, &id, &body.patch, body.rev)?;
            tx.commit()?;
            Ok(group)
        })
        .await?;
    state.notify(
        &user.id,
        "group",
        "updated",
        &group.id,
        Some(group.rev),
        &origin,
    );
    Ok(Json(group))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, group_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            groups::delete(&tx, &user_id, &group_id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    state.notify(&user.id, "group", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

async fn set_avatar(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    multipart: Multipart,
) -> ApiResult<Json<Group>> {
    let (uploads, _) = read_multipart(multipart).await?;
    let upload = single_upload(uploads)?;
    if !media::is_image(media::sniff_mime(&upload.bytes)) {
        return Err(ApiError::bad_request("the avatar must be an image"));
    }
    let record = store_file(&state, upload.bytes).await?;
    let user_id = user.id.clone();
    let group = state
        .db
        .write(move |c| groups::set_avatar(c, &user_id, &id, Some(&record.hash)))
        .await?;
    state.notify(
        &user.id,
        "group",
        "updated",
        &group.id,
        Some(group.rev),
        &origin,
    );
    Ok(Json(group))
}

/// Back to the members' avatars.
async fn clear_avatar(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<Json<Group>> {
    let user_id = user.id.clone();
    let group = state
        .db
        .write(move |c| groups::set_avatar(c, &user_id, &id, None))
        .await?;
    state.notify(
        &user.id,
        "group",
        "updated",
        &group.id,
        Some(group.rev),
        &origin,
    );
    Ok(Json(group))
}

async fn set_tags(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(tag_ids): Json<Vec<String>>,
) -> ApiResult<Json<Group>> {
    let user_id = user.id.clone();
    let group = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            groups::ensure_owner(&tx, &user_id, &id)?;
            let owned: Vec<String> = tags::list(&tx, &user_id)?
                .into_iter()
                .map(|t| t.id)
                .filter(|t| tag_ids.contains(t))
                .collect();
            tags::set_entity_tags(&tx, groups::ENTITY, &id, &owned)?;
            let group = groups::get(&tx, &user_id, &id)?;
            tx.commit()?;
            Ok(group)
        })
        .await?;
    state.notify(
        &user.id,
        "group",
        "updated",
        &group.id,
        Some(group.rev),
        &origin,
    );
    Ok(Json(group))
}

async fn list_chats(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Chat>>> {
    Ok(Json(
        state
            .db
            .read(move |c| {
                groups::ensure_owner(c, &user.id, &id)?;
                chats::list_for_group(c, &user.id, &id)
            })
            .await?,
    ))
}
