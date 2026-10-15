use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

use crate::{Result, StoreError, migrate};

/// Number of idle read connections kept around.
const MAX_IDLE_READERS: usize = 4;

/// SQLite handle: one writer connection plus a small pool of read-only connections (WAL mode
/// lets readers proceed while a write is in progress).
#[derive(Clone)]
pub struct Db {
    inner: Arc<Inner>,
}

struct Inner {
    path: Option<PathBuf>,
    writer: Mutex<Connection>,
    readers: Mutex<Vec<Connection>>,
}

impl Db {
    /// Opens (creating if needed) the database file and applies pending migrations.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let mut writer = Connection::open(&path)?;
        configure(&writer, true)?;
        migrate::run(&mut writer)?;
        Ok(Self::from_parts(Some(path), writer))
    }

    /// A private in-memory database (reads share the writer connection). Intended for tests.
    pub fn open_in_memory() -> Result<Self> {
        let mut writer = Connection::open_in_memory()?;
        configure(&writer, false)?;
        migrate::run(&mut writer)?;
        Ok(Self::from_parts(None, writer))
    }

    fn from_parts(path: Option<PathBuf>, writer: Connection) -> Self {
        Self {
            inner: Arc::new(Inner {
                path,
                writer: Mutex::new(writer),
                readers: Mutex::new(Vec::new()),
            }),
        }
    }

    fn writer(&self) -> MutexGuard<'_, Connection> {
        // A panic while holding the lock cannot leave SQLite in a broken state (any open
        // transaction is rolled back when dropped), so a poisoned lock is safe to reuse.
        self.inner.writer.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Runs `f` on a read connection on the current thread.
    pub fn read_blocking<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let Some(path) = &self.inner.path else {
            return f(&self.writer());
        };
        let pooled = self
            .inner
            .readers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pop();
        let conn = match pooled {
            Some(conn) => conn,
            None => {
                let conn = Connection::open_with_flags(
                    path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                )?;
                configure(&conn, false)?;
                conn
            }
        };
        let out = f(&conn);
        let mut idle = self.inner.readers.lock().unwrap_or_else(|e| e.into_inner());
        if idle.len() < MAX_IDLE_READERS {
            idle.push(conn);
        }
        out
    }

    /// Runs `f` with exclusive access to the writer connection on the current thread.
    pub fn write_blocking<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T>) -> Result<T> {
        f(&mut self.writer())
    }

    /// Runs `f` on a read connection on Tokio's blocking pool.
    pub async fn read<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&Connection) -> Result<T> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.read_blocking(f))
            .await
            .map_err(|e| StoreError::Task(e.to_string()))?
    }

    /// Runs `f` with the writer connection on Tokio's blocking pool.
    pub async fn write<T, F>(&self, f: F) -> Result<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> Result<T> + Send + 'static,
    {
        let db = self.clone();
        tokio::task::spawn_blocking(move || db.write_blocking(f))
            .await
            .map_err(|e| StoreError::Task(e.to_string()))?
    }

    /// Writes a consistent snapshot of the database to `dest` (`VACUUM INTO`).
    pub fn snapshot_to(&self, dest: &Path) -> Result<()> {
        let dest = dest
            .to_str()
            .ok_or_else(|| StoreError::Invalid("non UTF-8 path".into()))?;
        self.writer().execute("VACUUM INTO ?1", [dest])?;
        Ok(())
    }
}

fn configure(conn: &Connection, writer: bool) -> Result<()> {
    conn.busy_timeout(Duration::from_secs(5))?;
    if writer {
        conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get::<_, String>(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
    }
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.pragma_update(None, "cache_size", -16_000)?;
    Ok(())
}
