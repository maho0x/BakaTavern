//! The prompts generations sent, stored as the web app recorded them (opaque JSON) and kept for a
//! while; see `0002_prompt_logs.sql`.

use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value;

use crate::Result;
use crate::util::{json_text, now_ms};

/// Records (or replaces) the prompt of the generation that started at `started_at`.
pub fn put(conn: &Connection, chat_id: &str, started_at: &str, data: &Value) -> Result<()> {
    conn.execute(
        "INSERT INTO prompt_logs (chat_id, started_at, data, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (chat_id, started_at) DO UPDATE SET data = excluded.data, created_at = excluded.created_at",
        params![chat_id, started_at, json_text(data), now_ms()],
    )?;
    Ok(())
}

/// The prompt of a generation, if it was recorded.
pub fn get(conn: &Connection, chat_id: &str, started_at: &str) -> Result<Option<Value>> {
    Ok(conn
        .query_row(
            "SELECT data FROM prompt_logs WHERE chat_id = ?1 AND started_at = ?2",
            params![chat_id, started_at],
            |r| r.get::<_, Value>(0),
        )
        .optional()?)
}

/// The prompt recorded before the one at `started_at` (for comparing the two).
pub fn previous(conn: &Connection, chat_id: &str, started_at: &str) -> Result<Option<Value>> {
    Ok(conn
        .query_row(
            "SELECT data FROM prompt_logs WHERE chat_id = ?1 AND started_at < ?2
             ORDER BY started_at DESC LIMIT 1",
            params![chat_id, started_at],
            |r| r.get::<_, Value>(0),
        )
        .optional()?)
}

/// Deletes prompts recorded more than `max_age_ms` ago; returns how many.
pub fn purge(conn: &Connection, max_age_ms: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM prompt_logs WHERE created_at < ?1",
        [now_ms() - max_age_ms],
    )?)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::repo::{chats, users};

    #[test]
    fn prompts_are_kept_per_generation() {
        let db = crate::Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let user = users::ensure_default(c)?;
            let chat = chats::create(
                c,
                &user.id,
                chats::NewChat {
                    character_id: None,
                    group_id: None,
                    title: "t".into(),
                    metadata: json!({}),
                    header: json!({}),
                    created_at: None,
                },
            )?;
            put(
                c,
                &chat.id,
                "2026-10-16T10:00:00.000Z",
                &json!({"total": 1}),
            )?;
            put(
                c,
                &chat.id,
                "2026-10-16T10:05:00.000Z",
                &json!({"total": 2}),
            )?;
            put(
                c,
                &chat.id,
                "2026-10-16T10:05:00.000Z",
                &json!({"total": 3}),
            )?;
            assert_eq!(
                get(c, &chat.id, "2026-10-16T10:05:00.000Z")?,
                Some(json!({"total": 3}))
            );
            assert_eq!(
                previous(c, &chat.id, "2026-10-16T10:05:00.000Z")?,
                Some(json!({"total": 1}))
            );
            assert_eq!(get(c, &chat.id, "2026-10-16T11:00:00.000Z")?, None);
            assert_eq!(purge(c, -1)?, 2);
            chats::delete(c, &user.id, &chat.id)?;
            Ok(())
        })
        .unwrap();
    }
}
