use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing};
use bt_formats::chat;
use bt_store::repo::chats::{self, Chat, NewChat};
use bt_store::repo::messages::{self, Message, MessagePatch, NewMessage};
use bt_store::util::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use ts_rs::TS;

use super::{field, read_multipart, single_upload};
use crate::auth::{ClientId, CurrentUser};
use crate::convert::{attachment, message_to_st, sanitize_file_name, st_to_new_message};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/characters/{id}/chats",
            routing::get(list_for_character),
        )
        .route("/api/chats", routing::post(create))
        .route("/api/chats/recent", routing::get(recent))
        .route("/api/chats/import", routing::post(import))
        .route(
            "/api/chats/{id}",
            routing::get(get).patch(update).delete(delete),
        )
        .route("/api/chats/{id}/branch", routing::post(branch))
        .route("/api/chats/{id}/export", routing::get(export))
        .route(
            "/api/chats/{id}/messages",
            routing::get(list_messages)
                .post(add_messages)
                .delete(delete_messages),
        )
        .route(
            "/api/chats/{id}/messages/{message}/move",
            routing::post(move_message),
        )
        .route(
            "/api/messages/{id}",
            routing::get(get_message).patch(update_message),
        )
}

async fn list_for_character(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Chat>>> {
    Ok(Json(
        state
            .db
            .read(move |c| chats::list_for_character(c, &user.id, &id))
            .await?,
    ))
}

#[derive(Deserialize)]
struct RecentQuery {
    limit: Option<i64>,
}

async fn recent(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<RecentQuery>,
) -> ApiResult<Json<Vec<Chat>>> {
    let limit = q.limit.unwrap_or(20).clamp(1, 200);
    Ok(Json(
        state
            .db
            .read(move |c| chats::list_recent(c, &user.id, limit))
            .await?,
    ))
}

async fn get(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Chat>> {
    Ok(Json(
        state.db.read(move |c| chats::get(c, &user.id, &id)).await?,
    ))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct CreateChat {
    pub character_id: Option<String>,
    pub title: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub metadata: Option<Value>,
    /// Initial messages (greetings).
    pub messages: Option<Vec<NewMessage>>,
}

#[derive(Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChatWithMessages {
    pub chat: Chat,
    pub messages: Vec<Message>,
}

fn new_header() -> Value {
    json!({ "user_name": "unused", "character_name": "unused", "create_date": bt_formats::date::to_iso(now_ms()) })
}

async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(body): Json<CreateChat>,
) -> ApiResult<Json<ChatWithMessages>> {
    let user_id = user.id.clone();
    let created = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let title = match body
                .title
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
            {
                Some(title) => title,
                None => format!("Chat - {}", bt_formats::date::to_iso(now_ms())),
            };
            let chat = chats::create(
                &tx,
                &user_id,
                NewChat {
                    character_id: body.character_id,
                    group_id: None,
                    title,
                    metadata: body
                        .metadata
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({})),
                    header: new_header(),
                    created_at: None,
                },
            )?;
            let messages = messages::insert(
                &tx,
                &chat.id,
                None,
                body.messages.as_deref().unwrap_or_default(),
            )?;
            let chat = chats::get(&tx, &user_id, &chat.id)?;
            tx.commit()?;
            Ok(ChatWithMessages { chat, messages })
        })
        .await?;
    state.notify(
        &user.id,
        "chat",
        "created",
        &created.chat.id,
        Some(created.chat.rev),
        &origin,
    );
    Ok(Json(created))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UpdateChat {
    pub title: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub metadata: Option<Value>,
    pub rev: Option<i64>,
}

async fn update(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<UpdateChat>,
) -> ApiResult<Json<Chat>> {
    if body.metadata.as_ref().is_some_and(|m| !m.is_object()) {
        return Err(ApiError::bad_request("metadata must be an object"));
    }
    let user_id = user.id.clone();
    let chat = state
        .db
        .write(move |c| {
            chats::update(
                c,
                &user_id,
                &id,
                body.title.as_deref(),
                body.metadata.as_ref(),
                body.rev,
            )
        })
        .await?;
    state.notify(
        &user.id,
        "chat",
        "updated",
        &chat.id,
        Some(chat.rev),
        &origin,
    );
    Ok(Json(chat))
}

