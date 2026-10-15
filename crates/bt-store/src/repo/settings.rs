use rusqlite::{Connection, OptionalExtension, Row, params};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::Result;
use crate::util::{json_text, now_ms};

/// One namespace of user settings (e.g. `ui`, `chat`, `api`, `worldinfo`).
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SettingsDoc {
    pub namespace: String,
    #[ts(type = "Record<string, unknown>")]
    pub data: Value,
    pub rev: i64,
    pub updated_at: i64,
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<SettingsDoc> {
    Ok(SettingsDoc {
        namespace: row.get(0)?,
        data: row.get(1)?,
        rev: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

pub fn get(conn: &Connection, user_id: &str, namespace: &str) -> Result<Option<SettingsDoc>> {
    Ok(conn
        .query_row(
            "SELECT namespace, data, rev, updated_at FROM settings WHERE user_id = ?1 AND namespace = ?2",
            params![user_id, namespace],
            from_row,
        )
        .optional()?)
}

pub fn list(conn: &Connection, user_id: &str) -> Result<Vec<SettingsDoc>> {
    let mut stmt = conn.prepare(
        "SELECT namespace, data, rev, updated_at FROM settings WHERE user_id = ?1 ORDER BY namespace",
    )?;
    let docs = stmt
        .query_map([user_id], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(docs)
}

/// Replaces a namespace. With `expected_rev`, fails with `Conflict` unless it matches the
/// stored revision (0 means "must not exist yet").
pub fn put(
    conn: &Connection,
    user_id: &str,
    namespace: &str,
    data: &Value,
    expected_rev: Option<i64>,
) -> Result<SettingsDoc> {
    let current = get(conn, user_id, namespace)?.map(|d| d.rev).unwrap_or(0);
    super::check_rev(current, expected_rev)?;
    let now = now_ms();
    conn.execute(
        "INSERT INTO settings (user_id, namespace, data, rev, updated_at) VALUES (?1, ?2, ?3, 1, ?4)
         ON CONFLICT (user_id, namespace) DO UPDATE SET data = excluded.data, rev = rev + 1,
             updated_at = excluded.updated_at",
        params![user_id, namespace, json_text(data), now],
    )?;
    Ok(get(conn, user_id, namespace)?.expect("row was just written"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Db, StoreError, repo::users};
    use serde_json::json;

    #[test]
    fn optimistic_concurrency() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let user = users::ensure_default(c)?;
            let doc = put(c, &user.id, "ui", &json!({"theme": "dark"}), Some(0))?;
            assert_eq!(doc.rev, 1);
            let doc = put(c, &user.id, "ui", &json!({"theme": "light"}), Some(1))?;
            assert_eq!(doc.rev, 2);
            let err = put(c, &user.id, "ui", &json!({}), Some(1)).unwrap_err();
            assert!(matches!(err, StoreError::Conflict { current: 2 }));
            assert_eq!(get(c, &user.id, "ui")?.unwrap().data["theme"], "light");
            Ok(())
        })
        .unwrap();
    }
}
