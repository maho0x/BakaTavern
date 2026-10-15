//! SillyTavern-compatible import/export formats. Pure transformations over bytes and JSON; no I/O.

pub mod card;
pub mod charx;
pub mod chat;
pub mod date;
pub mod png;
pub mod worldinfo;

#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error("not a PNG file")]
    NotPng,
    #[error("corrupt PNG: {0}")]
    CorruptPng(&'static str),
    #[error("no character data found in the image")]
    NoCharacterData,
    #[error("invalid base64 payload")]
    Base64,
    #[error("invalid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid archive: {0}")]
    Zip(#[from] zip::result::ZipError),
    #[error("i/o error: {0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T, E = FormatError> = std::result::Result<T, E>;
