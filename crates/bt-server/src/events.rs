//! Change notifications pushed to clients over SSE so tabs and devices stay in sync.

use std::convert::Infallible;
use std::time::Duration;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use serde::Serialize;
use tokio::sync::broadcast;
use ts_rs::TS;

use crate::auth::CurrentUser;
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangeEvent {
    #[serde(skip)]
    #[ts(skip)]
    pub user_id: String,
    /// `character` | `chat` | `message` | `persona` | `lorebook` | `preset` | `settings` | `secret` | `tag` | `job`
    pub kind: String,
    /// `created` | `updated` | `deleted`
    pub action: String,
    pub id: String,
    pub rev: Option<i64>,
    pub chat_id: Option<String>,
    /// Client id (`x-bt-client-id`) that caused the change, so it can ignore its own echo.
    pub origin: Option<String>,
}

#[derive(Clone)]
pub struct Events {
    tx: broadcast::Sender<ChangeEvent>,
}

impl Default for Events {
    fn default() -> Self {
        Self {
            tx: broadcast::channel(1024).0,
        }
    }
}

impl Events {
    pub fn publish(&self, event: ChangeEvent) {
        // No subscribers is fine.
        let _ = self.tx.send(event);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ChangeEvent> {
        self.tx.subscribe()
    }
}

/// `GET /api/events`
pub async fn stream(
    State(state): State<AppState>,
    user: CurrentUser,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.events.subscribe();
    let user_id = user.id;
    let stream = futures_util::stream::unfold(rx, move |mut rx| {
        let user_id = user_id.clone();
        async move {
            loop {
                match rx.recv().await {
                    Ok(event) if event.user_id == user_id => {
                        let data = serde_json::to_string(&event).unwrap_or_default();
                        return Some((Ok(Event::default().event("change").data(data)), rx));
                    }
                    Ok(_) => continue,
                    // Too far behind: ask the client to reload its state.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        return Some((Ok(Event::default().event("resync").data("{}")), rx));
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        }
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(20)))
}
