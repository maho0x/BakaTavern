use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bt_formats::FormatError;
use bt_store::StoreError;
use serde_json::json;

/// JSON error response: `{ "error": { "code", "message", "rev"? } }`.
#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub rev: Option<i64>,
}

pub type ApiResult<T> = Result<T, ApiError>;

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            rev: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "bad_request", message)
    }

    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", "not found")
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "login required")
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn bad_gateway(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, "upstream_error", message)
    }

    pub fn internal(err: impl std::fmt::Display) -> Self {
        tracing::error!("internal error: {err}");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal",
            "internal server error",
        )
    }
}

impl From<StoreError> for ApiError {
    fn from(err: StoreError) -> Self {
        match err {
            StoreError::NotFound => Self::not_found(),
            StoreError::Conflict { current } => Self {
                rev: Some(current),
                ..Self::new(
                    StatusCode::CONFLICT,
                    "conflict",
                    "the item was changed elsewhere; reload and retry",
                )
            },
            StoreError::Invalid(msg) => Self::bad_request(msg),
            other => Self::internal(other),
        }
    }
}

impl From<FormatError> for ApiError {
    fn from(err: FormatError) -> Self {
        match err {
            FormatError::Io(e) => Self::internal(e),
            other => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "invalid_format",
                other.to_string(),
            ),
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(err: std::io::Error) -> Self {
        Self::internal(err)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut error = json!({ "code": self.code, "message": self.message });
        if let Some(rev) = self.rev {
            error["rev"] = json!(rev);
        }
        (self.status, Json(json!({ "error": error }))).into_response()
    }
}
