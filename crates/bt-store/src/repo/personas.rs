use rusqlite::{Connection, Row, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

use crate::Result;
use crate::error::OptionalExt;
use crate::util::{json_text, new_id, now_ms};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Persona {
    pub id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub description: String,
    /// SillyTavern `persona_description_positions`: 0 in prompt, 2 top of AN, 3 bottom of AN,
    /// 4 at depth, 9 none.
    pub position: i64,
    pub depth: i64,
    /// 0 system, 1 user, 2 assistant.
    pub role: i64,
    /// Name of the bound lorebook.
    #[ts(optional = nullable)]
    pub lorebook: Option<String>,
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
    pub is_default: bool,
    pub source_file: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub rev: i64,
}

/// Writable persona fields.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export, optional_fields)]
pub struct PersonaInput {
    pub name: String,
    pub description: String,
    pub position: i64,
    pub depth: i64,
    pub role: i64,
    #[ts(optional = nullable)]
    pub lorebook: Option<String>,
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
}

impl Default for PersonaInput {
    fn default() -> Self {
        Self {
            name: "User".into(),
            description: String::new(),
            position: 0,
            depth: 2,
            role: 0,
            lorebook: None,
            data: Value::Object(Default::default()),
        }
    }
}

const COLUMNS: &str =
    "id, name, avatar, description, position, depth, role, lorebook, data, is_default,
    source_file, created_at, updated_at, rev";

fn from_row(row: &Row<'_>) -> rusqlite::Result<Persona> {
    Ok(Persona {
        id: row.get(0)?,
        name: row.get(1)?,
        avatar: row.get(2)?,
        description: row.get(3)?,
        position: row.get(4)?,
        depth: row.get(5)?,
        role: row.get(6)?,
        lorebook: row.get(7)?,
        data: row.get(8)?,
        is_default: row.get(9)?,
        source_file: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        rev: row.get(13)?,
    })
}

pub fn list(conn: &Connection, user_id: &str) -> Result<Vec<Persona>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM personas WHERE user_id = ?1 ORDER BY name COLLATE NOCASE, created_at"
    ))?;
    let rows = stmt
        .query_map([user_id], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<Persona> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM personas WHERE user_id = ?1 AND id = ?2"),
        params![user_id, id],
        from_row,
    )
    .or_not_found()
}

pub fn create(
    conn: &Connection,
    user_id: &str,
    input: &PersonaInput,
    avatar: Option<&str>,
    source_file: Option<&str>,
) -> Result<Persona> {
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO personas (id, user_id, name, avatar, description, position, depth, role, lorebook, data,
             source_file, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)",
        params![
            id,
            user_id,
            input.name,
            avatar,
            input.description,
            input.position,
            input.depth,
            input.role,
            input.lorebook,
            json_text(&input.data),
            source_file,
            now
        ],
    )?;
    get(conn, user_id, &id)
}

pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    input: &PersonaInput,
    expected_rev: Option<i64>,
) -> Result<Persona> {
    super::check_rev(get(conn, user_id, id)?.rev, expected_rev)?;
    conn.execute(
        "UPDATE personas SET name = ?3, description = ?4, position = ?5, depth = ?6, role = ?7, lorebook = ?8,
             data = ?9, updated_at = ?10, rev = rev + 1
         WHERE user_id = ?1 AND id = ?2",
        params![
            user_id,
            id,
            input.name,
            input.description,
            input.position,
            input.depth,
            input.role,
            input.lorebook,
            json_text(&input.data),
            now_ms()
        ],
    )?;
    get(conn, user_id, id)
}

pub fn set_avatar(
    conn: &Connection,
    user_id: &str,
    id: &str,
    hash: Option<&str>,
) -> Result<Persona> {
    let n = conn.execute(
        "UPDATE personas SET avatar = ?3, updated_at = ?4, rev = rev + 1 WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, hash, now_ms()],
    )?;
    super::affected(n)?;
    get(conn, user_id, id)
}

/// Marks one persona as the default (or clears the default with `None`).
pub fn set_default(conn: &Connection, user_id: &str, id: Option<&str>) -> Result<()> {
    conn.execute(
        "UPDATE personas SET is_default = (id IS ?2), rev = rev + (is_default != (id IS ?2)) WHERE user_id = ?1",
        params![user_id, id],
    )?;
    Ok(())
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM personas WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)
}
