//! Tokenizer files (Hugging Face `tokenizer.json` and SentencePiece models) for the web app's
//! tokenizers. They come from the same places SillyTavern gets them, are downloaded on first use
//! and kept in `<data>/cache/tokenizers`, where they can also be placed by hand.

use std::io::Read;
use std::path::Path as FsPath;

use axum::extract::{Path, State};
use axum::http::header;
use axum::response::{IntoResponse, Response};
use axum::{Router, routing};
use futures_util::StreamExt;

use crate::auth::CurrentUser;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

const ST_TOKENIZERS: &str =
    "https://raw.githubusercontent.com/SillyTavern/SillyTavern/1.19.0/src/tokenizers/";
const ST_DOWNLOADS: &str = "https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/";

/// File name → source. `.gz` sources are unpacked.
const SOURCES: &[(&str, &str, &str)] = &[
    ("llama.model", ST_TOKENIZERS, "llama.model"),
    ("mistral.model", ST_TOKENIZERS, "mistral.model"),
    ("yi.model", ST_TOKENIZERS, "yi.model"),
    ("gemma.model", ST_TOKENIZERS, "gemma.model"),
    ("jamba.model", ST_TOKENIZERS, "jamba.model"),
    ("nerdstash.model", ST_TOKENIZERS, "nerdstash.model"),
    ("nerdstash_v2.model", ST_TOKENIZERS, "nerdstash_v2.model"),
    ("claude.json", ST_TOKENIZERS, "claude.json"),
    ("llama3.json", ST_TOKENIZERS, "llama3.json"),
    ("command-r.json", ST_DOWNLOADS, "command-r.json.gz"),
    ("command-a.json", ST_DOWNLOADS, "command-a.json.gz"),
    ("qwen2.json", ST_DOWNLOADS, "qwen2.json.gz"),
    ("nemo.json", ST_DOWNLOADS, "nemo.json.gz"),
    ("deepseek.json", ST_DOWNLOADS, "deepseek.json.gz"),
];

/// The largest file accepted (Command-R's is about 9 MB unpacked).
const MAX_BYTES: usize = 64 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new().route("/api/tokenizers/{file}", routing::get(file))
}

async fn file(
    State(state): State<AppState>,
    _user: CurrentUser,
    Path(name): Path<String>,
) -> ApiResult<Response> {
    let Some((_, base, source)) = SOURCES.iter().find(|(n, _, _)| *n == name) else {
        return Err(ApiError::not_found());
    };
    let dir = state.config.tokenizers_dir();
    let path = dir.join(&name);
    if !path.exists() {
        if !state.config.tokenizers.download {
            return Err(ApiError::not_found());
        }
        let _one_at_a_time = state.tokenizer_downloads.lock().await;
        if !path.exists() {
            let url = format!("{}{base}{source}", state.config.tokenizers.mirror);
            download(&state, &url, &dir, &path).await?;
        }
    }
    let bytes = tokio::fs::read(&path).await.map_err(ApiError::internal)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "private, max-age=604800"),
        ],
        bytes,
    )
        .into_response())
}

async fn download(state: &AppState, url: &str, dir: &FsPath, path: &FsPath) -> ApiResult<()> {
    let response = state
        .http
        .get(url)
        .send()
        .await
        .map_err(|e| ApiError::bad_gateway(format!("downloading the tokenizer: {e}")))?;
    if !response.status().is_success() {
        return Err(ApiError::bad_gateway(format!(
            "downloading the tokenizer: {}",
            response.status()
        )));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk =
            chunk.map_err(|e| ApiError::bad_gateway(format!("downloading the tokenizer: {e}")))?;
        if body.len() + chunk.len() > MAX_BYTES {
            return Err(ApiError::bad_gateway("the tokenizer file is too large"));
        }
        body.extend_from_slice(&chunk);
    }
    let gzipped = url.ends_with(".gz");
    let (dir, path) = (dir.to_path_buf(), path.to_path_buf());
    tokio::task::spawn_blocking(move || -> ApiResult<()> {
        let bytes = if gzipped {
            let mut out = Vec::new();
            flate2::read::GzDecoder::new(body.as_slice())
                .take(MAX_BYTES as u64)
                .read_to_end(&mut out)
                .map_err(|e| ApiError::bad_gateway(format!("unpacking the tokenizer: {e}")))?;
            out
        } else {
            body
        };
        std::fs::create_dir_all(&dir).map_err(ApiError::internal)?;
        let file = tempfile::NamedTempFile::new_in(&dir).map_err(ApiError::internal)?;
        std::fs::write(file.path(), &bytes).map_err(ApiError::internal)?;
        file.persist(&path).map_err(ApiError::internal)?;
        Ok(())
    })
    .await
    .map_err(ApiError::internal)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_core_tokenizer_file_has_a_source() {
        // Mirrors `tokenizerFiles` in packages/core/src/tokenizers/index.ts.
        for file in [
            "llama.model",
            "mistral.model",
            "yi.model",
            "gemma.model",
            "jamba.model",
            "nerdstash.model",
            "nerdstash_v2.model",
            "claude.json",
            "llama3.json",
            "command-r.json",
            "command-a.json",
            "qwen2.json",
            "nemo.json",
            "deepseek.json",
        ] {
            assert!(SOURCES.iter().any(|(n, _, _)| *n == file), "{file}");
        }
    }
}
