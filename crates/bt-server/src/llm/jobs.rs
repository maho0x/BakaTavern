//! Durable generation jobs.
//!
//! The upstream request runs in its own task, independent of the HTTP connection that started it.
//! Bytes are buffered in memory while the job runs (clients can attach at any byte offset) and the
//! complete response is written to SQLite when it ends, so a reply survives a dropped connection
//! (locked phone screen, closed tab) until a client acknowledges it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{Path, Query, State};
use axum::http::{StatusCode, header};
use axum::response::Response;
use bt_store::StoreError;
use bt_store::repo::jobs::{self as job_repo, JobInfo};
use bt_store::util::{new_id, now_ms};
use futures_util::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;
use ts_rs::TS;

use super::proxy::{self, ProxyRequest, UPSTREAM_HEADER};
use crate::auth::{ClientId, CurrentUser};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

/// How long a finished job stays attachable in memory before readers fall back to the database.
const LINGER: Duration = Duration::from_secs(60);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Completed,
    Failed(String),
    Aborted,
}

impl Outcome {
    fn status(&self) -> &'static str {
        match self {
            Outcome::Completed => "completed",
            Outcome::Failed(_) => "failed",
            Outcome::Aborted => "aborted",
        }
    }
}

#[derive(Debug, Default, Clone)]
pub struct JobState {
    pub buf: Vec<u8>,
    pub http_status: Option<u16>,
    pub headers: Vec<(String, String)>,
    pub done: Option<Outcome>,
}

pub struct RunningJob {
    pub id: String,
    pub user_id: String,
    pub chat_id: Option<String>,
    pub meta: Value,
    pub created_at: i64,
    state: watch::Sender<JobState>,
    cancel: CancellationToken,
}

impl RunningJob {
    fn info(&self) -> JobInfo {
        let state = self.state.borrow();
        JobInfo {
            id: self.id.clone(),
            chat_id: self.chat_id.clone(),
            status: state
                .done
                .as_ref()
                .map_or("running", Outcome::status)
                .to_string(),
            meta: self.meta.clone(),
            http_status: state.http_status.map(i64::from),
            error: match &state.done {
                Some(Outcome::Failed(e)) => Some(e.clone()),
                _ => None,
            },
            acked: false,
            size: state.buf.len() as i64,
            created_at: self.created_at,
            finished_at: None,
        }
    }
}

pub struct JobRegistry {
    jobs: Mutex<HashMap<String, Arc<RunningJob>>>,
    /// Ids aborted before their job was registered (a Stop that overtook the start request),
    /// with the time they were recorded.
    tombstones: Mutex<HashMap<String, i64>>,
    max_bytes: u64,
}

/// How long an early abort is remembered.
const TOMBSTONE_MS: i64 = 120_000;

impl JobRegistry {
    pub fn new(max_bytes: u64) -> Self {
        Self {
            jobs: Mutex::new(HashMap::new()),
            tombstones: Mutex::new(HashMap::new()),
            max_bytes,
        }
    }

    fn bury(&self, id: &str) {
        let now = now_ms();
        let mut tombstones = self.tombstones.lock().unwrap_or_else(|e| e.into_inner());
        tombstones.retain(|_, at| now - *at < TOMBSTONE_MS);
        tombstones.insert(id.to_string(), now);
    }

    fn is_buried(&self, id: &str) -> bool {
        let tombstones = self.tombstones.lock().unwrap_or_else(|e| e.into_inner());
        tombstones
            .get(id)
            .is_some_and(|at| now_ms() - *at < TOMBSTONE_MS)
    }

    fn get(&self, user_id: &str, id: &str) -> Option<Arc<RunningJob>> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.get(id).filter(|j| j.user_id == user_id).cloned()
    }

    fn insert(&self, job: Arc<RunningJob>) {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(job.id.clone(), job);
    }

    fn remove(&self, id: &str) {
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(id);
    }

    fn running_for(&self, user_id: &str, chat_id: Option<&str>) -> Vec<JobInfo> {
        let jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.values()
            .filter(|j| {
                j.user_id == user_id && (chat_id.is_none() || j.chat_id.as_deref() == chat_id)
            })
            .filter(|j| j.state.borrow().done.is_none())
            .map(|j| j.info())
            .collect()
    }
}

