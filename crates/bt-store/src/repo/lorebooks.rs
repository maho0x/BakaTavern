//! World Info books. Entries are stored one row per SillyTavern entry (keyed by its `uid`), so
//! editing one entry of a large book does not rewrite the whole book.

use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::{Value, json};
use ts_rs::TS;

use crate::error::OptionalExt;
use crate::util::{json_text, new_id, now_ms};
use crate::{Result, StoreError};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LorebookInfo {
    pub id: String,
    pub name: String,
    pub entry_count: i64,
    pub updated_at: i64,
    pub rev: i64,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Lorebook {
    pub id: String,
    pub name: String,
    /// Book-level fields other than `entries` (SillyTavern world JSON), verbatim.
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
    /// SillyTavern world info entries (each has a numeric `uid`), ordered by uid.
    #[ts(type = "Array<Record<string, unknown>>")]
    pub entries: Vec<Value>,
    pub created_at: i64,
    pub updated_at: i64,
    pub rev: i64,
}

fn info_from_row(row: &Row<'_>) -> rusqlite::Result<LorebookInfo> {
    Ok(LorebookInfo {
        id: row.get(0)?,
        name: row.get(1)?,
        entry_count: row.get(2)?,
        updated_at: row.get(3)?,
        rev: row.get(4)?,
    })
}

pub fn list(conn: &Connection, user_id: &str) -> Result<Vec<LorebookInfo>> {
    let mut stmt = conn.prepare(
        "SELECT b.id, b.name, (SELECT COUNT(*) FROM lorebook_entries e WHERE e.book_id = b.id), b.updated_at, b.rev
         FROM lorebooks b WHERE b.user_id = ?1 ORDER BY b.name COLLATE NOCASE",
    )?;
    let rows = stmt
        .query_map([user_id], info_from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<Lorebook> {
    let (name, data, created_at, updated_at, rev) = conn
        .query_row(
            "SELECT name, data, created_at, updated_at, rev FROM lorebooks WHERE user_id = ?1 AND id = ?2",
            params![user_id, id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Value>(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .or_not_found()?;
    let mut stmt =
        conn.prepare_cached("SELECT data FROM lorebook_entries WHERE book_id = ?1 ORDER BY uid")?;
    let entries = stmt
        .query_map([id], |r| r.get::<_, Value>(0))?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Lorebook {
        id: id.to_string(),
        name,
        data,
        entries,
        created_at,
        updated_at,
        rev,
    })
}

pub fn id_by_name(conn: &Connection, user_id: &str, name: &str) -> Result<Option<String>> {
    Ok(conn
        .query_row(
            "SELECT id FROM lorebooks WHERE user_id = ?1 AND name = ?2",
            params![user_id, name],
            |r| r.get(0),
        )
        .optional()?)
}

fn entry_uid(entry: &Value) -> Option<i64> {
    match entry.get("uid") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => s.parse().ok(),
        _ => None,
    }
}

/// Assigns missing or duplicate uids, writing the uid back into each entry.
fn normalize_entries(entries: Vec<Value>) -> Result<Vec<(i64, Value)>> {
    let mut used = std::collections::HashSet::new();
    let mut next = entries.iter().filter_map(entry_uid).max().unwrap_or(-1) + 1;
    let mut out = Vec::with_capacity(entries.len());
    for mut entry in entries {
        let Value::Object(map) = &mut entry else {
            return Err(StoreError::Invalid(
                "world info entry must be an object".into(),
            ));
        };
        let uid = match entry_uid(&Value::Object(map.clone())) {
            Some(uid) if used.insert(uid) => uid,
            _ => {
                let uid = next;
                next += 1;
                used.insert(uid);
                uid
            }
        };
        map.insert("uid".into(), json!(uid));
        out.push((uid, entry));
    }
    Ok(out)
}

fn write_entries(conn: &Connection, book_id: &str, entries: Vec<Value>) -> Result<()> {
    conn.execute("DELETE FROM lorebook_entries WHERE book_id = ?1", [book_id])?;
    let now = now_ms();
    let mut stmt = conn.prepare_cached(
        "INSERT INTO lorebook_entries (book_id, uid, data, updated_at) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (uid, entry) in normalize_entries(entries)? {
        stmt.execute(params![book_id, uid, json_text(&entry), now])?;
    }
    Ok(())
}

pub fn create(
    conn: &Connection,
    user_id: &str,
    name: &str,
    data: &Value,
    entries: Vec<Value>,
) -> Result<Lorebook> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StoreError::Invalid("lorebook name is empty".into()));
    }
    if id_by_name(conn, user_id, name)?.is_some() {
        return Err(StoreError::Invalid(format!(
            "a lorebook named {name:?} already exists"
        )));
    }
    let id = new_id();
    let now = now_ms();
    conn.execute(
        "INSERT INTO lorebooks (id, user_id, name, data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
        params![id, user_id, name, json_text(data), now],
    )?;
    write_entries(conn, &id, entries)?;
    get(conn, user_id, &id)
}

fn bump(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "UPDATE lorebooks SET updated_at = ?3, rev = rev + 1 WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, now_ms()],
    )?;
    super::affected(n)
}

