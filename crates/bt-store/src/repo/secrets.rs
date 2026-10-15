use rusqlite::{Connection, Row, params};
use serde::Serialize;
use ts_rs::TS;

use crate::Result;
use crate::error::OptionalExt;
use crate::util::{new_id, now_ms};

/// Public view of a stored API key. The plaintext never leaves the server.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SecretInfo {
    pub id: String,
    pub provider: String,
    pub label: String,
    pub masked: String,
    /// Origins (scheme://host[:port]) this key may be sent to.
    pub allowed_origins: Vec<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone)]
pub struct SecretMaterial {
    pub info: SecretInfo,
    pub ciphertext: Vec<u8>,
}

const COLUMNS: &str =
    "id, provider, label, masked, allowed_origins, created_at, updated_at, ciphertext";

fn from_row(row: &Row<'_>) -> rusqlite::Result<SecretMaterial> {
    let origins: String = row.get(4)?;
    Ok(SecretMaterial {
        info: SecretInfo {
            id: row.get(0)?,
            provider: row.get(1)?,
            label: row.get(2)?,
            masked: row.get(3)?,
            allowed_origins: serde_json::from_str(&origins).unwrap_or_default(),
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
        },
        ciphertext: row.get(7)?,
    })
}

pub fn list(conn: &Connection, user_id: &str) -> Result<Vec<SecretInfo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM secrets WHERE user_id = ?1 ORDER BY provider, created_at"
    ))?;
    let rows = stmt
        .query_map([user_id], from_row)?
        .map(|r| r.map(|m| m.info))
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<SecretMaterial> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM secrets WHERE user_id = ?1 AND id = ?2"),
        params![user_id, id],
        from_row,
    )
    .or_not_found()
}

pub struct NewSecret<'a> {
    pub provider: &'a str,
    pub label: &'a str,
    pub masked: &'a str,
    pub ciphertext: &'a [u8],
    pub allowed_origins: &'a [String],
}

pub fn create(conn: &Connection, user_id: &str, secret: NewSecret<'_>) -> Result<SecretInfo> {
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO secrets (id, user_id, provider, label, masked, ciphertext, allowed_origins, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            id,
            user_id,
            secret.provider,
            secret.label,
            secret.masked,
            secret.ciphertext,
            serde_json::to_string(secret.allowed_origins)?,
            now
        ],
    )?;
    Ok(get(conn, user_id, &id)?.info)
}

#[derive(Default)]
pub struct SecretPatch<'a> {
    pub label: Option<&'a str>,
    pub allowed_origins: Option<&'a [String]>,
    /// New `(masked, ciphertext)` when the key itself is replaced.
    pub value: Option<(&'a str, &'a [u8])>,
}

pub fn update(
    conn: &Connection,
    user_id: &str,
    id: &str,
    patch: SecretPatch<'_>,
) -> Result<SecretInfo> {
    let current = get(conn, user_id, id)?;
    let label = patch.label.unwrap_or(&current.info.label);
    let origins = match patch.allowed_origins {
        Some(o) => serde_json::to_string(o)?,
        None => serde_json::to_string(&current.info.allowed_origins)?,
    };
    let (masked, ciphertext) = patch
        .value
        .unwrap_or((current.info.masked.as_str(), current.ciphertext.as_slice()));
    conn.execute(
        "UPDATE secrets SET label = ?3, allowed_origins = ?4, masked = ?5, ciphertext = ?6, updated_at = ?7
         WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, label, origins, masked, ciphertext, now_ms()],
    )?;
    Ok(get(conn, user_id, id)?.info)
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM secrets WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)
}