#[derive(Debug, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct JobRequest {
    /// Client-chosen id (16–64 of `[A-Za-z0-9_-]`), so the job can be aborted before the
    /// response arrives. The server picks one when it is missing.
    pub id: Option<String>,
    #[serde(flatten)]
    pub request: ProxyRequest,
    pub chat_id: Option<String>,
    /// Client metadata stored with the job (target message, protocol, ...).
    #[ts(optional, type = "Record<string, unknown>")]
    pub meta: Option<Value>,
}

async fn run(state: AppState, job: Arc<RunningJob>, request: reqwest::RequestBuilder) {
    let max_bytes = state.jobs.max_bytes as usize;
    let sent = tokio::select! {
        _ = job.cancel.cancelled() => Err(Outcome::Aborted),
        res = request.send() => res.map_err(|e| Outcome::Failed(proxy::describe(&e))),
    };
    let outcome = match sent {
        Err(outcome) => outcome,
        Ok(response) => {
            let headers = response
                .headers()
                .iter()
                .filter(|(name, _)| proxy::forwarded_response_header(name.as_str()))
                .filter_map(|(name, value)| {
                    Some((name.to_string(), value.to_str().ok()?.to_string()))
                })
                .collect();
            let status = response.status().as_u16();
            job.state.send_modify(|s| {
                s.http_status = Some(status);
                s.headers = headers;
            });
            let mut body = response.bytes_stream();
            loop {
                tokio::select! {
                    _ = job.cancel.cancelled() => break Outcome::Aborted,
                    chunk = body.next() => match chunk {
                        Some(Ok(bytes)) => {
                            let too_large = job.state.borrow().buf.len() + bytes.len() > max_bytes;
                            if too_large {
                                break Outcome::Failed("the response exceeded the size limit".into());
                            }
                            job.state.send_modify(|s| s.buf.extend_from_slice(&bytes));
                        }
                        Some(Err(e)) => break Outcome::Failed(proxy::describe(&e)),
                        None => break Outcome::Completed,
                    }
                }
            }
        }
    };

    let snapshot = job.state.borrow().clone();
    let headers = Value::Object(
        snapshot
            .headers
            .iter()
            .map(|(k, v)| (k.clone(), json!(v)))
            .collect::<Map<_, _>>(),
    );
    let id = job.id.clone();
    let error = match &outcome {
        Outcome::Failed(e) => Some(e.clone()),
        _ => None,
    };
    let status = outcome.status();
    let persisted = state
        .db
        .write(move |c| {
            job_repo::finish(
                c,
                &id,
                job_repo::Finished {
                    status,
                    http_status: snapshot.http_status,
                    headers: &headers,
                    body: &snapshot.buf,
                    error: error.as_deref(),
                },
            )
        })
        .await;
    if let Err(e) = persisted {
        tracing::error!(job = %job.id, "could not store the generation result: {e}");
    }
    job.state.send_modify(|s| s.done = Some(outcome));
    state.events.publish(crate::events::ChangeEvent {
        user_id: job.user_id.clone(),
        kind: "job".into(),
        action: "updated".into(),
        id: job.id.clone(),
        rev: None,
        chat_id: job.chat_id.clone(),
        origin: None,
    });
    tokio::time::sleep(LINGER).await;
    state.jobs.remove(&job.id);
}

/// Streams the job's bytes from `offset`, following it live until it ends.
fn live_stream(
    job: Arc<RunningJob>,
    offset: usize,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    let rx = job.state.subscribe();
    futures_util::stream::unfold((rx, offset), |(mut rx, mut offset)| async move {
        loop {
            let (chunk, done) = {
                let s = rx.borrow_and_update();
                let chunk =
                    (s.buf.len() > offset).then(|| Bytes::copy_from_slice(&s.buf[offset..]));
                (chunk, s.done.is_some())
            };
            if let Some(chunk) = chunk {
                offset += chunk.len();
                return Some((Ok(chunk), (rx, offset)));
            }
            if done || rx.changed().await.is_err() {
                return None;
            }
        }
    })
}

