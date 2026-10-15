use std::ops::Deref;
use std::sync::Arc;

use bt_store::repo::{jobs, users};
use bt_store::{BlobStore, Db};

use crate::auth::RateLimiter;
use crate::config::Config;
use crate::crypto::SecretBox;
use crate::events::{ChangeEvent, Events};
use crate::llm::jobs::JobRegistry;
use crate::net::{self, NetPolicy};

pub struct Inner {
    pub config: Config,
    pub db: Db,
    pub blobs: BlobStore,
    pub secrets: SecretBox,
    pub http: reqwest::Client,
    pub net: Arc<NetPolicy>,
    pub events: Events,
    pub jobs: JobRegistry,
    pub default_user_id: String,
    pub login_limiter: RateLimiter,
}

/// Shared application state (cheap to clone).
#[derive(Clone)]
pub struct AppState(Arc<Inner>);

impl Deref for AppState {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        &self.0
    }
}

impl AppState {
    pub fn new(config: Config) -> anyhow::Result<Self> {
        std::fs::create_dir_all(&config.data_dir)?;
        let db = Db::open(config.db_path())?;
        let blobs = BlobStore::new(config.blobs_dir())?;
        let secrets = SecretBox::load_or_create(&config.key_path())?;
        let net = Arc::new(NetPolicy::from_config(&config.network));
        let http = net::build_client(&config.network, net.clone())?;
        let default_user = db.write_blocking(|c| users::ensure_default(c))?;
        let interrupted = db.write_blocking(|c| jobs::fail_interrupted(c))?;
        if interrupted > 0 {
            tracing::warn!(
                interrupted,
                "generation jobs were interrupted by the previous shutdown"
            );
        }
        Ok(Self(Arc::new(Inner {
            jobs: JobRegistry::new(config.limits.max_job_mb * 1024 * 1024),
            config,
            db,
            blobs,
            secrets,
            http,
            net,
            events: Events::default(),
            default_user_id: default_user.id,
            login_limiter: RateLimiter::new(10, std::time::Duration::from_secs(15 * 60)),
        })))
    }

    /// Publishes a change notification to the user's other clients.
    pub fn notify(
        &self,
        user_id: &str,
        kind: &str,
        action: &str,
        id: &str,
        rev: Option<i64>,
        origin: &Option<String>,
    ) {
        self.events.publish(ChangeEvent {
            user_id: user_id.to_string(),
            kind: kind.to_string(),
            action: action.to_string(),
            id: id.to_string(),
            rev,
            chat_id: None,
            origin: origin.clone(),
        });
    }

    pub fn notify_message(
        &self,
        user_id: &str,
        chat_id: &str,
        action: &str,
        id: &str,
        rev: Option<i64>,
        origin: &Option<String>,
    ) {
        self.events.publish(ChangeEvent {
            user_id: user_id.to_string(),
            kind: "message".into(),
            action: action.to_string(),
            id: id.to_string(),
            rev,
            chat_id: Some(chat_id.to_string()),
            origin: origin.clone(),
        });
    }
}