/// Replaces book data and all entries.
pub fn replace(
    conn: &Connection,
    user_id: &str,
    id: &str,
    data: &Value,
    entries: Vec<Value>,
    expected_rev: Option<i64>,
) -> Result<Lorebook> {
    let rev: i64 = conn
        .query_row(
            "SELECT rev FROM lorebooks WHERE user_id = ?1 AND id = ?2",
            params![user_id, id],
            |r| r.get(0),
        )
        .or_not_found()?;
    super::check_rev(rev, expected_rev)?;
    conn.execute(
        "UPDATE lorebooks SET data = ?2 WHERE id = ?1",
        params![id, json_text(data)],
    )?;
    write_entries(conn, id, entries)?;
    bump(conn, user_id, id)?;
    get(conn, user_id, id)
}

/// Inserts or replaces one entry (by `uid`; a uid is assigned when missing). Returns the stored entry.
pub fn upsert_entry(conn: &Connection, user_id: &str, id: &str, mut entry: Value) -> Result<Value> {
    let uid = match entry_uid(&entry) {
        Some(uid) => uid,
        None => conn.query_row(
            "SELECT COALESCE(MAX(uid) + 1, 0) FROM lorebook_entries WHERE book_id = ?1",
            [id],
            |r| r.get(0),
        )?,
    };
    let Value::Object(map) = &mut entry else {
        return Err(StoreError::Invalid(
            "world info entry must be an object".into(),
        ));
    };
    map.insert("uid".into(), json!(uid));
    bump(conn, user_id, id)?;
    conn.execute(
        "INSERT INTO lorebook_entries (book_id, uid, data, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (book_id, uid) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at",
        params![id, uid, json_text(&entry), now_ms()],
    )?;
    Ok(entry)
}

pub fn delete_entry(conn: &Connection, user_id: &str, id: &str, uid: i64) -> Result<()> {
    bump(conn, user_id, id)?;
    let n = conn.execute(
        "DELETE FROM lorebook_entries WHERE book_id = ?1 AND uid = ?2",
        params![id, uid],
    )?;
    super::affected(n)
}

pub fn rename(conn: &Connection, user_id: &str, id: &str, name: &str) -> Result<()> {
    let name = name.trim();
    if name.is_empty() {
        return Err(StoreError::Invalid("lorebook name is empty".into()));
    }
    if id_by_name(conn, user_id, name)?.is_some_and(|other| other != id) {
        return Err(StoreError::Invalid(format!(
            "a lorebook named {name:?} already exists"
        )));
    }
    let n = conn.execute(
        "UPDATE lorebooks SET name = ?3, updated_at = ?4, rev = rev + 1 WHERE user_id = ?1 AND id = ?2",
        params![user_id, id, name, now_ms()],
    )?;
    super::affected(n)
}

pub fn delete(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "DELETE FROM lorebooks WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Db, repo::users};

    #[test]
    fn uids_are_assigned_and_entries_upserted() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let user = users::ensure_default(c)?;
            let book = create(
                c,
                &user.id,
                "World",
                &json!({}),
                vec![
                    json!({"uid": 3, "key": ["a"]}),
                    json!({"key": ["b"]}),
                    json!({"uid": 3, "key": ["c"]}),
                ],
            )?;
            let uids: Vec<i64> = book
                .entries
                .iter()
                .map(|e| e["uid"].as_i64().unwrap())
                .collect();
            assert_eq!(uids, [3, 4, 5]);
            let stored = upsert_entry(c, &user.id, &book.id, json!({"key": ["d"]}))?;
            assert_eq!(stored["uid"], 6);
            upsert_entry(c, &user.id, &book.id, json!({"uid": 3, "key": ["changed"]}))?;
            let book = get(c, &user.id, &book.id)?;
            assert_eq!(book.entries.len(), 4);
            assert_eq!(book.entries[0]["key"][0], "changed");
            assert_eq!(book.rev, 3);
            delete_entry(c, &user.id, &book.id, 4)?;
            assert_eq!(list(c, &user.id)?[0].entry_count, 3);
            assert!(create(c, &user.id, "World", &json!({}), vec![]).is_err());
            Ok(())
        })
        .unwrap();
    }
}
