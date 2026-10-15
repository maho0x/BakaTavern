//! Sessions (cookie + hashed token in SQLite), login/logout, and request guards.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::{Json, Router, routing};
use bt_store::repo::{sessions, users};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::crypto;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub const SESSION_COOKIE: &str = "bt_session";
/// Header every state-changing API call must carry. Browsers cannot add custom headers to
/// cross-site requests without a CORS preflight, which unknown origins never pass.
pub const CLIENT_HEADER: &str = "x-bt-client";
/// Optional per-tab id, echoed in change events so a client can ignore its own changes.
pub const CLIENT_ID_HEADER: &str = "x-bt-client-id";

/// The authenticated user of a request.
#[derive(Debug, Clone)]
pub struct CurrentUser {
    pub id: String,
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        authenticate(state, &parts.headers).await
    }
}

/// Resolves the session of a request (the default user when login is not required).
pub async fn authenticate(state: &AppState, headers: &HeaderMap) -> ApiResult<CurrentUser> {
    if !state.config.auth_required() {
        return Ok(CurrentUser {
            id: state.default_user_id.clone(),
        });
    }
    let token = cookie(headers, SESSION_COOKIE).ok_or_else(ApiError::unauthorized)?;
    let hash = crypto::token_hash(&token);
    let user = state.db.read(move |c| sessions::user_for(c, &hash)).await?;
    user.map(|id| CurrentUser { id })
        .ok_or_else(ApiError::unauthorized)
}

/// Value of the `x-bt-client-id` header, if any.
#[derive(Debug, Clone, Default)]
pub struct ClientId(pub Option<String>);

impl<S: Send + Sync> FromRequestParts<S> for ClientId {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        let id = parts
            .headers
            .get(CLIENT_ID_HEADER)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty() && v.len() <= 64)
            .map(str::to_string);
        Ok(Self(id))
    }
}

/// Peer IP address (absent when the router is driven without a socket, e.g. in tests).
#[derive(Debug, Clone, Copy)]
pub struct ClientIp(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(Self(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip()),
        ))
    }
}

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(k, _)| *k == name)
        .map(|(_, v)| v.to_string())
}

/// Rejects state-changing `/api` requests that lack [`CLIENT_HEADER`].
pub async fn csrf_guard(request: Request, next: Next) -> Response {
    let safe = matches!(
        *request.method(),
        Method::GET | Method::HEAD | Method::OPTIONS
    );
    if !safe
        && request.uri().path().starts_with("/api/")
        && !request.headers().contains_key(CLIENT_HEADER)
    {
        return ApiError::forbidden(format!("missing {CLIENT_HEADER} header")).into_response();
    }
    next.run(request).await
}

/// Fixed-window failure counter per IP address.
pub struct RateLimiter {
    failures: Mutex<HashMap<IpAddr, (u32, Instant)>>,
    max: u32,
    window: Duration,
}

impl RateLimiter {
    pub fn new(max: u32, window: Duration) -> Self {
        Self {
            failures: Mutex::new(HashMap::new()),
            max,
            window,
        }
    }

    pub fn allowed(&self, ip: Option<IpAddr>) -> bool {
        let Some(ip) = ip else { return true };
        let mut map = self.failures.lock().unwrap_or_else(|e| e.into_inner());
        match map.get(&ip) {
            Some((_, since)) if since.elapsed() > self.window => {
                map.remove(&ip);
                true
            }
            Some((count, _)) => *count < self.max,
            None => true,
        }
    }

    pub fn fail(&self, ip: Option<IpAddr>) {
        if let Some(ip) = ip {
            let mut map = self.failures.lock().unwrap_or_else(|e| e.into_inner());
            let entry = map.entry(ip).or_insert((0, Instant::now()));
            entry.0 += 1;
        }
    }

    pub fn reset(&self, ip: Option<IpAddr>) {
        if let Some(ip) = ip {
            self.failures
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&ip);
        }
    }
}

#[derive(Debug, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AuthStatus {
    pub auth_required: bool,
    pub user: Option<users::User>,
}

