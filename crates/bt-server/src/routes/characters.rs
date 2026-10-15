use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing};
use bt_formats::{card, charx, png};
use bt_store::repo::characters::{self, Character, CharacterSummary, NewCharacter};
use bt_store::repo::{files, tags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use super::{read_multipart, single_upload, store_file};
use crate::auth::{ClientId, CurrentUser};
use crate::convert::{attachment, sanitize_file_name};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::{media, routes};

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/characters", routing::get(list).post(create))
        .route("/api/characters/import", routing::post(import))
        .route(
            "/api/characters/{id}",
            routing::get(get).put(update).delete(delete),
        )
        .route("/api/characters/{id}/avatar", routing::put(set_avatar))
        .route("/api/characters/{id}/tags", routing::put(set_tags))
        .route("/api/characters/{id}/duplicate", routing::post(duplicate))
        .route("/api/characters/{id}/export", routing::get(export))
}

async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
) -> ApiResult<Json<Vec<CharacterSummary>>> {
    Ok(Json(
        state
            .db
            .read(move |c| characters::list(c, &user.id))
            .await?,
    ))
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Character>> {
    Ok(Json(
        state
            .db
            .read(move |c| characters::get(c, &user.id, &id))
            .await?,
    ))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct CreateCharacter {
    #[ts(type = "Record<string, unknown>")]
    pub card: Value,
    /// Blob hash of an uploaded avatar.
    pub avatar: Option<String>,
}

async fn ensure_file(state: &AppState, hash: Option<String>) -> ApiResult<Option<String>> {
    let Some(hash) = hash else { return Ok(None) };
    let lookup = hash.clone();
    match state.db.read(move |c| files::get(c, &lookup)).await? {
        Some(_) => Ok(Some(hash)),
        None => Err(ApiError::bad_request("unknown avatar file")),
    }
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<CreateCharacter>,
) -> ApiResult<Json<Character>> {
    let card = card::normalize(body.card)?;
    let avatar = ensure_file(&state, body.avatar).await?;
    let user_id = user.id.clone();
    let created = state
        .db
        .write(move |c| {
            characters::create(
                c,
                &user_id,
                NewCharacter {
                    card,
                    avatar,
                    source_file: None,
                    created_at: None,
                },
            )
        })
        .await?;
    state.notify(
        &user.id,
        "character",
        "created",
        &created.summary.id,
        Some(created.summary.rev),
        &origin,
    );
    Ok(Json(created))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UpdateCharacter {
    #[ts(type = "Record<string, unknown>")]
    pub card: Value,
    pub rev: Option<i64>,
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<UpdateCharacter>,
) -> ApiResult<Json<Character>> {
    let card = card::normalize(body.card)?;
    let user_id = user.id.clone();
    let updated = state
        .db
        .write(move |c| characters::update_card(c, &user_id, &id, &card, body.rev))
        .await?;
    state.notify(
        &user.id,
        "character",
        "updated",
        &updated.summary.id,
        Some(updated.summary.rev),
        &origin,
    );
    Ok(Json(updated))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, char_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            characters::delete(&tx, &user_id, &char_id)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    state.notify(&user.id, "character", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

async fn set_avatar(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    multipart: Multipart,
) -> ApiResult<Json<Character>> {
    let (uploads, _) = read_multipart(multipart).await?;
    let upload = single_upload(uploads)?;
    if !media::is_image(media::sniff_mime(&upload.bytes)) {
        return Err(ApiError::bad_request("the avatar must be an image"));
    }
    let record = store_file(&state, upload.bytes).await?;
    let user_id = user.id.clone();
    let updated = state
        .db
        .write(move |c| characters::set_avatar(c, &user_id, &id, Some(&record.hash)))
        .await?;
    state.notify(
        &user.id,
        "character",
        "updated",
        &updated.summary.id,
        Some(updated.summary.rev),
        &origin,
    );
    Ok(Json(updated))
}

async fn set_tags(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(tag_ids): Json<Vec<String>>,
) -> ApiResult<Json<Character>> {
    let user_id = user.id.clone();
    let updated = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            characters::get(&tx, &user_id, &id)?;
            for tag_id in &tag_ids {
                tags::get(&tx, &user_id, tag_id)?;
            }
            tags::set_entity_tags(&tx, characters::ENTITY, &id, &tag_ids)?;
            let character = characters::get(&tx, &user_id, &id)?;
            tx.commit()?;
            Ok(character)
        })
        .await?;
    state.notify(
        &user.id,
        "character",
        "updated",
        &updated.summary.id,
        Some(updated.summary.rev),
        &origin,
    );
    Ok(Json(updated))
}

async fn duplicate(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<Json<Character>> {
    let user_id = user.id.clone();
    let created = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let source = characters::get(&tx, &user_id, &id)?;
            let mut card = source.card.clone();
            if let Some(name) = card
                .pointer("/data/name")
                .and_then(Value::as_str)
                .map(str::to_string)
            {
                card["data"]["name"] = Value::String(format!("{name} (copy)"));
            }
            let created = characters::create(
                &tx,
                &user_id,
                NewCharacter {
                    card,
                    avatar: source.summary.avatar.clone(),
                    source_file: None,
                    created_at: None,
                },
            )?;
            tags::set_entity_tags(
                &tx,
                characters::ENTITY,
                &created.summary.id,
                &source.summary.tags,
            )?;
            let created = characters::get(&tx, &user_id, &created.summary.id)?;
            tx.commit()?;
            Ok(created)
        })
        .await?;
    state.notify(
        &user.id,
        "character",
        "created",
        &created.summary.id,
        Some(created.summary.rev),
        &origin,
    );
    Ok(Json(created))
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImportFailure {
    pub file_name: String,
    pub message: String,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CharacterImportResult {
    pub characters: Vec<Character>,
    pub failures: Vec<ImportFailure>,
}

/// Parses an uploaded card file into `(raw card JSON, avatar bytes)`.
fn parse_card_file(bytes: &[u8]) -> Result<(Value, Option<Vec<u8>>), ApiError> {
    if png::is_png(bytes) {
        return Ok((card::read_png(bytes)?, Some(bytes.to_vec())));
    }
    if charx::is_zip(bytes) {
        let archive = charx::read(bytes)?;
        return Ok((archive.card, archive.avatar));
    }
    match bytes.iter().find(|b| !b.is_ascii_whitespace()) {
        Some(b'{') => Ok((
            serde_json::from_slice(bytes).map_err(|e| ApiError::bad_request(e.to_string()))?,
            None,
        )),
        _ => Err(ApiError::bad_request(
            "unsupported file: expected a PNG card, a JSON card or a CHARX archive",
        )),
    }
}

async fn import_one(
    state: &AppState,
    user_id: &str,
    file_name: &str,
    bytes: Vec<u8>,
) -> ApiResult<Character> {
    let (raw, avatar_bytes) = parse_card_file(&bytes)?;
    let created_at = raw
        .get("create_date")
        .and_then(Value::as_str)
        .and_then(bt_formats::date::parse_st_date);
    let card = card::normalize(raw)?;
    let avatar = match avatar_bytes.filter(|b| media::is_image(media::sniff_mime(b))) {
        Some(bytes) => Some(store_file(state, bytes).await?.hash),
        None => None,
    };
    let user_id = user_id.to_string();
    let source_file = Some(file_name.to_string());
    let character = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let created = characters::create(
                &tx,
                &user_id,
                NewCharacter {
                    card,
                    avatar,
                    source_file,
                    created_at,
                },
            )?;
            // Card tags become library tags, as SillyTavern does on import.
            let card_tags: Vec<String> = created
                .card
                .pointer("/data/tags")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|t| !t.is_empty())
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let mut tag_ids = Vec::new();
            for name in card_tags.iter().take(50) {
                tag_ids.push(tags::ensure(&tx, &user_id, name)?.id);
            }
            tags::set_entity_tags(&tx, characters::ENTITY, &created.summary.id, &tag_ids)?;
            let created = characters::get(&tx, &user_id, &created.summary.id)?;
            tx.commit()?;
            Ok(created)
        })
        .await?;
    Ok(character)
}

async fn import(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    multipart: Multipart,
) -> ApiResult<Json<CharacterImportResult>> {
    let (uploads, _) = routes::read_multipart(multipart).await?;
    if uploads.is_empty() {
        return Err(ApiError::bad_request("no file was uploaded"));
    }
    let mut result = CharacterImportResult {
        characters: Vec::new(),
        failures: Vec::new(),
    };
    for upload in uploads {
        match import_one(&state, &user.id, &upload.file_name, upload.bytes).await {
            Ok(character) => {
                state.notify(
                    &user.id,
                    "character",
                    "created",
                    &character.summary.id,
                    Some(character.summary.rev),
                    &origin,
                );
                result.characters.push(character);
            }
            Err(e) => result.failures.push(ImportFailure {
                file_name: upload.file_name,
                message: e.message,
            }),
        }
    }
    Ok(Json(result))
}

#[derive(Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

async fn export(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<ExportQuery>,
) -> ApiResult<Response> {
    let character = state
        .db
        .read(move |c| characters::get(c, &user.id, &id))
        .await?;
    let base = sanitize_file_name(&character.summary.name);
    match query.format.as_deref().unwrap_or("png") {
        "json" => {
            let body = serde_json::to_vec_pretty(&card::to_st_json(&character.card))
                .map_err(ApiError::internal)?;
            let mut response = body.into_response();
            let headers = response.headers_mut();
            headers.insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/json"),
            );
            headers.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&attachment(&format!("{base}.json")))
                    .map_err(ApiError::internal)?,
            );
            Ok(response)
        }
        "png" => {
            let blobs = state.blobs.clone();
            let avatar = character.summary.avatar.clone();
            let card_json = character.card.clone();
            let image = tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<u8>> {
                let source = match avatar {
                    Some(hash) => media::to_png(&blobs.read(&hash)?)?,
                    None => png::placeholder(),
                };
                Ok(card::write_png(&source, &card_json)?)
            })
            .await
            .map_err(ApiError::internal)?
            .map_err(ApiError::internal)?;
            let mut response = image.into_response();
            let headers = response.headers_mut();
            headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
            headers.insert(
                header::CONTENT_DISPOSITION,
                HeaderValue::from_str(&attachment(&format!("{base}.png")))
                    .map_err(ApiError::internal)?,
            );
            Ok(response)
        }
        other => Err(ApiError::bad_request(format!(
            "unknown export format {other:?}"
        ))),
    }
}
