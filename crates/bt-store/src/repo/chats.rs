use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::characters;
use crate::error::OptionalExt;
use crate::util::{json_text, new_id, now_ms};
use crate::{Result, StoreError};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Chat {
    pub id: String,
    pub character_id: Option<String>,
    pub group_id: Option<String>,
    /// SillyTavern chat file name (without `.jsonl`).
    pub title: String,
    /// SillyTavern `chat_metadata`, verbatim.
    #[ts(type = "Record<string, unknown>")]
    pub metadata: Value,
    /// Other JSONL header fields (`user_name`, `character_name`, `create_date`, ...).
    #[ts(type = "Record<string, unknown>")]
    pub header: Value,
    pub message_count: i64,
    pub last_message_at: Option<i64>,
    pub preview: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub rev: i64,
}

const COLUMNS: &str =
    "id, character_id, group_id, title, metadata, header, message_count, last_message_at,
    preview, created_at, updated_at, rev";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Chat> {
    Ok(Chat {
        id: row.get(0)?,
        character_id: row.get(1)?,
        group_id: row.get(2)?,
        title: row.get(3)?,
        metadata: row.get(4)?,
        header: row.get(5)?,
        message_count: row.get(6)?,
        last_message_at: row.get(7)?,
        preview: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        rev: row.get(11)?,
    })
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<Chat> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM chats WHERE user_id = ?1 AND id = ?2"),
        params![user_id, id],
        from_row,
    )
    .or_not_found()
}

/// Fails with `NotFound` unless the chat exists and belongs to the user.
pub fn ensure_owner(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    conn.query_row(
        "SELECT 1 FROM chats WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
        |_| Ok(()),
    )
    .or_not_found()
}

pub fn list_for_character(
    conn: &Connection,
    user_id: &str,
    character_id: &str,
) -> Result<Vec<Chat>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM chats WHERE user_id = ?1 AND character_id = ?2 ORDER BY updated_at DESC"
    ))?;
    let rows = stmt
        .query_map(params![user_id, character_id], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn list_recent(conn: &Connection, user_id: &str, limit: i64) -> Result<Vec<Chat>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM chats WHERE user_id = ?1 AND message_count > 0 ORDER BY updated_at DESC LIMIT ?2"
    ))?;
    let rows = stmt
        .query_map(params![user_id, limit], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub struct NewChat {
    pub character_id: Option<String>,
    pub group_id: Option<String>,
    pub title: String,
    pub metadata: Value,
    pub header: Value,
    pub created_at: Option<i64>,
}

/// Returns `base`, or `base (2)`, `base (3)`, ... — the first title unused by the same owner.
pub fn unique_title(
    conn: &Connection,
    user_id: &str,
    character_id: Option<&str>,
    base: &str,
) -> Result<String> {
    let taken = |title: &str| -> Result<bool> {
        Ok(conn
            .query_row(
                "SELECT 1 FROM chats WHERE user_id = ?1 AND character_id IS ?2 AND title = ?3",
                params![user_id, character_id, title],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    };
    if !taken(base)? {
        return Ok(base.to_string());
    }
    (2..10_000)
        .map(|n| format!("{base} ({n})"))
        .find_map(|t| match taken(&t) {
            Ok(false) => Some(Ok(t)),
            Ok(true) => None,
            Err(e) => Some(Err(e)),
        })
        .unwrap_or_else(|| {
            Err(StoreError::Invalid(
                "too many chats with the same title".into(),
            ))
        })
}

pub fn create(conn: &Connection, user_id: &str, new: NewChat) -> Result<Chat> {
    if let Some(character_id) = &new.character_id
        && !characters::exists(conn, user_id, character_id)?
    {
        return Err(StoreError::NotFound);
    }
    let title = unique_title(conn, user_id, new.character_id.as_deref(), new.title.trim())?;
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO chats (id, user_id, character_id, group_id, title, metadata, header, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            id,
            user_id,
            new.character_id,
            new.group_id,
            title,
            json_text(&new.metadata),
            json_text(&new.header),
            new.created_at.unwrap_or(now),
            now
        ],
    )?;
    get(conn, user_id, &id)
}

pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    title: Option<&str>,
    metadata: Option<&Value>,
    expected_rev: Option<i64>,
) -> Result<Chat> {
    let current = get(conn, user_id, id)?;
    super::check_rev(current.rev, expected_rev)?;
    let title = match title {
        Some(t) if t.trim() != current.title => {
            unique_title(conn, user_id, current.character_id.as_deref(), t.trim())?
        }
        _ => current.title.clone(),
    };
    let metadata = metadata.unwrap_or(&current.metadata);
    conn.execute(
        "UPDATE chats SET title = ?3, metadata = ?4, updated_at = ?5, rev = rev + 1 WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, title, json_text(metadata), now_ms()],
    )?;
    get(conn, user_id, id)
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM chats WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)
}

/// Recomputes message count, last activity and preview after messages changed.
pub fn refresh_stats(conn: &Connection, chat_id: &str) -> Result<()> {
    let now = now_ms();
    conn.execute(
        "UPDATE chats SET
             message_count = (SELECT COUNT(*) FROM messages WHERE chat_id = ?1),
             last_message_at = (SELECT created_at FROM messages WHERE chat_id = ?1 ORDER BY seq DESC LIMIT 1),
             preview = COALESCE((SELECT substr(s.content, 1, 240) FROM messages m
                 JOIN swipes s ON s.message_id = m.id AND s.idx = m.swipe_id
                 WHERE m.chat_id = ?1 ORDER BY m.seq DESC LIMIT 1), ''),
             updated_at = ?2
         WHERE id = ?1",
        params![chat_id, now],
    )?;
    conn.execute(
        "UPDATE characters SET last_chat_at = ?2 WHERE id = (SELECT character_id FROM chats WHERE id = ?1)",
        params![chat_id, now],
    )?;
    Ok(())
}
