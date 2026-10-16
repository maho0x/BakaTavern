//! Named JSON documents kept in SillyTavern formats (presets, templates, themes, QR sets).

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::error::OptionalExt;
use crate::util::{json_text, new_id, now_ms};
use crate::{Result, StoreError};

/// Known kinds; the column is open-ended so plugins can add their own.
pub const KINDS: &[&str] = &[
    "openai",
    "textgen",
    "kobold",
    "novel",
    "instruct",
    "context",
    "sysprompt",
    "reasoning",
    "theme",
    "quickreply",
];

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PresetInfo {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub updated_at: i64,
    pub rev: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Preset {
    #[serde(flatten)]
    pub info: PresetInfo,
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
}

fn info_from_row(row: &Row<'_>) -> rusqlite::Result<PresetInfo> {
    Ok(PresetInfo {
        id: row.get(0)?,
        kind: row.get(1)?,
        name: row.get(2)?,
        updated_at: row.get(3)?,
        rev: row.get(4)?,
    })
}

fn validate(kind: &str, name: &str) -> Result<()> {
    if kind.is_empty()
        || !kind
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        return Err(StoreError::Invalid(format!("invalid preset kind {kind:?}")));
    }
    if name.trim().is_empty() {
        return Err(StoreError::Invalid("preset name is empty".into()));
    }
    Ok(())
}

pub fn list(conn: &Connection, user_id: &str, kind: Option<&str>) -> Result<Vec<PresetInfo>> {
    let mut stmt = conn.prepare(
        "SELECT id, kind, name, updated_at, rev FROM presets WHERE user_id = ?1 AND (?2 IS NULL OR kind = ?2)
         ORDER BY kind, name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map(params![user_id, kind], info_from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<Preset> {
    conn.query_row(
        "SELECT id, kind, name, updated_at, rev, data FROM presets WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
        |r| {
            Ok(Preset {
                info: info_from_row(r)?,
                data: r.get(5)?,
            })
        },
    )
    .or_not_found()
}

pub fn get_by_name(
    conn: &Connection,
    user_id: &str,
    kind: &str,
    name: &str,
) -> Result<Option<Preset>> {
    Ok(conn
        .query_row(
            "SELECT id, kind, name, updated_at, rev, data FROM presets WHERE user_id = ?1 AND kind = ?2 AND name = ?3",
            params![user_id, kind, name],
            |r| Ok(Preset { info: info_from_row(r)?, data: r.get(5)? }),
        )
        .optional()?)
}

/// Creates a preset or replaces the data of the existing one with the same kind and name.
pub fn upsert(
    conn: &Connection,
    user_id: &str,
    kind: &str,
    name: &str,
    data: &Value,
) -> Result<Preset> {
    validate(kind, name)?;
    let name = name.trim();
    let now = now_ms();
    conn.execute(
        "INSERT INTO presets (id, user_id, kind, name, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
         ON CONFLICT (user_id, kind, name) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at,
             rev = rev + 1",
        params![new_id(), user_id, kind, name, json_text(data), now],
    )?;
    Ok(get_by_name(conn, user_id, kind, name)?.expect("row was just written"))
}

/// Creates the presets whose kind and name are not taken yet, leaving existing ones alone. Returns
/// the created presets.
pub fn seed(
    conn: &mut Connection,
    user_id: &str,
    presets: &[(String, String, Value)],
) -> Result<Vec<PresetInfo>> {
    let tx = conn.transaction()?;
    let mut created = Vec::new();
    for (kind, name, data) in presets {
        validate(kind, name)?;
        if get_by_name(&tx, user_id, kind, name.trim())?.is_none() {
            created.push(upsert(&tx, user_id, kind, name, data)?.info);
        }
    }
    tx.commit()?;
    Ok(created)
}

pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    name: Option<&str>,
    data: Option<&Value>,
    expected_rev: Option<i64>,
) -> Result<Preset> {
    let current = get(conn, user_id, id)?;
    super::check_rev(current.info.rev, expected_rev)?;
    let name = name.map(str::trim).unwrap_or(&current.info.name);
    validate(&current.info.kind, name)?;
    if let Some(other) = get_by_name(conn, user_id, &current.info.kind, name)?
        && other.info.id != id
    {
        return Err(StoreError::Exists(format!(
            "a preset named {name:?} already exists"
        )));
    }
    conn.execute(
        "UPDATE presets SET name = ?3, data = ?4, updated_at = ?5, rev = rev + 1 WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, name, json_text(data.unwrap_or(&current.data)), now_ms()],
    )?;
    get(conn, user_id, id)
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM presets WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)
}
