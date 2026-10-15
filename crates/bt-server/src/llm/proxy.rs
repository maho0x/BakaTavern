use std::collections::BTreeMap;

use axum::Json;
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderName, HeaderValue, StatusCode, header};
use axum::response::Response;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use bt_store::repo::secrets;
use serde::Deserialize;
use ts_rs::TS;
use url::Url;

use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::net;
use crate::state::AppState;

/// How a stored secret is attached to the upstream request.
#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(tag = "type", rename_all = "camelCase")]
#[ts(export)]
pub enum SecretAuth {
    /// `Authorization: Bearer <key>`
    #[default]
    Bearer,
    /// `<name>: <prefix><key>`, e.g. `x-api-key` (Anthropic) or `x-goog-api-key` (Gemini).
    Header {
        name: String,
        #[serde(default)]
        prefix: String,
    },
    /// `?<name>=<key>`
    Query { name: String },
}

/// An HTTP request the server performs for the client.
#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct ProxyRequest {
    pub url: String,
    /// HTTP method (default `POST`).
    pub method: Option<String>,
    pub headers: Option<BTreeMap<String, String>>,
    /// UTF-8 request body.
    pub body: Option<String>,
    /// Binary request body, base64-encoded (e.g. audio uploads).
    pub body_base64: Option<String>,
    /// Stored API key to attach.
    pub secret_id: Option<String>,
    /// How to attach the secret (default: bearer token).
    pub auth: Option<SecretAuth>,
}

/// Request headers the client may not set.
fn blocked_request_header(name: &str) -> bool {
    matches!(
        name,
        "host"
            | "content-length"
            | "connection"
            | "keep-alive"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "cookie"
            | "expect"
    ) || name.starts_with("proxy-")
}

/// Upstream response headers worth passing back to the client.
pub fn forwarded_response_header(name: &str) -> bool {
    matches!(
        name,
        "content-type" | "retry-after" | "x-request-id" | "request-id" | "cf-ray"
    ) || name.starts_with("x-ratelimit")
        || name.starts_with("anthropic-")
        || name.starts_with("openai-")
}

/// Builds the upstream request: validates the target, filters headers and attaches the secret.
pub async fn prepare(
    state: &AppState,
    user_id: &str,
    req: ProxyRequest,
) -> ApiResult<reqwest::RequestBuilder> {
    let mut url = Url::parse(req.url.trim()).map_err(|_| ApiError::bad_request("invalid URL"))?;
    state.net.check_url(&url).map_err(ApiError::forbidden)?;
    let method = reqwest::Method::from_bytes(
        req.method
            .as_deref()
            .unwrap_or("POST")
            .trim()
            .to_ascii_uppercase()
            .as_bytes(),
    )
    .map_err(|_| ApiError::bad_request("invalid HTTP method"))?;

    let mut headers = reqwest::header::HeaderMap::new();
    for (name, value) in req.headers.iter().flatten() {
        let lower = name.trim().to_ascii_lowercase();
        if blocked_request_header(&lower) {
            continue;
        }
        let name = HeaderName::from_bytes(lower.as_bytes())
            .map_err(|_| ApiError::bad_request("invalid header name"))?;
        let value = HeaderValue::from_str(value)
            .map_err(|_| ApiError::bad_request("invalid header value"))?;
        headers.insert(name, value);
    }

    if let Some(secret_id) = req.secret_id.filter(|s| !s.is_empty()) {
        let user_id = user_id.to_string();
        let material = state
            .db
            .read(move |c| secrets::get(c, &user_id, &secret_id))
            .await?;
        let origin = net::origin_of(&url);
        if !material.info.allowed_origins.contains(&origin) {
            return Err(ApiError::forbidden(format!(
                "the key \"{}\" is not allowed to be sent to {origin}; add this address to the key's allowed origins",
                material.info.label
            )));
        }
        let key = state
            .secrets
            .open(&material.ciphertext)
            .and_then(|bytes| String::from_utf8(bytes).ok())
            .ok_or_else(|| ApiError::internal("stored secret could not be decrypted"))?;
        let header_value = |text: String| {
            HeaderValue::from_str(&text)
                .map_err(|_| ApiError::bad_request("the stored key contains invalid characters"))
        };
        match req.auth.unwrap_or_default() {
            SecretAuth::Bearer => {
                headers.insert(
                    header::AUTHORIZATION,
                    header_value(format!("Bearer {key}"))?,
                );
            }
            SecretAuth::Header { name, prefix } => {
                let name = HeaderName::from_bytes(name.trim().to_ascii_lowercase().as_bytes())
                    .map_err(|_| ApiError::bad_request("invalid auth header name"))?;
                headers.insert(name, header_value(format!("{prefix}{key}"))?);
            }
            SecretAuth::Query { name } => {
                url.query_pairs_mut().append_pair(&name, &key);
            }
        }
    }

    let body = match (req.body, req.body_base64) {
        (Some(text), _) => Some(text.into_bytes()),
        (None, Some(b64)) => Some(
            STANDARD
                .decode(b64)
                .map_err(|_| ApiError::bad_request("invalid base64 body"))?,
        ),
        (None, None) => None,
    };
    let mut builder = state.http.request(method, url).headers(headers);
    if let Some(body) = body {
        builder = builder.body(body);
    }
    Ok(builder)
}

/// Human-readable description of a transport error, including its root cause.
pub fn describe(err: &reqwest::Error) -> String {
    let mut text = if err.is_timeout() {
        "the upstream request timed out".to_string()
    } else if err.is_connect() {
        "could not connect to the upstream server".to_string()
    } else {
        "the upstream request failed".to_string()
    };
    let mut source = std::error::Error::source(err);
    let mut causes = Vec::new();
    while let Some(cause) = source {
        let cause_text = cause.to_string();
        if !causes.contains(&cause_text) {
            causes.push(cause_text);
        }
        source = cause.source();
    }
    if !causes.is_empty() {
        text.push_str(": ");
        text.push_str(&causes.join(": "));
    }
    text
}

/// Marks a response as coming from the upstream (so the client never confuses an upstream 401
/// with its own session expiring).
pub const UPSTREAM_HEADER: &str = "x-bt-upstream";

/// `POST /api/proxy`: performs the request and streams the response back unchanged.
pub async fn proxy(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(req): Json<ProxyRequest>,
) -> ApiResult<Response> {
    let upstream = prepare(&state, &user.id, req)
        .await?
        .send()
        .await
        .map_err(|e| ApiError::bad_gateway(describe(&e)))?;
    let mut response = Response::builder().status(
        StatusCode::from_u16(upstream.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
    );
    for (name, value) in upstream.headers() {
        if forwarded_response_header(name.as_str()) {
            response = response.header(name.as_str(), value.as_bytes());
        }
    }
    response
        .header(UPSTREAM_HEADER, "1")
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(ApiError::internal)
}
