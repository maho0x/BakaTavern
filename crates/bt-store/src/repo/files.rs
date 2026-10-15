use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use ts_rs::TS;

use crate::Result;
use crate::util::now_ms;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileRecord {
    pub hash: String,
    pub mime: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub created_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<FileRecord> {
    Ok(FileRecord {
        hash: row.get(0)?,
        mime: row.get(1)?,
        size: row.get(2)?,
        width: row.get(3)?,
        height: row.get(4)?,
        created_at: row.get(5)?,
    })
}

pub fn insert_if_absent(
    conn: &Connection,
    hash: &str,
    mime: &str,
    size: i64,
    dims: Option<(u32, u32)>,
) -> Result<FileRecord> {
    conn.execute(
        "INSERT INTO files (hash, mime, size, width, height, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (hash) DO NOTHING",
        params![hash, mime, size, dims.map(|d| d.0), dims.map(|d| d.1), now_ms()],
    )?;
    Ok(get(conn, hash)?.expect("row was just written"))
}

pub fn get(conn: &Connection, hash: &str) -> Result<Option<FileRecord>> {
    Ok(conn
        .query_row(
            "SELECT hash, mime, size, width, height, created_at FROM files WHERE hash = ?1",
            [hash],
            from_row,
        )
        .optional()?)
}

/// Hashes of files no longer referenced by any row (candidates for garbage collection).
pub fn unreferenced(conn: &Connection) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT hash FROM files f
         WHERE NOT EXISTS (SELECT 1 FROM characters WHERE avatar = f.hash)
           AND NOT EXISTS (SELECT 1 FROM personas WHERE avatar = f.hash)",
    )?;
    let rows = stmt
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn delete(conn: &Connection, hash: &str) -> Result<()> {
    conn.execute("DELETE FROM files WHERE hash = ?1", [hash])?;
    Ok(())
}
