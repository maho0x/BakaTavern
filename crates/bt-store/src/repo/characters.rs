use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use super::tags;
use crate::error::OptionalExt;
use crate::util::{excerpt, json_text, new_id, now_ms};
use crate::{Result, StoreError};

pub const ENTITY: &str = "character";

/// Lightweight row for character lists.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CharacterSummary {
    pub id: String,
    pub name: String,
    /// Avatar blob hash.
    pub avatar: Option<String>,
    pub fav: bool,
    pub creator: String,
    pub version: String,
    pub excerpt: String,
    pub tags: Vec<String>,
    /// SillyTavern avatar file name this character was imported from (e.g. `Seraphina.png`).
    pub source_file: Option<String>,
    pub chat_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_chat_at: Option<i64>,
    pub rev: i64,
}

/// A character with its full card (Character Card V3 shape: `{ spec, spec_version, data }`).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Character {
    #[serde(flatten)]
    pub summary: CharacterSummary,
    #[ts(type = "Record<string, unknown>")]
    pub card: Value,
}

const COLUMNS: &str = "c.id, c.name, c.avatar, c.fav, c.creator, c.version, c.excerpt, c.source_file,
    (SELECT COUNT(*) FROM chats WHERE character_id = c.id), c.created_at, c.updated_at, c.last_chat_at, c.rev";

fn summary_from_row(row: &Row<'_>) -> rusqlite::Result<CharacterSummary> {
    Ok(CharacterSummary {
        id: row.get(0)?,
        name: row.get(1)?,
        avatar: row.get(2)?,
        fav: row.get(3)?,
        creator: row.get(4)?,
        version: row.get(5)?,
        excerpt: row.get(6)?,
        source_file: row.get(7)?,
        chat_count: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
        last_chat_at: row.get(11)?,
        rev: row.get(12)?,
        tags: Vec::new(),
    })
}

/// Columns derived from the card for listing/sorting.
struct Derived {
    name: String,
    fav: bool,
    creator: String,
    version: String,
    excerpt: String,
}

fn data_str<'a>(card: &'a Value, key: &str) -> &'a str {
    card.get("data")
        .and_then(|d| d.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
}

fn derive(card: &Value) -> Result<Derived> {
    let name = data_str(card, "name").trim();
    if name.is_empty() {
        return Err(StoreError::Invalid("character card has no name".into()));
    }
    let fav = match card.pointer("/data/extensions/fav") {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s == "true",
        _ => false,
    };
    let notes = data_str(card, "creator_notes");
    let source = if notes.trim().is_empty() {
        data_str(card, "description")
    } else {
        notes
    };
    Ok(Derived {
        name: name.to_string(),
        fav,
        creator: data_str(card, "creator").to_string(),
        version: data_str(card, "character_version").to_string(),
        excerpt: excerpt(source, 160),
    })
}

pub fn list(conn: &Connection, user_id: &str) -> Result<Vec<CharacterSummary>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM characters c WHERE c.user_id = ?1 ORDER BY c.name COLLATE NOCASE, c.created_at"
    ))?;
    let mut rows: Vec<CharacterSummary> = stmt
        .query_map([user_id], summary_from_row)?
        .collect::<rusqlite::Result<_>>()?;
    let mut tag_map = tags::by_entity(conn, user_id, ENTITY)?;
    for row in &mut rows {
        row.tags = tag_map.remove(&row.id).unwrap_or_default();
    }
    Ok(rows)
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<Character> {
    let (mut summary, card) = conn
        .query_row(
            &format!(
                "SELECT {COLUMNS}, c.card FROM characters c WHERE c.user_id = ?1 AND c.id = ?2"
            ),
            params![user_id, id],
            |row| Ok((summary_from_row(row)?, row.get::<_, Value>(13)?)),
        )
        .or_not_found()?;
    summary.tags = tags::for_entity(conn, ENTITY, id)?;
    Ok(Character { summary, card })
}

pub fn exists(conn: &Connection, user_id: &str, id: &str) -> Result<bool> {
    Ok(conn
        .query_row(
            "SELECT 1 FROM characters WHERE user_id = ?1 AND id = ?2",
            params![user_id, id],
            |_| Ok(()),
        )
        .optional()?
        .is_some())
}

