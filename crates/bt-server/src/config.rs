//! Server configuration: `<data dir>/config.toml`, overridden by `BT_*` environment variables and
//! command line flags.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use anyhow::Context;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    #[serde(skip)]
    pub data_dir: PathBuf,
    pub server: ServerSection,
    pub auth: AuthSection,
    pub network: NetworkSection,
    pub limits: LimitsSection,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerSection {
    pub host: String,
    pub port: u16,
    /// Extra origins allowed to call the API cross-origin (e.g. a separately hosted UI).
    pub cors_origins: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthMode {
    /// No login when listening on loopback only; a password otherwise.
    Auto,
    /// Never ask for a login. Only sensible behind an authenticating reverse proxy.
    None,
    /// Always require a login.
    Password,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthSection {
    pub mode: AuthMode,
    pub session_days: u32,
    /// Mark the session cookie `Secure` (set when served over HTTPS).
    pub cookie_secure: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct NetworkSection {
    /// Outgoing proxy for LLM/API requests, e.g. `http://127.0.0.1:7890` or `socks5h://127.0.0.1:1080`.
    pub proxy: Option<String>,
    /// Let the API proxy reach private, loopback and link-local addresses (local backends such as
    /// KoboldCpp, Ollama or llama.cpp live there).
    pub allow_private: bool,
    /// Hosts or IP addresses that stay reachable when `allow_private` is false.
    pub private_whitelist: Vec<String>,
    pub connect_timeout_secs: u64,
    /// Idle timeout while waiting for upstream response bytes.
    pub read_timeout_secs: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct LimitsSection {
    pub max_upload_mb: u64,
    /// Largest upstream response a generation job will buffer.
    pub max_job_mb: u64,
    /// Days to keep finished generation jobs that no client acknowledged.
    pub job_retention_days: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            data_dir: PathBuf::from("data"),
            server: ServerSection::default(),
            auth: AuthSection::default(),
            network: NetworkSection::default(),
            limits: LimitsSection::default(),
        }
    }
}

impl Default for ServerSection {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 8800,
            cors_origins: Vec::new(),
        }
    }
}

impl Default for AuthSection {
    fn default() -> Self {
        Self {
            mode: AuthMode::Auto,
            session_days: 30,
            cookie_secure: false,
        }
    }
}

impl Default for NetworkSection {
    fn default() -> Self {
        Self {
            proxy: None,
            allow_private: true,
            private_whitelist: Vec::new(),
            connect_timeout_secs: 30,
            read_timeout_secs: 600,
        }
    }
}

impl Default for LimitsSection {
    fn default() -> Self {
        Self {
            max_upload_mb: 200,
            max_job_mb: 16,
            job_retention_days: 7,
        }
    }
}

pub const CONFIG_FILE: &str = "config.toml";

const TEMPLATE: &str = r#"# BakaTavern configuration. Environment variables (BT_HOST, BT_PORT, BT_AUTH_MODE, BT_PROXY,
# BT_ALLOW_PRIVATE) and command line flags override these values.

[server]
host = "127.0.0.1"   # use "0.0.0.0" to accept connections from other devices (a password is then required)
port = 8800

[auth]
mode = "auto"        # auto: login only when not bound to loopback | password | none
session_days = 30
cookie_secure = false

[network]
# proxy = "http://127.0.0.1:7890"
allow_private = true # let the API proxy reach local backends (KoboldCpp, Ollama, ...)
private_whitelist = []
connect_timeout_secs = 30
read_timeout_secs = 600

[limits]
max_upload_mb = 200
max_job_mb = 16
job_retention_days = 7
"#;

impl Config {
    /// Loads `<data_dir>/config.toml`, writing a commented template on first run.
    pub fn load(data_dir: &Path) -> anyhow::Result<Self> {
        let path = data_dir.join(CONFIG_FILE);
        let mut config: Config = if path.exists() {
            let text = std::fs::read_to_string(&path)
                .with_context(|| format!("reading {}", path.display()))?;
            toml::from_str(&text).with_context(|| format!("parsing {}", path.display()))?
        } else {
            std::fs::create_dir_all(data_dir)?;
            std::fs::write(&path, TEMPLATE)
                .with_context(|| format!("writing {}", path.display()))?;
            Config::default()
        };
        config.data_dir = data_dir.to_path_buf();
        config.apply_env()?;
        Ok(config)
    }

    fn apply_env(&mut self) -> anyhow::Result<()> {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        if let Some(host) = var("BT_HOST") {
            self.server.host = host;
        }
        if let Some(port) = var("BT_PORT") {
            self.server.port = port.parse().context("BT_PORT must be a port number")?;
        }
        if let Some(mode) = var("BT_AUTH_MODE") {
            self.auth.mode = toml::Value::String(mode)
                .try_into()
                .context("BT_AUTH_MODE must be auto, none or password")?;
        }
        if let Some(proxy) = var("BT_PROXY") {
            self.network.proxy = Some(proxy);
        }
        if let Some(allow) = var("BT_ALLOW_PRIVATE") {
            self.network.allow_private = matches!(
                allow.to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            );
        }
        Ok(())
    }

    /// True when the server only listens on a loopback address.
    pub fn is_loopback(&self) -> bool {
        let host = self.server.host.trim_matches(['[', ']']);
        host.eq_ignore_ascii_case("localhost")
            || host.parse::<IpAddr>().is_ok_and(|ip| ip.is_loopback())
    }

    pub fn auth_required(&self) -> bool {
        match self.auth.mode {
            AuthMode::None => false,
            AuthMode::Password => true,
            AuthMode::Auto => !self.is_loopback(),
        }
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("bakatavern.db")
    }

    pub fn blobs_dir(&self) -> PathBuf {
        self.data_dir.join("blobs")
    }

    pub fn cache_dir(&self) -> PathBuf {
        self.data_dir.join("cache")
    }

    pub fn key_path(&self) -> PathBuf {
        self.data_dir.join("secret.key")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn template_parses_to_defaults() {
        let parsed: Config = toml::from_str(TEMPLATE).unwrap();
        let default = Config::default();
        assert_eq!(parsed.server.port, default.server.port);
        assert_eq!(parsed.auth.mode, AuthMode::Auto);
        assert!(parsed.is_loopback());
        assert!(!parsed.auth_required());
    }

    #[test]
    fn public_hosts_require_auth() {
        let mut config = Config::default();
        config.server.host = "0.0.0.0".into();
        assert!(config.auth_required());
        config.server.host = "[::1]".into();
        assert!(!config.auth_required());
    }
}
