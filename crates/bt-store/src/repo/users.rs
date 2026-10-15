use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use ts_rs::TS;

use crate::error::OptionalExt;
use crate::util::{new_id, now_ms};
use crate::{Result, StoreError};

pub const DEFAULT_HANDLE: &str = "default-user";

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct User {
    pub id: String,
    pub handle: String,
    pub name: String,
    pub role: String,
    pub enabled: bool,
    pub has_password: bool,
    pub created_at: i64,
    pub updated_at: i64,
}

const COLUMNS: &str =
    "id, handle, name, role, enabled, password_hash IS NOT NULL, created_at, updated_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<User> {
    Ok(User {
        id: row.get(0)?,
        handle: row.get(1)?,
        name: row.get(2)?,
        role: row.get(3)?,
        enabled: row.get(4)?,
        has_password: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

pub fn get(conn: &Connection, id: &str) -> Result<User> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM users WHERE id = ?1"),
        [id],
        from_row,
    )
    .or_not_found()
}

pub fn get_by_handle(conn: &Connection, handle: &str) -> Result<Option<User>> {
    Ok(conn
        .query_row(
            &format!("SELECT {COLUMNS} FROM users WHERE handle = ?1"),
            [handle],
            from_row,
        )
        .optional()?)
}

pub fn list(conn: &Connection) -> Result<Vec<User>> {
    let mut stmt = conn.prepare(&format!("SELECT {COLUMNS} FROM users ORDER BY created_at"))?;
    let rows = stmt
        .query_map([], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn password_hash(conn: &Connection, id: &str) -> Result<Option<String>> {
    conn.query_row("SELECT password_hash FROM users WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .or_not_found()
}

pub fn create(
    conn: &Connection,
    handle: &str,
    name: &str,
    role: &str,
    password_hash: Option<&str>,
) -> Result<User> {
    if handle.is_empty()
        || !handle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(StoreError::Invalid(format!(
            "invalid user handle: {handle:?}"
        )));
    }
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO users (id, handle, name, password_hash, role, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        params![id, handle, name, password_hash, role, now],
    )?;
    get(conn, &id)
}

pub fn set_password(conn: &Connection, id: &str, password_hash: Option<&str>) -> Result<()> {
    let n = conn.execute(
        "UPDATE users SET password_hash = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, password_hash, now_ms()],
    )?;
    super::affected(n)
}

/// Returns the default (admin) user, creating it on first run.
pub fn ensure_default(conn: &Connection) -> Result<User> {
    match get_by_handle(conn, DEFAULT_HANDLE)? {
        Some(user) => Ok(user),
        None => create(conn, DEFAULT_HANDLE, "User", "admin", None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Db;

    #[test]
    fn default_user_is_created_once() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let a = ensure_default(c)?;
            let b = ensure_default(c)?;
            assert_eq!(a.id, b.id);
            assert_eq!(a.role, "admin");
            assert!(!a.has_password);
            set_password(c, &a.id, Some("hash"))?;
            assert!(get(c, &a.id)?.has_password);
            assert!(create(c, "bad handle", "x", "user", None).is_err());
            Ok(())
        })
        .unwrap();
    }
}
