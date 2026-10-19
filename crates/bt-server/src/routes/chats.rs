use axum::extract::{Multipart, Path, Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing};
use bt_formats::chat;
use bt_store::repo::chats::{self, Chat, NewChat};
use bt_store::repo::messages::{self, Message, MessagePatch, NewMessage};
use bt_store::repo::search::{self, SearchHit, SearchScope};
use bt_store::repo::{characters, groups};
use bt_store::util::now_ms;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;
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
        .route("/api/search", routing::get(search))
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    q: String,
    character_id: Option<String>,
    group_id: Option<String>,
    limit: Option<usize>,
}

/// Messages of the user's chats containing the text, newest first.
async fn search(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<SearchHit>>> {
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let scope = SearchScope {
        character_id: q.character_id,
        group_id: q.group_id,
    };
    Ok(Json(
        state
            .db
            .read(move |c| search::messages(c, &user.id, &q.q, &scope, limit))
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
    /// A group chat instead of a character's.
    pub group_id: Option<String>,
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
                    group_id: body.group_id,
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
    /// Name of the new chat; SillyTavern's `<chat> - Branch #n` / `<chat> - Checkpoint #n` when
    /// missing. A name another chat of the character has is refused (409 `exists`).
    pub title: Option<String>,
    /// The swipe the copied last message shows.
    pub swipe_id: Option<i64>,
    /// A checkpoint: the message links to the new chat (`extra.bookmark_link`); a branch is
    /// listed in the message's `extra.branches` instead.
    pub checkpoint: Option<bool>,
}

#[derive(Serialize, TS)]
#[ts(export)]
pub struct Branched {
    pub chat: Chat,
    /// The message the chat was branched at, with its link to the new chat.
    pub message: Message,
}

/// SillyTavern's name for a branch or checkpoint of `main`: its own suffix replaced by the
/// first free `- Branch #n` / `- Checkpoint #n`.
fn branch_title(main: &str, token: &str, taken: impl Fn(&str) -> bool) -> Option<String> {
    let mut clean = main.to_string();
    if let Some(i) = clean.rfind(&format!(" - {token}"))
        && clean[i + token.len() + 3..]
            .chars()
            .all(|c| c.is_ascii_digit())
        && clean.len() > i + token.len() + 3
    {
        clean.truncate(i);
    }
    if let Some(rest) = clean.strip_prefix(token)
        && let Some((digits, rest)) = rest.split_once(" - ")
        && !digits.is_empty()
        && digits.chars().all(|c| c.is_ascii_digit())
    {
        clean = rest.to_string();
    }
    (1..10_000)
        .map(|n| format!("{clean} - {token}{n}"))
        .find(|t| !taken(t))
}

/// Copies the chat up to a message into a new chat (SillyTavern's branches and checkpoints).
async fn branch(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
    Json(body): Json<BranchChat>,
) -> ApiResult<Json<Branched>> {
    let user_id = user.id.clone();
    let checkpoint = body.checkpoint.unwrap_or(false);
    let branched = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let source = chats::get(&tx, &user_id, &id)?;
            let originals = messages::range(&tx, &id, 0, body.up_to + 1)?;
            let Some(at) = originals.last().filter(|m| m.seq == body.up_to).cloned() else {
                return Err(bt_store::StoreError::NotFound);
            };
            let mut copied: Vec<NewMessage> = originals
                .into_iter()
                .map(|m| NewMessage {
                    role: m.role,
                    name: m.name,
                    character_id: m.character_id,
                    hidden: Some(m.hidden),
                    swipe_id: Some(m.swipe_id),
                    swipes: m.swipes,
                    send_date: Some(m.send_date),
                    extra: Some(m.extra),
                    data: Some(m.data),
                    created_at: Some(m.created_at),
                })
                .collect();
            if let (Some(swipe_id), Some(last)) = (body.swipe_id, copied.last_mut()) {
                if swipe_id < 0 || swipe_id as usize >= last.swipes.len() {
                    return Err(bt_store::StoreError::Invalid("no such swipe".into()));
                }
                last.swipe_id = Some(swipe_id);
            }
            let titles: Vec<String> = chats::siblings(&tx, &user_id, &source)?
                .into_iter()
                .map(|c| c.title)
                .collect();
            let title = match body
                .title
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
            {
                Some(title) if titles.contains(&title) => {
                    return Err(bt_store::StoreError::Exists(format!(
                        "a chat named \"{title}\" already exists"
                    )));
                }
                Some(title) => title,
                None => branch_title(
                    &source.title,
                    if checkpoint {
                        "Checkpoint #"
                    } else {
                        "Branch #"
                    },
                    |t| titles.iter().any(|x| x == t),
                )
                .ok_or_else(|| bt_store::StoreError::Invalid("no free chat name".into()))?,
            };
            let mut metadata = source.metadata.clone();
            if let Some(map) = metadata.as_object_mut() {
                map.insert("main_chat".into(), json!(source.title));
                // A branch is a different file for SillyTavern's integrity check.
                map.remove("integrity");
            }
            let chat = chats::create(
                &tx,
                &user_id,
                NewChat {
                    character_id: source.character_id.clone(),
                    group_id: source.group_id.clone(),
                    title: title.clone(),
                    metadata,
                    header: new_header(),
                    created_at: None,
                },
            )?;
            messages::insert(&tx, &chat.id, None, &copied)?;
            let chat = chats::get(&tx, &user_id, &chat.id)?;

            // The message links to its checkpoint, or lists its branches.
            let mut extra = match at.extra {
                Value::Object(map) => map,
                _ => Map::new(),
            };
            if checkpoint {
                extra.insert("bookmark_link".into(), json!(title));
            } else {
                match extra.get_mut("branches") {
                    Some(Value::Array(list)) => list.push(json!(title)),
                    _ => {
                        extra.insert("branches".into(), json!([title]));
                    }
                }
            }
            let message = messages::update(
                &tx,
                &at.id,
                &MessagePatch {
                    extra: Some(Value::Object(extra)),
                    ..Default::default()
                },
                None,
            )?;
            tx.commit()?;
            Ok(Branched { chat, message })
        })
        .await?;
    state.notify(
        &user.id,
        "chat",
        "created",
        &branched.chat.id,
        Some(branched.chat.rev),
        &origin,
    );
    state.notify_message(
        &user.id,
        &branched.message.chat_id,
        "updated",
        &branched.message.id,
        Some(branched.message.rev),
        &origin,
    );
    Ok(Json(branched))
}

async fn import(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    multipart: Multipart,
) -> ApiResult<Json<Chat>> {
    let (uploads, fields) = read_multipart(multipart).await?;
    let owner = ChatOwner {
        character_id: field(&fields, "characterId").map(str::to_string),
        group_id: field(&fields, "groupId").map(str::to_string),
    };
    let upload = single_upload(uploads)?;
    let text = String::from_utf8(upload.bytes)
        .map_err(|_| ApiError::bad_request("the chat file is not UTF-8 text"))?;
    let title = upload.file_name.trim_end_matches(".jsonl").to_string();
    let chat = import_jsonl(&state, &user.id, owner, title, &text).await?;
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

/// Whose chat an imported file becomes: a character's or a group's.
#[derive(Debug, Clone, Default)]
pub(crate) struct ChatOwner {
    pub character_id: Option<String>,
    pub group_id: Option<String>,
}

/// Imports a SillyTavern JSONL chat for a character or group.
pub(crate) async fn import_jsonl(
    state: &AppState,
    user_id: &str,
    owner: ChatOwner,
    title: String,
    text: &str,
) -> ApiResult<Chat> {
    import_parsed(state, user_id, owner, title, chat::parse_jsonl(text)?).await
}

/// The member who wrote each message of a group chat: by SillyTavern avatar file
/// (`original_avatar`), else by name.
fn group_speakers(
    conn: &bt_store::rusqlite::Connection,
    user_id: &str,
    group_id: &str,
) -> bt_store::Result<(HashMap<String, String>, HashMap<String, String>)> {
    let mut by_avatar = HashMap::new();
    let mut by_name = HashMap::new();
    for member in groups::get(conn, user_id, group_id)?.members {
        let character = characters::get(conn, user_id, &member.character_id)?.summary;
        if let Some(file) = character.source_file {
            by_avatar.insert(file, character.id.clone());
        }
        by_name.entry(character.name).or_insert(character.id);
    }
    Ok((by_avatar, by_name))
}

/// Stores a parsed SillyTavern chat as a new chat.
pub(crate) async fn import_parsed(
    state: &AppState,
    user_id: &str,
    owner: ChatOwner,
    title: String,
    parsed: chat::StChat,
) -> ApiResult<Chat> {
    let created_at = parsed
        .header
        .get("create_date")
        .and_then(Value::as_str)
        .and_then(bt_formats::date::parse_st_date);
    let user_id = user_id.to_string();
    let chat = state
        .db
        .write(move |c| {
            let tx = c.transaction()?;
            let speakers = match &owner.group_id {
                Some(group_id) => Some(group_speakers(&tx, &user_id, group_id)?),
                None => None,
            };
            let chat = chats::create(
                &tx,
                &user_id,
                NewChat {
                    character_id: owner.character_id,
                    group_id: owner.group_id,
                    title,
                    metadata: parsed.metadata,
                    header: Value::Object(parsed.header),
                    created_at,
                },
            )?;
            let new_messages: Vec<NewMessage> = parsed
                .messages
                .into_iter()
                .map(|m| {
                    let speaker = speakers.as_ref().filter(|_| m.role != "user").and_then(
                        |(by_avatar, by_name)| {
                            m.data
                                .get("original_avatar")
                                .and_then(Value::as_str)
                                .and_then(|avatar| by_avatar.get(avatar))
                                .or_else(|| by_name.get(&m.name))
                                .cloned()
                        },
                    );
                    NewMessage {
                        character_id: speaker,
                        ..st_to_new_message(m)
                    }
                })
                .collect();
            messages::insert(&tx, &chat.id, None, &new_messages)?;
            let chat = chats::get(&tx, &user_id, &chat.id)?;
            tx.commit()?;
            Ok(chat)
        })
        .await?;
    Ok(chat)
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
    let user_id = user.id.clone();
    let (chat, rows) = state
        .db
        .read(move |c| {
            let chat = chats::get(c, &user.id, &id)?;
            let rows = messages::all(c, &id)?;
            Ok((chat, rows))
        })
        .await?;
    // Group chats name the member who wrote each message.
    let st_messages: Vec<_> = if chat.group_id.is_some() {
        let names = crate::st_export::names(&state, &user_id).await?;
        crate::st_export::st_messages(&rows, &names)
    } else {
        rows.iter().map(message_to_st).collect()
    };
    let header_map = if chat.group_id.is_some() {
        Map::new()
    } else {
        chat.header.as_object().cloned().unwrap_or_else(Map::new)
    };
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

#[cfg(test)]
mod tests {
    use super::branch_title;

    #[test]
    fn branch_titles_follow_sillytavern() {
        let none = |_: &str| false;
        assert_eq!(
            branch_title("Aiko - 2026", "Branch #", none).unwrap(),
            "Aiko - 2026 - Branch #1"
        );
        // A branch of a branch: the suffix is replaced, not stacked.
        let taken = |t: &str| t == "Aiko - Branch #1";
        assert_eq!(
            branch_title("Aiko - Branch #1", "Branch #", taken).unwrap(),
            "Aiko - Branch #2"
        );
        // The old "Branch #n - name" style loses its prefix.
        assert_eq!(
            branch_title("Checkpoint #4 - Aiko", "Checkpoint #", none).unwrap(),
            "Aiko - Checkpoint #1"
        );
        assert_eq!(
            branch_title("Aiko - Branch #x", "Branch #", none).unwrap(),
            "Aiko - Branch #x - Branch #1"
        );
    }
}