async fn delete(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, chat_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| chats::delete(c, &user_id, &chat_id))
        .await?;
    state.notify(&user.id, "chat", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct MessagesQuery {
    before: Option<i64>,
    limit: Option<i64>,
    from: Option<i64>,
    to: Option<i64>,
}

/// `GET /api/chats/{id}/messages`: `?before=&limit=` pages backwards from the end; `?from=&to=`
/// returns an index range; no parameters returns everything.
async fn list_messages(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<MessagesQuery>,
) -> ApiResult<Json<Vec<Message>>> {
    let rows = state
        .db
        .read(move |c| {
            chats::ensure_owner(c, &user.id, &id)?;
            match (q.from, q.to, q.limit) {
                (Some(from), to, _) => messages::range(c, &id, from, to.unwrap_or(i64::MAX)),
                (None, _, Some(limit)) => messages::page(c, &id, q.before, limit.clamp(1, 5000)),
                (None, _, None) if q.before.is_some() => messages::page(c, &id, q.before, 100),
                _ => messages::all(c, &id),
            }
        })
        .await?;
    Ok(Json(rows))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct AddMessages {
    /// Insert position (message index); appended when absent.
    pub at: Option<i64>,
    pub messages: Vec<NewMessage>,
}

async fn add_messages(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<AddMessages>,
) -> ApiResult<Json<Vec<Message>>> {
    let (user_id, chat_id) = (user.id.clone(), id.clone());
    let added = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            chats::ensure_owner(&tx, &user_id, &chat_id)?;
            let added = messages::insert(&tx, &chat_id, body.at, &body.messages)?;
            tx.commit()?;
            Ok(added)
        })
        .await?;
    for message in &added {
        state.notify_message(
            &user.id,
            &id,
            "created",
            &message.id,
            Some(message.rev),
            &origin,
        );
    }
    Ok(Json(added))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct DeleteMessages {
    /// Messages to delete.
    pub ids: Option<Vec<String>>,
    /// Delete every message from this index to the end.
    pub from: Option<i64>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Removed {
    pub removed: usize,
}

async fn delete_messages(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<DeleteMessages>,
) -> ApiResult<Json<Removed>> {
    let (user_id, chat_id) = (user.id.clone(), id.clone());
    let removed = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            chats::ensure_owner(&tx, &user_id, &chat_id)?;
            let mut removed =
                messages::delete(&tx, &chat_id, body.ids.as_deref().unwrap_or_default())?;
            if let Some(from) = body.from {
                removed += messages::truncate(&tx, &chat_id, from)?;
            }
            tx.commit()?;
            Ok(removed)
        })
        .await?;
    state.notify(&user.id, "chat", "updated", &id, None, &origin);
    Ok(Json(Removed { removed }))
}

#[derive(Deserialize)]
struct MoveBody {
    to: i64,
}

async fn move_message(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path((id, message)): Path<(String, String)>,
    Json(body): Json<MoveBody>,
) -> ApiResult<StatusCode> {
    let (user_id, chat_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            chats::ensure_owner(&tx, &user_id, &chat_id)?;
            messages::move_to(&tx, &chat_id, &message, body.to)?;
            tx.commit()?;
            Ok(())
        })
        .await?;
    state.notify(&user.id, "chat", "updated", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

async fn owned_chat_of(state: &AppState, user_id: &str, message_id: &str) -> ApiResult<String> {
    let (user_id, message_id) = (user_id.to_string(), message_id.to_string());
    Ok(state
        .db
        .read(move |c| {
            let chat_id = messages::chat_of(c, &message_id)?;
            chats::ensure_owner(c, &user_id, &chat_id)?;
            Ok(chat_id)
        })
        .await?)
}

async fn get_message(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<Message>> {
    owned_chat_of(&state, &user.id, &id).await?;
    Ok(Json(state.db.read(move |c| messages::get(c, &id)).await?))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct UpdateMessage {
    #[serde(flatten)]
    pub patch: MessagePatch,
    pub rev: Option<i64>,
}

async fn update_message(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<UpdateMessage>,
) -> ApiResult<Json<Message>> {
    let chat_id = owned_chat_of(&state, &user.id, &id).await?;
    let updated = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let updated = messages::update(&tx, &id, &body.patch, body.rev)?;
            tx.commit()?;
            Ok(updated)
        })
        .await?;
    state.notify_message(
        &user.id,
        &chat_id,
        "updated",
        &updated.id,
        Some(updated.rev),
        &origin,
    );
    Ok(Json(updated))
}

#[derive(Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct BranchChat {
    /// Index of the last message to copy.
    pub up_to: i64,
    pub title: Option<String>,
}