#[derive(Deserialize)]
struct LoginBody {
    handle: Option<String>,
    password: String,
}

fn session_cookie_header(state: &AppState, token: &str, max_age: i64) -> HeaderValue {
    let secure = if state.config.auth.cookie_secure {
        "; Secure"
    } else {
        ""
    };
    HeaderValue::from_str(&format!(
        "{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age}{secure}"
    ))
    .expect("cookie is ASCII")
}

async fn login(
    State(state): State<AppState>,
    ClientIp(ip): ClientIp,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> ApiResult<Response> {
    if !state.login_limiter.allowed(ip) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            "too many failed logins, try later",
        ));
    }
    let handle = body.handle.unwrap_or_else(|| users::DEFAULT_HANDLE.into());
    let lookup = handle.clone();
    let user = state
        .db
        .read(move |c| match users::get_by_handle(c, &lookup)? {
            Some(user) => Ok(Some((users::password_hash(c, &user.id)?, user))),
            None => Ok(None),
        })
        .await?;
    let ok_user = match user {
        Some((Some(hash), user))
            if user.enabled && crypto::verify_password(&body.password, &hash) =>
        {
            Some(user)
        }
        _ => None,
    };
    let Some(user) = ok_user else {
        state.login_limiter.fail(ip);
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "invalid_credentials",
            "wrong user name or password",
        ));
    };
    state.login_limiter.reset(ip);
    let token = crypto::random_token();
    let hash = crypto::token_hash(&token);
    let ttl_ms = i64::from(state.config.auth.session_days) * 86_400_000;
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(200).collect::<String>());
    let user_id = user.id.clone();
    let ip_text = ip.map(|i| i.to_string());
    state
        .db
        .write(move |c| {
            sessions::create(
                c,
                &hash,
                &user_id,
                ttl_ms,
                user_agent.as_deref(),
                ip_text.as_deref(),
            )
        })
        .await?;
    let mut response = Json(AuthStatus {
        auth_required: true,
        user: Some(user),
    })
    .into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        session_cookie_header(&state, &token, ttl_ms / 1000),
    );
    Ok(response)
}

async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    if let Some(token) = cookie(&headers, SESSION_COOKIE) {
        let hash = crypto::token_hash(&token);
        state.db.write(move |c| sessions::delete(c, &hash)).await?;
    }
    let mut response = StatusCode::NO_CONTENT.into_response();
    response
        .headers_mut()
        .insert(header::SET_COOKIE, session_cookie_header(&state, "", 0));
    Ok(response)
}

async fn me(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Json<AuthStatus>> {
    let auth_required = state.config.auth_required();
    let user = match authenticate(&state, &headers).await {
        Ok(current) => Some(state.db.read(move |c| users::get(c, &current.id)).await?),
        Err(_) => None,
    };
    Ok(Json(AuthStatus {
        auth_required,
        user,
    }))
}

#[derive(Deserialize)]
struct PasswordBody {
    current: Option<String>,
    new: String,
}

async fn change_password(
    State(state): State<AppState>,
    user: CurrentUser,
    Json(body): Json<PasswordBody>,
) -> ApiResult<StatusCode> {
    if body.new.chars().count() < 4 {
        return Err(ApiError::bad_request(
            "the password must have at least 4 characters",
        ));
    }
    let user_id = user.id.clone();
    let existing = state
        .db
        .read(move |c| users::password_hash(c, &user_id))
        .await?;
    if let Some(hash) = existing
        && !body
            .current
            .as_deref()
            .is_some_and(|current| crypto::verify_password(current, &hash))
    {
        return Err(ApiError::forbidden("the current password is wrong"));
    }
    let new_hash = crypto::hash_password(&body.new).map_err(ApiError::internal)?;
    state
        .db
        .write(move |c| {
            users::set_password(c, &user.id, Some(&new_hash))?;
            // Log out every other session.
            sessions::delete_for_user(c, &user.id)
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/auth/login", routing::post(login))
        .route("/api/auth/logout", routing::post(logout))
        .route("/api/auth/me", routing::get(me))
        .route("/api/auth/password", routing::post(change_password))
}
