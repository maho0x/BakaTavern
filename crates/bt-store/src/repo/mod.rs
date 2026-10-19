//! Repositories: synchronous functions over a SQLite connection. Every function that touches
//! user-owned rows takes the owning `user_id` and filters on it.

pub mod characters;
pub mod chats;
pub mod files;
pub mod groups;
pub mod jobs;
pub mod lorebooks;
pub mod messages;
pub mod personas;
pub mod presets;
pub mod prompt_logs;
pub mod search;
pub mod secrets;
pub mod sessions;
pub mod settings;
pub mod tags;
pub mod users;

use crate::{Result, StoreError};

/// Checks an optimistic-concurrency revision.
pub(crate) fn check_rev(current: i64, expected: Option<i64>) -> Result<()> {
    match expected {
        Some(expected) if expected != current => Err(StoreError::Conflict { current }),
        _ => Ok(()),
    }
}

/// Returns `Err(NotFound)` when an UPDATE/DELETE touched no rows.
pub(crate) fn affected(n: usize) -> Result<()> {
    if n == 0 {
        Err(StoreError::NotFound)
    } else {
        Ok(())
    }
}