/// Copies the chat up to a message into a new chat (SillyTavern "branch").
async fn branch(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<BranchChat>,
) -> ApiResult<Json<Chat>> {
    let user_id = user.id.clone();
    let chat = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let source = chats::get(&tx, &user_id, &id)?;
            let copied: Vec<NewMessage> = messages::range(&tx, &id, 0, body.up_to + 1)?
                .into_iter()
                .map(|m| NewMessage {
                    role: m.role,
                    name: m.name,
                    hidden: Some(m.hidden),
                    swipe_id: Some(m.swipe_id),
                    swipes: m.swipes,
                    send_date: Some(m.send_date),
                    extra: Some(m.extra),
                    data: Some(m.data),
                    created_at: Some(m.created_at),
                })
                .collect();
            let mut metadata = source.metadata.clone();
            if let Some(map) = metadata.as_object_mut() {
                map.insert("main_chat".into(), json!(source.title));
                // A branch is a different file for SillyTavern's integrity check.
                map.remove("integrity");
            }
            let title = body
                .title
                .filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "Branch #{} - {}",
                        body.up_to,
                        bt_formats::date::to_iso(now_ms())
                    )
                });
            let chat = chats::create(
                &tx,
                &user_id,
                NewChat {
                    character_id: source.character_id.clone(),
                    group_id: source.group_id.clone(),
                    title,
                    metadata,
                    header: new_header(),
                    created_at: None,
                },
            )?;
            messages::insert(&tx, &chat.id, None, &copied)?;
            let chat = chats::get(&tx, &user_id, &chat.id)?;
            tx.commit()?;
            Ok(chat)
        })
        .await?;
    state.notify(
        &user.id,
        "chat",
        "created",
        &chat.id,
        Some(chat.rev),
        &origin,
    );
    Ok(Json(chat))
}

async fn import(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    multipart: Multipart,
) -> ApiResult<Json<Chat>> {
    let (uploads, fields) = read_multipart(multipart).await?;
    let character_id = field(&fields, "characterId").map(str::to_string);
    let upload = single_upload(uploads)?;
    let text = String::from_utf8(upload.bytes)
        .map_err(|_| ApiError::bad_request("the chat file is not UTF-8 text"))?;
    let parsed = chat::parse_jsonl(&text)?;
    let title = upload.file_name.trim_end_matches(".jsonl").to_string();
    let created_at = parsed
        .header
        .get("create_date")
        .and_then(Value::as_str)
        .and_then(bt_formats::date::parse_st_date);
    let user_id = user.id.clone();
    let chat = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let chat = chats::create(
                &tx,
                &user_id,
                NewChat {
                    character_id,
                    group_id: None,
                    title,
                    metadata: parsed.metadata,
                    header: Value::Object(parsed.header),
                    created_at,
                },
            )?;
            let new_messages: Vec<NewMessage> =
                parsed.messages.into_iter().map(st_to_new_message).collect();
            messages::insert(&tx, &chat.id, None, &new_messages)?;
            let chat = chats::get(&tx, &user_id, &chat.id)?;
            tx.commit()?;
            Ok(chat)
        })
        .await?;
    state.notify(
        &user.id,
        "chat",
        "created",
        &chat.id,
        Some(chat.rev),
        &origin,
    );
    Ok(Json(chat))
}

#[derive(Deserialize)]
struct ExportQuery {
    format: Option<String>,
}

async fn export(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<ExportQuery>,
) -> ApiResult<Response> {
    let (chat, rows) = state
        .db
        .read(move |c| {
            let chat = chats::get(c, &user.id, &id)?;
            let rows = messages::all(c, &id)?;
            Ok((chat, rows))
        })
        .await?;
    let st_messages: Vec<_> = rows.iter().map(message_to_st).collect();
    let header_map = chat.header.as_object().cloned().unwrap_or_else(Map::new);
    let (body, mime, ext) = match q.format.as_deref().unwrap_or("jsonl") {
        "jsonl" => (
            chat::to_jsonl(&header_map, &chat.metadata, &st_messages),
            "application/x-ndjson",
            "jsonl",
        ),
        "txt" => (
            chat::to_txt(&st_messages),
            "text/plain; charset=utf-8",
            "txt",
        ),
        other => {
            return Err(ApiError::bad_request(format!(
                "unknown export format {other:?}"
            )));
        }
    };
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    let name = format!("{}.{ext}", sanitize_file_name(&chat.title));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&attachment(&name)).map_err(ApiError::internal)?,
    );
    Ok(response)
}
