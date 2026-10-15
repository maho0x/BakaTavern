//! Durable generation jobs. Running jobs live in the server's memory; finished ones are kept here
//! until a client acknowledges them, so a reply survives a dropped connection.

use rusqlite::{Connection, Row, params};
use serde::Serialize;
use serde_json::Value;
use ts_rs::TS;

use crate::Result;
use crate::error::OptionalExt;
use crate::util::{json_text, now_ms};

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct JobInfo {
    pub id: String,
    pub chat_id: Option<String>,
    /// `running` | `completed` | `failed` | `aborted`
    pub status: String,
    /// Client-provided metadata (target message, protocol, ...).
    #[ts(type = "Record<string, unknown>")]
    pub meta: Value,
    pub http_status: Option<i64>,
    pub error: Option<String>,
    pub acked: bool,
    pub size: i64,
    pub created_at: i64,
    pub finished_at: Option<i64>,
}

const COLUMNS: &str = "id, chat_id, status, meta, http_status, error, acked, COALESCE(length(body), 0), created_at, finished_at";

fn from_row(row: &Row<'_>) -> rusqlite::Result<JobInfo> {
    Ok(JobInfo {
        id: row.get(0)?,
        chat_id: row.get(1)?,
        status: row.get(2)?,
        meta: row.get(3)?,
        http_status: row.get(4)?,
        error: row.get(5)?,
        acked: row.get(6)?,
        size: row.get(7)?,
        created_at: row.get(8)?,
        finished_at: row.get(9)?,
    })
}

/// Records a new running job. `client` (the starting tab) holds the claim on its result.
pub fn create(
    conn: &Connection,
    user_id: &str,
    id: &str,
    chat_id: Option<&str>,
    meta: &Value,
    client: Option<&str>,
) -> Result<()> {
    let now = now_ms();
    conn.execute(
        "INSERT INTO generation_jobs (id, user_id, chat_id, status, meta, claimed_by, claimed_at, created_at)
         VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, ?6)",
        params![id, user_id, chat_id, json_text(meta), client, now],
    )?;
    Ok(())
}

pub struct Finished<'a> {
    pub status: &'a str,
    pub http_status: Option<u16>,
    pub headers: &'a Value,
    pub body: &'a [u8],
    pub error: Option<&'a str>,
}

pub fn finish(conn: &Connection, id: &str, f: Finished<'_>) -> Result<()> {
    conn.execute(
        // Restarting the claim clock gives the starting tab a head start on storing the result.
        "UPDATE generation_jobs SET status = ?2, http_status = ?3, headers = ?4, body = ?5, error = ?6,
                finished_at = ?7, claimed_at = CASE WHEN claimed_by IS NULL THEN NULL ELSE ?7 END
         WHERE id = ?1",
        params![id, f.status, f.http_status, json_text(f.headers), f.body, f.error, now_ms()],
    )?;
    Ok(())
}

pub fn get(conn: &Connection, user_id: &str, id: &str) -> Result<JobInfo> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM generation_jobs WHERE user_id = ?1 AND id = ?2"),
        params![user_id, id],
        from_row,
    )
    .or_not_found()
}

/// Stored response headers and body of a finished job.
pub fn body(conn: &Connection, user_id: &str, id: &str) -> Result<(Value, Vec<u8>)> {
    conn.query_row(
        "SELECT headers, COALESCE(body, x'') FROM generation_jobs WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .or_not_found()
}

/// Finished jobs that no client has acknowledged yet.
pub fn pending(conn: &Connection, user_id: &str, chat_id: Option<&str>) -> Result<Vec<JobInfo>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM generation_jobs
         WHERE user_id = ?1 AND acked = 0 AND status != 'running' AND (?2 IS NULL OR chat_id = ?2)
         ORDER BY created_at"
    ))?;
    let rows = stmt
        .query_map(params![user_id, chat_id], from_row)?
        .collect::<rusqlite::Result<_>>()?;
    Ok(rows)
}

