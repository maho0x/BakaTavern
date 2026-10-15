//! Outgoing API calls on behalf of the client: a generic proxy (secrets are attached here and
//! never sent to the browser) and durable generation jobs.

pub mod jobs;
pub mod proxy;

use axum::{Router, routing};

use crate::state::AppState;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/proxy", routing::post(proxy::proxy))
        .route("/api/llm/jobs", routing::post(jobs::create).get(jobs::list))
        .route(
            "/api/llm/jobs/{id}",
            routing::get(jobs::info).delete(jobs::abort),
        )
        .route("/api/llm/jobs/{id}/stream", routing::get(jobs::stream))
        .route("/api/llm/jobs/{id}/claim", routing::post(jobs::claim))
        .route("/api/llm/jobs/{id}/ack", routing::post(jobs::ack))
}