fn stream_response(
    job_id: &str,
    http_status: u16,
    headers: &[(String, String)],
    body: Body,
) -> ApiResult<Response> {
    let mut response = Response::builder()
        .status(StatusCode::from_u16(http_status).unwrap_or(StatusCode::BAD_GATEWAY));
    for (name, value) in headers {
        response = response.header(name.as_str(), value.as_str());
    }
    response
        .header("x-bt-job-id", job_id)
        .header(UPSTREAM_HEADER, "1")
        .header(header::CACHE_CONTROL, "no-cache")
        .header("x-accel-buffering", "no")
        .body(body)
        .map_err(ApiError::internal)
}

/// Waits until the upstream answered (status known) or the job ended.
async fn wait_for_headers(job: &RunningJob) -> JobState {
    let mut rx = job.state.subscribe();
    loop {
        {
            let s = rx.borrow_and_update();
            if s.http_status.is_some() || s.done.is_some() {
                return s.clone();
            }
        }
        if rx.changed().await.is_err() {
            return job.state.borrow().clone();
        }
    }
}

/// `POST /api/llm/jobs`: starts a job and streams its response.
pub async fn create(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Json(req): Json<JobRequest>,
) -> ApiResult<Response> {
    let id = match req.id {
        Some(id) if valid_job_id(&id) => id,
        Some(_) => return Err(ApiError::bad_request("invalid job id")),
        None => new_id(),
    };
    if state.jobs.is_buried(&id) {
        return Err(aborted());
    }
    let request = proxy::prepare(&state, &user.id, req.request).await?;
    let meta = req
        .meta
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    {
        let (id, user_id, chat_id, meta, client) = (
            id.clone(),
            user.id.clone(),
            req.chat_id.clone(),
            meta.clone(),
            origin.clone(),
        );
        state
            .db
            .write(move |c| {
                job_repo::create(
                    c,
                    &user_id,
                    &id,
                    chat_id.as_deref(),
                    &meta,
                    client.as_deref(),
                )
            })
            .await?;
    }
    let job = Arc::new(RunningJob {
        id: id.clone(),
        user_id: user.id.clone(),
        chat_id: req.chat_id,
        meta,
        created_at: now_ms(),
        state: watch::Sender::new(JobState::default()),
        cancel: CancellationToken::new(),
    });
    state.jobs.insert(job.clone());
    state.notify(&user.id, "job", "created", &id, None, &origin);
    tokio::spawn(run(state.clone(), job.clone(), request));

    let started = wait_for_headers(&job).await;
    match (started.http_status, started.done) {
        (Some(status), _) => stream_response(
            &id,
            status,
            &started.headers,
            Body::from_stream(live_stream(job, 0)),
        ),
        (None, Some(Outcome::Failed(message))) => {
            // Nothing to recover later: the client gets the error right away.
            let user_id = user.id.clone();
            let job_id = id.clone();
            let _ = state
                .db
                .write(move |c| job_repo::ack(c, &user_id, &job_id))
                .await;
            Err(ApiError::bad_gateway(message))
        }
        _ => Err(aborted()),
    }
}

fn aborted() -> ApiError {
    ApiError::new(
        StatusCode::CONFLICT,
        "aborted",
        "the generation was aborted",
    )
}

fn valid_job_id(id: &str) -> bool {
    (16..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Deserialize)]
pub struct StreamQuery {
    #[serde(default)]
    offset: usize,
}

