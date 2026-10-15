//! BakaTavern persistence: SQLite (WAL) for structured data plus a content-addressed blob store.
//!
//! Repositories are plain synchronous functions over a [`rusqlite::Connection`]; the server runs
//! them through [`Db::read`] / [`Db::write`], which move the work onto Tokio's blocking pool.

pub mod blob;
mod db;
mod error;
mod migrate;
pub mod repo;
pub mod util;

pub use blob::BlobStore;
pub use db::Db;
pub use error::{Result, StoreError};
pub use rusqlite;
