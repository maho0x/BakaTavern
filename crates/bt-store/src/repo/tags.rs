use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::Result;
use crate::error::OptionalExt;
use crate::util::{new_id, now_ms};

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Tag {
    pub id: String,
    pub name: String,
    pub color: Option<String>,
    pub color2: Option<String>,
    /// `none` | `open` | `closed` (SillyTavern folder tags).
    pub folder: String,
    pub sort_order: i64,
    pub hidden: bool,
}

const COLUMNS: &str = "id, name, color, color2, folder, sort_order, hidden";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Tag> {
    Ok(Tag {
        id: row.get(0)?,
        name: row.get(1)?,
        color: row.get(2)?,
        color2: row.get(3)?,
        folder: row.get(4)?,
        sort_order: row.get(5)?,
        hidden: row.get(6)?,
    })
}

pub fn list(conn: &Connection, user_id: &str) -> Result<Vec<Tag>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM tags WHERE user_id = ?1 ORDER BY sort_order, name"
    ))?;
    let rows = stmt
        .query_map([user_id], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<Tag> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM tags WHERE user_id = ?1 AND id = ?2"),
        params![user_id, id],
        from_row,
    )
    .or_not_found()
}

/// Finds a tag by (case-sensitive) name or creates it.
pub fn ensure(conn: &Connection, user_id: &str, name: &str) -> Result<Tag> {
    let existing = conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM tags WHERE user_id = ?1 AND name = ?2"),
            params![user_id, name],
            from_row,
        )
        .optional()?;
    if let Some(tag) = existing {
        return Ok(tag);
    }
    let id = new_id();
    let order: i64 = conn.query_row(
        "SELECT COALESCE(MAX(sort_order) + 1, 0) FROM tags WHERE user_id = ?1",
        [user_id],
        |r| r.get(0),
    )?;
    conn.execute(
        "INSERT INTO tags (id, user_id, name, sort_order, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, user_id, name, order, now_ms()],
    )?;
    get(conn, user_id, &id)
}

pub fn update(conn: &Connection, user_id: &str, tag: &Tag) -> Result<Tag> {
    let n = conn.execute(
        "UPDATE tags SET name = ?3, color = ?4, color2 = ?5, folder = ?6, sort_order = ?7, hidden = ?8
         WHERE user_id = ?1 AND id = ?2",
        params![user_id, tag.id, tag.name, tag.color, tag.color2, tag.folder, tag.sort_order, tag.hidden],
    )?;
    super::affected(n)?;
    get(conn, user_id, &tag.id)
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM tags WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)
}

/// Replaces the tag set of one entity.
pub fn set_entity_tags(
    conn: &Connection,
    entity_type: &str,
    entity_id: &str,
    tag_ids: &[String],
) -> Result<()> {
    conn.execute(
        "DELETE FROM entity_tags WHERE entity_type = ?1 AND entity_id = ?2",
        params![entity_type, entity_id],
    )?;
    let mut stmt = conn.prepare(
        "INSERT OR IGNORE INTO entity_tags (tag_id, entity_type, entity_id) VALUES (?1, ?2, ?3)",
    )?;
    for tag_id in tag_ids {
        stmt.execute(params![tag_id, entity_type, entity_id])?;
    }
    Ok(())
}

/// entity id → tag ids, for all entities of one type owned by the user.
pub fn by_entity(
    conn: &Connection,
    user_id: &str,
    entity_type: &str,
) -> Result<HashMap<String, Vec<String>>> {
    let mut stmt = conn.prepare(
        "SELECT et.entity_id, et.tag_id FROM entity_tags et JOIN tags t ON t.id = et.tag_id
         WHERE t.user_id = ?1 AND et.entity_type = ?2 ORDER BY t.sort_order, t.name",
    )?;
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    let rows = stmt.query_map(params![user_id, entity_type], |r| {
        Ok((r.get::<_, String>(0)?, r.get(1)?))
    })?;
    for row in rows {
        let (entity, tag) = row?;
        map.entry(entity).or_default().push(tag);
    }
    Ok(map)
}

pub fn for_entity(conn: &Connection, entity_type: &str, entity_id: &str) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT et.tag_id FROM entity_tags et JOIN tags t ON t.id = et.tag_id
         WHERE et.entity_type = ?1 AND et.entity_id = ?2 ORDER BY t.sort_order, t.name",
    )?;
    let rows = stmt
        .query_map(params![entity_type, entity_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}