/// Outcome of [`claim`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Claim {
    /// The caller may store the result now.
    pub claimed: bool,
    /// Another client already stored it (the job is acknowledged).
    pub handled: bool,
}

/// Lets exactly one client store a job's result when several tabs or devices recover it at once.
///
/// The claim succeeds when nobody holds it, the caller already holds it, or the holder has been
/// silent for `grace_ms` (it may have been closed).
pub fn claim(
    conn: &Connection,
    user_id: &str,
    id: &str,
    client: &str,
    grace_ms: i64,
) -> Result<Claim> {
    let now = now_ms();
    let n = conn.execute(
        "UPDATE generation_jobs SET claimed_by = ?3, claimed_at = ?4
         WHERE user_id = ?1 AND id = ?2 AND acked = 0
           AND (claimed_by IS NULL OR claimed_by = ?3 OR claimed_at IS NULL OR claimed_at < ?4 - ?5)",
        params![user_id, id, client, now, grace_ms],
    )?;
    if n == 1 {
        return Ok(Claim {
            claimed: true,
            handled: false,
        });
    }
    let acked: bool = conn
        .query_row(
            "SELECT acked FROM generation_jobs WHERE user_id = ?1 AND id = ?2",
            params![user_id, id],
            |r| r.get(0),
        )
        .or_not_found()?;
    Ok(Claim {
        claimed: false,
        handled: acked,
    })
}

pub fn ack(conn: &Connection, user_id: &str, id: &str) -> Result<()> {
    let n = conn.execute(
        "UPDATE generation_jobs SET acked = 1, body = NULL WHERE user_id = ?1 AND id = ?2",
        params![user_id, id],
    )?;
    super::affected(n)
}

/// Jobs left `running` by a previous process can never finish; mark them failed.
pub fn fail_interrupted(conn: &Connection) -> Result<usize> {
    Ok(conn.execute(
        "UPDATE generation_jobs SET status = 'failed', error = 'interrupted by a server restart', finished_at = ?1
         WHERE status = 'running'",
        [now_ms()],
    )?)
}

/// Deletes acknowledged jobs and anything older than `max_age_ms`.
pub fn purge(conn: &Connection, max_age_ms: i64) -> Result<usize> {
    Ok(conn.execute(
        "DELETE FROM generation_jobs WHERE status != 'running' AND (acked = 1 OR created_at < ?1)",
        [now_ms() - max_age_ms],
    )?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Db, repo::users};
    use serde_json::json;

    fn finished(c: &Connection, id: &str) -> Result<()> {
        finish(
            c,
            id,
            Finished {
                status: "completed",
                http_status: Some(200),
                headers: &json!({}),
                body: b"data",
                error: None,
            },
        )
    }

    #[test]
    fn only_one_client_may_store_a_result() {
        let db = Db::open_in_memory().unwrap();
        db.write_blocking(|c| {
            let user = users::ensure_default(c)?;
            create(c, &user.id, "j1", None, &json!({}), Some("tab-a"))?;
            finished(c, "j1")?;
            // The starting tab has a head start; others must wait.
            assert!(!claim(c, &user.id, "j1", "tab-b", 15_000)?.claimed);
            assert!(claim(c, &user.id, "j1", "tab-a", 15_000)?.claimed);
            // Once the holder is silent for the grace period, someone else may take over.
            assert!(claim(c, &user.id, "j1", "tab-b", -1)?.claimed);
            assert!(!claim(c, &user.id, "j1", "tab-a", 15_000)?.claimed);
            ack(c, &user.id, "j1")?;
            let late = claim(c, &user.id, "j1", "tab-b", 15_000)?;
            assert_eq!(
                late,
                Claim {
                    claimed: false,
                    handled: true
                }
            );

            // Jobs started without a client id can be claimed by anyone, once.
            create(c, &user.id, "j2", None, &json!({}), None)?;
            finished(c, "j2")?;
            assert!(claim(c, &user.id, "j2", "tab-b", 15_000)?.claimed);
            assert!(!claim(c, &user.id, "j2", "tab-c", 15_000)?.claimed);
            Ok(())
        })
        .unwrap();
    }
}
