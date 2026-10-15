use rusqlite::{Connection, OptionalExtension, params};

use crate::Result;
use crate::util::now_ms;

pub fn create(
    conn: &Connection,
    token_hash: &str,
    user_id: &str,
    ttl_ms: i64,
    user_agent: Option<&str>,
    ip: Option<&str>,
) -> Result<()> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent, ip)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![token_hash, user_id, now, now + ttl_ms, user_agent, ip],
    )?;
    Ok(())
}

/// Returns the user id of a live session.
pub fn user_for(conn: &Connection, token_hash: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT s.user_id FROM sessions s JOIN users u ON u.id = s.user_id
             WHERE s.token_hash = ?1 AND s.expires_at > ?2 AND u.enabled = 1",
            params![token_hash, now_ms()],
            |r| r.get(0),
        )
        .optional()?)
}

pub fn delete(conn: &Connection, token_hash: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash])?;
    Ok(())
}

pub fn delete_for_user(conn: &Connection, user_id: &str) -> Result<()> {
    conn.execute("DELETE FROM sessions WHERE user_id = ?1", [user_id])?;
    Ok(())
}

pub fn purge_expired(conn: &Connection) -> Result<usize> {
    Ok(conn.execute("DELETE FROM sessions WHERE expires_at <= ?1", [now_ms()])?)
}
