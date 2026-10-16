#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("not found")]
    NotFound,
    #[error("revision conflict: the stored revision is {current}")]
    Conflict { current: i64 },
    #[error("{0}")]
    Invalid(String),
    /// The name is already used by another item of the same kind.
    #[error("{0}")]
    Exists(String),
    #[error("database task failed: {0}")]
    Task(String),
}

impl StoreError {
    /// A UNIQUE constraint rejected the write (e.g. a name that is already taken).
    pub fn is_unique_violation(&self) -> bool {
        matches!(
            self,
            StoreError::Sqlite(rusqlite::Error::SqliteFailure(e, _))
                if e.extended_code == rusqlite::ffi::SQLITE_CONSTRAINT_UNIQUE
        )
    }
}

pub type Result<T, E = StoreError> = std::result::Result<T, E>;

/// Maps `QueryReturnedNoRows` to [`StoreError::NotFound`].
pub(crate) trait OptionalExt<T> {
    fn or_not_found(self) -> Result<T>;
}

impl<T> OptionalExt<T> for rusqlite::Result<T> {
    fn or_not_found(self) -> Result<T> {
        match self {
            Ok(v) => Ok(v),
            Err(rusqlite::Error::QueryReturnedNoRows) => Err(StoreError::NotFound),
            Err(e) => Err(e.into()),
        }
    }
}
