//! BakaTavern HTTP server. Used as a library by the `bakatavern` CLI and (later) the Tauri shells.

mod attachments;
pub mod auth;
pub mod config;
mod convert;
pub mod crypto;
pub mod error;
pub mod events;
pub mod llm;
mod media;
pub mod net;
mod routes;
pub mod st_export;
pub mod st_import;
pub mod state;
mod web;

use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;

use anyhow::Context;
use axum::extract::DefaultBodyLimit;
use axum::http::Response;
use axum::{Router, middleware, routing};
use bt_store::repo::{jobs, prompt_logs, sessions, users};
use tower_http::compression::CompressionLayer;
use tower_http::compression::predicate::{DefaultPredicate, Predicate};
use tower_http::trace::TraceLayer;

pub use config::Config;
pub use state::AppState;

/// Never compress proxied upstream streams: compression buffers and would delay tokens.
#[derive(Clone, Copy)]
struct CompressPredicate;

impl Predicate for CompressPredicate {
    fn should_compress<B: axum::body::HttpBody>(&self, response: &Response<B>) -> bool {
        !response.headers().contains_key(llm::proxy::UPSTREAM_HEADER)
            && DefaultPredicate::new().should_compress(response)
    }
}

pub fn router(state: AppState) -> Router {
    let upload_limit = (state.config.limits.max_upload_mb as usize).saturating_mul(1024 * 1024);
    Router::new()
        .merge(auth::routes())
        .merge(routes::routes())
        .merge(routes::import_routes(state.config.limits.max_import_mb))
        .merge(llm::routes())
        .route("/api/events", routing::get(events::stream))
        .fallback(web::serve)
        .layer(middleware::from_fn(auth::csrf_guard))
        .layer(DefaultBodyLimit::max(upload_limit))
        .layer(CompressionLayer::new().compress_when(CompressPredicate))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Sets (or clears) the password of a user, creating the default user if needed.
pub fn set_password(
    config: &Config,
    handle: Option<&str>,
    password: Option<&str>,
) -> anyhow::Result<()> {
    std::fs::create_dir_all(&config.data_dir)?;
    let db = bt_store::Db::open(config.db_path())?;
    let hash = password.map(crypto::hash_password).transpose()?;
    db.write_blocking(|c| {
        let user = match handle {
            Some(handle) => users::get_by_handle(c, handle)?.ok_or_else(|| {
                bt_store::StoreError::Invalid(format!("no user named {handle:?}"))
            })?,
            None => users::ensure_default(c)?,
        };
        users::set_password(c, &user.id, hash.as_deref())?;
        sessions::delete_for_user(c, &user.id)
    })?;
    Ok(())
}

/// Imports SillyTavern data from a directory or a backup zip (the `import-st` command).
pub async fn import_st(
    config: Config,
    path: &std::path::Path,
    handle: Option<String>,
    options: st_import::ImportOptions,
) -> anyhow::Result<st_import::StImportReport> {
    let state = AppState::new(config)?;
    let user = state
        .db
        .write(move |c| match handle {
            Some(handle) => users::get_by_handle(c, &handle)?
                .ok_or_else(|| bt_store::StoreError::Invalid(format!("no user named {handle:?}"))),
            None => users::ensure_default(c),
        })
        .await?;
    let temp;
    let dir = if path.is_file() {
        temp = tempfile::tempdir()?;
        st_import::extract_zip(std::fs::File::open(path)?, temp.path())
            .with_context(|| format!("reading {}", path.display()))?;
        temp.path().to_path_buf()
    } else {
        path.to_path_buf()
    };
    st_import::import(&state, &user.id, &dir, options)
        .await
        .map_err(|e| anyhow::anyhow!(e.message))
}

async fn maintenance(state: AppState) {
    let mut interval = tokio::time::interval(Duration::from_secs(3600));
    let retention_ms = state.config.limits.job_retention_days as i64 * 86_400_000;
    let prompt_days = state.config.limits.prompt_log_days as i64;
    loop {
        interval.tick().await;
        let result = state
            .db
            .write(move |c| {
                let prompts = if prompt_days > 0 {
                    prompt_logs::purge(c, prompt_days * 86_400_000)?
                } else {
                    0
                };
                Ok((
                    sessions::purge_expired(c)?,
                    jobs::purge(c, retention_ms)?,
                    prompts,
                ))
            })
            .await;
        match result {
            Ok((sessions, jobs, prompts)) if sessions + jobs + prompts > 0 => {
                tracing::debug!(sessions, jobs, prompts, "purged expired rows")
            }
            Ok(_) => {}
            Err(e) => tracing::warn!("maintenance failed: {e}"),
        }
    }
}

/// Runs the server until `shutdown` resolves.
pub async fn serve(
    config: Config,
    shutdown: impl Future<Output = ()> + Send + 'static,
) -> anyhow::Result<()> {
    if config.auth_required() {
        let db = bt_store::Db::open(config.db_path())?;
        let has_password = db.write_blocking(|c| Ok(users::ensure_default(c)?.has_password))?;
        if !has_password {
            anyhow::bail!(
                "the server listens on {} which is reachable from other devices, so a password is required.\n\
                 Set one with `bakatavern passwd` or the BT_PASSWORD environment variable.",
                config.server.host
            );
        }
    }
    let addr = format!("{}:{}", config.server.host, config.server.port);
    let state = AppState::new(config)?;
    tokio::spawn(maintenance(state.clone()));
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .with_context(|| format!("cannot listen on {addr}"))?;
    let local = listener.local_addr()?;
    tracing::info!(
        "BakaTavern {} is listening on http://{local}",
        env!("CARGO_PKG_VERSION")
    );
    axum::serve(
        listener,
        router(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown)
    .await?;
    Ok(())
}