/// `GET /api/llm/jobs/{id}/stream?offset=N`: resumes a running job or replays a finished one.
pub async fn stream(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(query): Query<StreamQuery>,
) -> ApiResult<Response> {
    if let Some(job) = state.jobs.get(&user.id, &id) {
        let started = wait_for_headers(&job).await;
        if let Some(status) = started.http_status {
            return stream_response(
                &id,
                status,
                &started.headers,
                Body::from_stream(live_stream(job, query.offset)),
            );
        }
    }
    let (info, headers, body) = {
        let (user_id, id) = (user.id.clone(), id.clone());
        state
            .db
            .read(move |c| {
                let info = job_repo::get(c, &user_id, &id)?;
                let (headers, body) = job_repo::body(c, &user_id, &id)?;
                Ok((info, headers, body))
            })
            .await?
    };
    let Some(status) = info.http_status else {
        return Err(ApiError::bad_gateway(
            info.error
                .unwrap_or_else(|| "the generation produced no response".into()),
        ));
    };
    let headers: Vec<(String, String)> = headers
        .as_object()
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let rest = body
        .get(query.offset.min(body.len())..)
        .unwrap_or_default()
        .to_vec();
    stream_response(&id, status as u16, &headers, Body::from(rest))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListQuery {
    chat_id: Option<String>,
}

/// `GET /api/llm/jobs?chatId=`: running jobs plus finished ones nobody acknowledged.
pub async fn list(
    State(state): State<AppState>,
    user: CurrentUser,
    Query(query): Query<ListQuery>,
) -> ApiResult<Json<Vec<JobInfo>>> {
    let mut jobs = state.jobs.running_for(&user.id, query.chat_id.as_deref());
    let running: Vec<String> = jobs.iter().map(|j| j.id.clone()).collect();
    let user_id = user.id.clone();
    let pending = state
        .db
        .read(move |c| job_repo::pending(c, &user_id, query.chat_id.as_deref()))
        .await?;
    jobs.extend(pending.into_iter().filter(|j| !running.contains(&j.id)));
    Ok(Json(jobs))
}

pub async fn info(
    State(state): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
) -> ApiResult<Json<JobInfo>> {
    if let Some(job) = state.jobs.get(&user.id, &id)
        && job.state.borrow().done.is_none()
    {
        return Ok(Json(job.info()));
    }
    Ok(Json(
        state
            .db
            .read(move |c| job_repo::get(c, &user.id, &id))
            .await?,
    ))
}

/// How long the tab that started a job keeps the exclusive right to store its result.
const CLAIM_GRACE_MS: i64 = 15_000;

/// `POST /api/llm/jobs/{id}/claim`: asks for the right to store a finished job's result, so that
/// two tabs recovering the same reply do not both save it.
pub async fn claim(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<Json<job_repo::Claim>> {
    let client = origin.unwrap_or_default();
    let claim = state
        .db
        .write(move |c| job_repo::claim(c, &user.id, &id, &client, CLAIM_GRACE_MS))
        .await?;
    Ok(Json(claim))
}

/// `POST /api/llm/jobs/{id}/ack`: the client has stored the result; the raw response can go.
pub async fn ack(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    let (user_id, job_id) = (user.id.clone(), id.clone());
    state
        .db
        .write(move |c| job_repo::ack(c, &user_id, &job_id))
        .await?;
    state.notify(&user.id, "job", "deleted", &id, None, &origin);
    Ok(StatusCode::NO_CONTENT)
}

/// `DELETE /api/llm/jobs/{id}`: aborts a running job (or discards a finished one).
pub async fn abort(
    State(state): State<AppState>,
    user: CurrentUser,
    ClientId(origin): ClientId,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if let Some(job) = state.jobs.get(&user.id, &id) {
        job.cancel.cancel();
        return Ok(StatusCode::ACCEPTED);
    }
    let (user_id, job_id) = (user.id.clone(), id.clone());
    let acked = state
        .db
        .write(move |c| job_repo::ack(c, &user_id, &job_id))
        .await;
    match acked {
        Ok(()) => {
            state.notify(&user.id, "job", "deleted", &id, None, &origin);
            Ok(StatusCode::NO_CONTENT)
        }
        // The start request may still be on its way: make sure it never runs.
        Err(StoreError::NotFound) if valid_job_id(&id) => {
            state.jobs.bury(&id);
            Ok(StatusCode::NO_CONTENT)
        }
        Err(e) => Err(e.into()),
    }
}
