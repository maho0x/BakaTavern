//! Chat messages. `seq` is the contiguous 0-based message index (SillyTavern's `mesId`).
//! Multi-statement functions should run inside a transaction.

use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use ts_rs::TS;

use super::chats;
use crate::error::OptionalExt;
use crate::util::{json_text, new_id, now_ms};
use crate::{Result, StoreError};

fn empty_object() -> Value {
    Value::Object(Map::new())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Swipe {
    pub content: String,
    /// SillyTavern `swipe_info[i]`, verbatim.
    #[serde(default = "empty_object")]
    #[ts(type = "Record<string, unknown>")]
    pub info: Value,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Message {
    pub id: String,
    pub chat_id: String,
    pub seq: i64,
    /// `user` | `assistant` | `system`
    pub role: String,
    pub name: String,
    /// Excluded from prompts (SillyTavern `is_system`).
    pub hidden: bool,
    pub swipe_id: i64,
    pub swipes: Vec<Swipe>,
    pub send_date: String,
    /// SillyTavern `message.extra`, verbatim.
    #[ts(type = "Record<string, unknown>")]
    pub extra: Value,
    /// Other top-level SillyTavern message fields, verbatim.
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
    pub created_at: i64,
    pub updated_at: i64,
    pub rev: i64,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct NewMessage {
    pub role: String,
    pub name: String,
    pub hidden: Option<bool>,
    pub swipe_id: Option<i64>,
    pub swipes: Vec<Swipe>,
    pub send_date: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub extra: Option<Value>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub data: Option<Value>,
    pub created_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct MessagePatch {
    pub role: Option<String>,
    pub name: Option<String>,
    pub hidden: Option<bool>,
    pub swipe_id: Option<i64>,
    pub swipes: Option<Vec<Swipe>>,
    pub send_date: Option<String>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub extra: Option<Value>,
    #[ts(optional, type = "Record<string, unknown>")]
    pub data: Option<Value>,
}

const SELECT: &str =
    "SELECT m.id, m.chat_id, m.seq, m.role, m.name, m.hidden, m.swipe_id, m.send_date, m.extra,
    m.data, m.created_at, m.updated_at, m.rev,
    (SELECT json_group_array(json_object('content', s.content, 'info', json(s.info)) ORDER BY s.idx)
       FROM swipes s WHERE s.message_id = m.id)
    FROM messages m";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Message> {
    let swipes: String = row.get(13)?;
    let swipes = serde_json::from_str(&swipes).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(13, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(Message {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        seq: row.get(2)?,
        role: row.get(3)?,
        name: row.get(4)?,
        hidden: row.get(5)?,
        swipe_id: row.get(6)?,
        send_date: row.get(7)?,
        extra: row.get(8)?,
        data: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        rev: row.get(12)?,
        swipes,
    })
}

pub fn get(conn: &Connection, id: &str) -> Result<Message> {
    conn.query_row(&format!("{SELECT} WHERE m.id = ?1"), [id], from_row)
        .or_not_found()
}

/// Chat id of a message, for ownership checks.
pub fn chat_of(conn: &Connection, id: &str) -> Result<String> {
    conn.query_row("SELECT chat_id FROM messages WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .or_not_found()
}

pub fn count(conn: &Connection, chat_id: &str) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM messages WHERE chat_id = ?1",
        [chat_id],
        |r| r.get(0),
    )?)
}

/// Up to `limit` messages with `seq < before` (or the last messages), in ascending order.
pub fn page(
    conn: &Connection,
    chat_id: &str,
    before: Option<i64>,
    limit: i64,
) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare_cached(&format!(
        "{SELECT} WHERE m.chat_id = ?1 AND m.seq < ?2 ORDER BY m.seq DESC LIMIT ?3"
    ))?;
    let mut rows: Vec<Message> = stmt
        .query_map(
            params![chat_id, before.unwrap_or(i64::MAX), limit],
            from_row,
        )?
        .collect::<rusqlite::Result<_>>()?;
    rows.reverse();
    Ok(rows)
}

/// Messages with `from <= seq < to`, ascending.
pub fn range(conn: &Connection, chat_id: &str, from: i64, to: i64) -> Result<Vec<Message>> {
    let mut stmt = conn.prepare_cached(&format!(
        "{SELECT} WHERE m.chat_id = ?1 AND m.seq >= ?2 AND m.seq < ?3 ORDER BY m.seq"
    ))?;
    let rows = stmt
        .query_map(params![chat_id, from, to], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn all(conn: &Connection, chat_id: &str) -> Result<Vec<Message>> {
    range(conn, chat_id, 0, i64::MAX)
}

fn validate_role(role: &str) -> Result<()> {
    match role {
        "user" | "assistant" | "system" => Ok(()),
        other => Err(StoreError::Invalid(format!(
            "invalid message role: {other:?}"
        ))),
    }
}

fn normalized_swipes(swipes: &[Swipe], swipe_id: i64) -> Result<(Vec<Swipe>, i64)> {
    let swipes = if swipes.is_empty() {
        vec![Swipe {
            content: String::new(),
            info: empty_object(),
        }]
    } else {
        swipes.to_vec()
    };
    if swipe_id < 0 || swipe_id >= swipes.len() as i64 {
        return Err(StoreError::Invalid(format!(
            "swipe id {swipe_id} out of range"
        )));
    }
    Ok((swipes, swipe_id))
}

fn write_swipes(conn: &Connection, message_id: &str, swipes: &[Swipe]) -> Result<()> {
    conn.execute("DELETE FROM swipes WHERE message_id = ?1", [message_id])?;
    let mut stmt = conn.prepare_cached(
        "INSERT INTO swipes (message_id, idx, content, info) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (idx, swipe) in swipes.iter().enumerate() {
        let info = if swipe.info.is_object() {
            json_text(&swipe.info)
        } else {
            "{}".into()
        };
        stmt.execute(params![message_id, idx as i64, swipe.content, info])?;
    }
    Ok(())
}

/// Inserts messages at index `at` (append when `None`), shifting later messages.
pub fn insert(
    conn: &Connection,
    chat_id: &str,
    at: Option<i64>,
    messages: &[NewMessage],
) -> Result<Vec<Message>> {
    let total = count(conn, chat_id)?;
    let pos = at.unwrap_or(total).clamp(0, total);
    let n = messages.len() as i64;
    if n == 0 {
        return Ok(Vec::new());
    }
    if pos < total {
        conn.execute(
            "UPDATE messages SET seq = seq + ?3 WHERE chat_id = ?1 AND seq >= ?2",
            params![chat_id, pos, n],
        )?;
    }
    let now = now_ms();
    let mut ids = Vec::with_capacity(messages.len());
    let mut stmt = conn.prepare_cached(
        "INSERT INTO messages (id, chat_id, seq, role, name, hidden, swipe_id, send_date, extra, data, created_at,
             updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
    )?;
    for (i, msg) in messages.iter().enumerate() {
        validate_role(&msg.role)?;
        let (swipes, swipe_id) = normalized_swipes(&msg.swipes, msg.swipe_id.unwrap_or(0))?;
        let object = |v: &Option<Value>| {
            v.as_ref()
                .filter(|v| v.is_object())
                .map(json_text)
                .unwrap_or_else(|| "{}".into())
        };
        let id = new_id();
        stmt.execute(params![
            id,
            chat_id,
            pos + i as i64,
            msg.role,
            msg.name,
            msg.hidden.unwrap_or(false),
            swipe_id,
            msg.send_date.as_deref().unwrap_or_default(),
            object(&msg.extra),
            object(&msg.data),
            msg.created_at.unwrap_or(now),
            now
        ])?;
        write_swipes(conn, &id, &swipes)?;
        ids.push(id);
    }
    chats::refresh_stats(conn, chat_id)?;
    ids.iter().map(|id| get(conn, id)).collect()
}

pub fn update(
    conn: &Connection,
    id: &str,
    patch: &MessagePatch,
    expected_rev: Option<i64>,
) -> Result<Message> {
    let current = get(conn, id)?;
    super::check_rev(current.rev, expected_rev)?;
    let role = patch.role.as_deref().unwrap_or(&current.role);
    validate_role(role)?;
    let swipes = patch.swipes.as_deref().unwrap_or(&current.swipes);
    let (swipes, swipe_id) = normalized_swipes(swipes, patch.swipe_id.unwrap_or(current.swipe_id))?;
    conn.execute(
        "UPDATE messages SET role = ?2, name = ?3, hidden = ?4, swipe_id = ?5, send_date = ?6, extra = ?7,
             data = ?8, updated_at = ?9, rev = rev + 1
         WHERE id = ?1",
        params![
            id,
            role,
            patch.name.as_deref().unwrap_or(&current.name),
            patch.hidden.unwrap_or(current.hidden),
            swipe_id,
            patch.send_date.as_deref().unwrap_or(&current.send_date),
            json_text(patch.extra.as_ref().unwrap_or(&current.extra)),
            json_text(patch.data.as_ref().unwrap_or(&current.data)),
            now_ms()
        ],
    )?;
    if patch.swipes.is_some() {
        write_swipes(conn, id, &swipes)?;
    }
    chats::refresh_stats(conn, &current.chat_id)?;
    get(conn, id)
}

/// Restores contiguous `seq` values (0..n) after deletions.
fn renumber(conn: &Connection, chat_id: &str) -> Result<()> {
    conn.execute(
        "UPDATE messages SET seq = r.rn
         FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY seq) - 1 AS rn FROM messages WHERE chat_id = ?1) AS r
         WHERE messages.id = r.id AND messages.seq != r.rn",
        [chat_id],
    )?;
    Ok(())
}

/// Deletes the given messages of a chat; returns how many were removed.
pub fn delete(conn: &Connection, chat_id: &str, ids: &[String]) -> Result<usize> {
    let mut removed = 0;
    let mut stmt = conn.prepare_cached("DELETE FROM messages WHERE chat_id = ?1 AND id = ?2")?;
    for id in ids {
        removed += stmt.execute(params![chat_id, id])?;
    }
    if removed > 0 {
        renumber(conn, chat_id)?;
        chats::refresh_stats(conn, chat_id)?;
    }
    Ok(removed)
}

/// Deletes every message with `seq >= from`.
pub fn truncate(conn: &Connection, chat_id: &str, from: i64) -> Result<usize> {
    let removed = conn.execute(
        "DELETE FROM messages WHERE chat_id = ?1 AND seq >= ?2",
        params![chat_id, from],
    )?;
    if removed > 0 {
        chats::refresh_stats(conn, chat_id)?;
    }
    Ok(removed)
}

/// Moves a message to index `to`, shifting the messages in between.
pub fn move_to(conn: &Connection, chat_id: &str, id: &str, to: i64) -> Result<()> {
    let from: i64 = conn
        .query_row(
            "SELECT seq FROM messages WHERE chat_id = ?1 AND id = ?2",
            params![chat_id, id],
            |r| r.get(0),
        )
        .or_not_found()?;
    let to = to.clamp(0, count(conn, chat_id)? - 1);
    if from == to {
        return Ok(());
    }
    if from < to {
        conn.execute(
            "UPDATE messages SET seq = seq - 1 WHERE chat_id = ?1 AND seq > ?2 AND seq <= ?3",
            params![chat_id, from, to],
        )?;
    } else {
        conn.execute(
            "UPDATE messages SET seq = seq + 1 WHERE chat_id = ?1 AND seq >= ?3 AND seq < ?2",
            params![chat_id, from, to],
        )?;
    }
    conn.execute(
        "UPDATE messages SET seq = ?2, rev = rev + 1, updated_at = ?3 WHERE id = ?1",
        params![id, to, now_ms()],
    )?;
    chats::refresh_stats(conn, chat_id)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;
    use crate::repo::{characters, chats, users};
    use serde_json::json;

    fn msg(role: &str, text: &str) -> NewMessage {
        NewMessage {
            role: role.into(),
            name: role.into(),
            hidden: None,
            swipe_id: None,
            swipes: vec![Swipe {
                content: text.into(),
                info: json!({}),
            }],
            send_date: None,
            extra: None,
            data: None,
            created_at: None,
        }
    }

    fn setup(c: &Connection) -> Result<String> {
        let user = users::ensure_default(c)?;
        let character = characters::create(
            c,
            &user.id,
            characters::NewCharacter {
                card: json!({"data": {"name": "Bot"}}),
                avatar: None,
                source_file: None,
                created_at: None,
            },
        )?;
        let chat = chats::create(
            c,
            &user.id,
            chats::NewChat {
                character_id: Some(character.summary.id),
                group_id: None,
                title: "Bot - 1".into(),
                metadata: json!({}),
                header: json!({}),
                created_at: None,
            },
        )?;
        Ok(chat.id)
    }

    fn texts(c: &Connection, chat: &str) -> Vec<String> {
        all(c, chat)
            .unwrap()
            .into_iter()
            .map(|m| m.swipes[m.swipe_id as usize].content.clone())
            .collect()
    }

    #[test]
    fn insert_update_delete_keep_seq_contiguous() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let chat = setup(c)?;
            insert(
                c,
                &chat,
                None,
                &[
                    msg("assistant", "hi"),
                    msg("user", "hello"),
                    msg("assistant", "how?"),
                ],
            )?;
            insert(c, &chat, Some(1), &[msg("system", "narration")])?;
            assert_eq!(texts(c, &chat), ["hi", "narration", "hello", "how?"]);

            let second = &all(c, &chat)?[1];
            delete(c, &chat, std::slice::from_ref(&second.id))?;
            let msgs = all(c, &chat)?;
            assert_eq!(msgs.iter().map(|m| m.seq).collect::<Vec<_>>(), [0, 1, 2]);

            let last = msgs.last().unwrap();
            let patch = MessagePatch {
                swipes: Some(vec![
                    Swipe {
                        content: "how?".into(),
                        info: json!({}),
                    },
                    Swipe {
                        content: "what?".into(),
                        info: json!({"extra": {"model": "x"}}),
                    },
                ]),
                swipe_id: Some(1),
                ..Default::default()
            };
            let updated = update(c, &last.id, &patch, Some(last.rev))?;
            assert_eq!(updated.rev, last.rev + 1);
            assert_eq!(updated.swipes[1].info["extra"]["model"], "x");
            assert!(update(c, &last.id, &patch, Some(last.rev)).is_err());

            move_to(c, &chat, &updated.id, 0)?;
            assert_eq!(texts(c, &chat), ["what?", "hi", "hello"]);

            let page_ = page(c, &chat, Some(3), 2)?;
            assert_eq!(page_.iter().map(|m| m.seq).collect::<Vec<_>>(), [1, 2]);

            truncate(c, &chat, 1)?;
            assert_eq!(texts(c, &chat), ["what?"]);
            let user = users::ensure_default(c)?;
            let stats = chats::get(c, &user.id, &chat)?;
            assert_eq!(stats.message_count, 1);
            assert_eq!(stats.preview, "what?");
            Ok(())
        })
        .unwrap();
    }
}
