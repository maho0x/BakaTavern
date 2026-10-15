//! Serves the single-page app embedded at build time from `apps/web/dist`.

use axum::http::{HeaderValue, StatusCode, Uri, header};
use axum::response::{Html, IntoResponse, Response};

use crate::error::ApiError;

#[derive(rust_embed::RustEmbed)]
#[folder = "../../apps/web/dist"]
#[allow_missing = true]
struct WebAssets;

const PLACEHOLDER: &str = r#"<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>BakaTavern</title>
<body style="font-family:system-ui;padding:2rem"><h1>BakaTavern</h1>
<p>The server is running, but the web app was not built. Run <code>pnpm --filter @bakatavern/web build</code>
and restart, or use the Vite dev server.</p></body></html>"#;

fn file_response(path: &str, file: rust_embed::EmbeddedFile) -> Response {
    let mut response = file.data.into_owned().into_response();
    let headers = response.headers_mut();
    if let Ok(mime) = HeaderValue::from_str(file.metadata.mimetype()) {
        headers.insert(header::CONTENT_TYPE, mime);
    }
    // Vite fingerprints everything under assets/, so those files never change.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    response
}

pub async fn serve(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    if path == "api" || path.starts_with("api/") {
        return ApiError::not_found().into_response();
    }
    let path = if path.is_empty() { "index.html" } else { path };
    if let Some(file) = WebAssets::get(path) {
        return file_response(path, file);
    }
    // Client-side routes fall back to the app shell; missing files with an extension are 404s.
    let looks_like_file = path
        .rsplit('/')
        .next()
        .is_some_and(|last| last.contains('.'));
    match WebAssets::get("index.html") {
        Some(index) if !looks_like_file => file_response("index.html", index),
        None if !looks_like_file => (StatusCode::OK, Html(PLACEHOLDER)).into_response(),
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}