pub struct NewCharacter {
    pub card: Value,
    pub avatar: Option<String>,
    pub source_file: Option<String>,
    pub created_at: Option<i64>,
}

pub fn create(conn: &Connection, user_id: &str, new: NewCharacter) -> Result<Character> {
    let d = derive(&new.card)?;
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO characters (id, user_id, name, avatar, card, fav, creator, version, excerpt, source_file,
             created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
        params![
            id,
            user_id,
            d.name,
            new.avatar,
            json_text(&new.card),
            d.fav,
            d.creator,
            d.version,
            d.excerpt,
            new.source_file,
            new.created_at.unwrap_or(now),
            now
        ],
    )?;
    get(conn, user_id, &id)
}

pub fn update_card(
    conn: &Connection,
    user_id: &str,
    id: &str,
    card: &Value,
    expected_rev: Option<i64>,
) -> Result<Character> {
    let current = get(conn, user_id, id)?;
    super::check_rev(current.summary.rev, expected_rev)?;
    let d = derive(card)?;
    conn.execute(
        "UPDATE characters SET name = ?3, card = ?4, fav = ?5, creator = ?6, version = ?7, excerpt = ?8,
             updated_at = ?9, rev = rev + 1
         WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, d.name, json_text(card), d.fav, d.creator, d.version, d.excerpt, now_ms()],
    )?;
    get(conn, user_id, id)
}

pub fn set_avatar(
    conn: &Connection,
    user_id: &str,
    id: &str,
    hash: Option<&str>,
) -> Result<Character> {
    let n = conn.execute(
        "UPDATE characters SET avatar = ?3, updated_at = ?4, rev = rev + 1 WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, hash, now_ms()],
    )?;
    super::affected(n)?;
    get(conn, user_id, id)
}

pub fn touch_last_chat(conn: &Connection, id: &str, at: i64) -> Result<()> {
    conn.execute(
        "UPDATE characters SET last_chat_at = ?2 WHERE id = ?1",
        params![id, at],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM characters WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)?;
    conn.execute(
        "DELETE FROM entity_tags WHERE entity_type = ?1 AND entity_id = ?2",
        params![ENTITY, id],
    )?;
    Ok(())
}

pub fn find_by_source_file(
    conn: &Connection,
    user_id: &str,
    source_file: &str,
) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM characters WHERE user_id = ?1 AND source_file = ?2",
            params![user_id, source_file],
            |r| r.get(0),
        )
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Db, repo::users};
    use serde_json::json;

    fn card(name: &str) -> Value {
        json!({"spec": "chara_card_v3", "spec_version": "3.0",
               "data": {"name": name, "description": "A test character.", "extensions": {"fav": true}}})
    }

    #[test]
    fn crud_and_tags() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let user = users::ensure_default(c)?;
            let created = create(
                c,
                &user.id,
                NewCharacter {
                    card: card("Seraphina"),
                    avatar: None,
                    source_file: None,
                    created_at: None,
                },
            )?;
            assert_eq!(created.summary.name, "Seraphina");
            assert!(created.summary.fav);
            assert_eq!(created.summary.excerpt, "A test character.");

            let tag = tags::ensure(c, &user.id, "fantasy")?;
            tags::set_entity_tags(
                c,
                ENTITY,
                &created.summary.id,
                std::slice::from_ref(&tag.id),
            )?;
            let listed = list(c, &user.id)?;
            assert_eq!(listed.len(), 1);
            assert_eq!(listed[0].tags, vec![tag.id.clone()]);

            let updated = update_card(c, &user.id, &created.summary.id, &card("Sera"), Some(1))?;
            assert_eq!(updated.summary.rev, 2);
            assert_eq!(updated.summary.name, "Sera");
            assert!(update_card(c, &user.id, &created.summary.id, &card("X"), Some(1)).is_err());
            assert!(
                create(
                    c,
                    &user.id,
                    NewCharacter {
                        card: json!({}),
                        avatar: None,
                        source_file: None,
                        created_at: None
                    }
                )
                .is_err()
            );

            delete(c, &user.id, &created.summary.id)?;
            assert!(list(c, &user.id)?.is_empty());
            Ok(())
        })
        .unwrap();
    }
}
