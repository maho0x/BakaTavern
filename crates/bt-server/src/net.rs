//! Outgoing HTTP: TLS roots, optional upstream proxy, and SSRF protection for the API proxy.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use url::{Host, Url};

use crate::config::NetworkSection;

/// Loopback, private, link-local, CGNAT, unique-local and unspecified addresses.
pub fn is_private(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_private_v4(v4),
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            v6.is_loopback()
                || v6.is_unspecified()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80
                || v6.to_ipv4_mapped().is_some_and(|v4| is_private_v4(&v4))
        }
    }
}

fn is_private_v4(ip: &Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || a == 0
        || (a == 100 && (64..128).contains(&b))
}

/// Policy for which destinations the proxy may reach.
#[derive(Debug, Clone)]
pub struct NetPolicy {
    pub allow_private: bool,
    pub whitelist: Vec<String>,
}

impl NetPolicy {
    pub fn from_config(config: &NetworkSection) -> Self {
        Self {
            allow_private: config.allow_private,
            whitelist: config
                .private_whitelist
                .iter()
                .map(|h| h.trim().to_ascii_lowercase())
                .collect(),
        }
    }

    fn whitelisted(&self, host: &str) -> bool {
        let host = host.trim_matches(['[', ']']).to_ascii_lowercase();
        self.whitelist.contains(&host)
    }

    fn private_allowed(&self, host: &str) -> bool {
        self.allow_private || self.whitelisted(host)
    }

    /// Validates a proxy target: http(s) only; private IP literals and `localhost` names only when allowed.
    pub fn check_url(&self, url: &Url) -> Result<(), String> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(format!("unsupported URL scheme {:?}", url.scheme()));
        }
        let Some(host) = url.host() else {
            return Err("the URL has no host".into());
        };
        let host_str = url.host_str().unwrap_or_default();
        let private = match host {
            Host::Ipv4(ip) => is_private_v4(&ip),
            Host::Ipv6(ip) => is_private(&IpAddr::V6(ip)),
            Host::Domain(name) => {
                let name = name.trim_end_matches('.').to_ascii_lowercase();
                name == "localhost" || name.ends_with(".localhost")
            }
        };
        if private && !self.private_allowed(host_str) {
            return Err(format!(
                "requests to the private address {host_str} are disabled"
            ));
        }
        Ok(())
    }
}

/// Resolver that drops private addresses unless the policy allows them, so a public name cannot
/// be pointed at the internal network (DNS rebinding).
struct GuardedResolver {
    policy: Arc<NetPolicy>,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let host = name.as_str().to_string();
        let allow_private = self.policy.private_allowed(&host);
        Box::pin(async move {
            let addrs: Vec<SocketAddr> =
                tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let allowed: Vec<SocketAddr> = addrs
                .into_iter()
                .filter(|a| allow_private || !is_private(&a.ip()))
                .collect();
            if allowed.is_empty() {
                return Err(format!(
                    "{host} resolves only to private addresses, which are disabled"
                )
                .into());
            }
            Ok(Box::new(allowed.into_iter()) as Addrs)
        })
    }
}

fn tls_config() -> anyhow::Result<rustls::ClientConfig> {
    let mut roots = rustls::RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    // System certificates add corporate / self-installed CAs on desktops; failures are harmless.
    for cert in rustls_native_certs::load_native_certs().certs {
        let _ = roots.add(cert);
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()?
        .with_root_certificates(roots)
        .with_no_client_auth();
    config.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
    Ok(config)
}

pub fn build_client(
    config: &NetworkSection,
    policy: Arc<NetPolicy>,
) -> anyhow::Result<reqwest::Client> {
    let redirect_policy = {
        let policy = policy.clone();
        reqwest::redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= 5 {
                attempt.error("too many redirects")
            } else if let Err(e) = policy.check_url(attempt.url()) {
                attempt.error(e)
            } else {
                attempt.follow()
            }
        })
    };
    let mut builder = reqwest::Client::builder()
        .tls_backend_preconfigured(tls_config()?)
        .connect_timeout(Duration::from_secs(config.connect_timeout_secs))
        .read_timeout(Duration::from_secs(config.read_timeout_secs))
        .redirect(redirect_policy)
        .user_agent(concat!("BakaTavern/", env!("CARGO_PKG_VERSION")));
    match config
        .proxy
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        Some(proxy) => builder = builder.proxy(reqwest::Proxy::all(proxy)?),
        None => builder = builder.dns_resolver(Arc::new(GuardedResolver { policy })),
    }
    Ok(builder.build()?)
}

/// `scheme://host[:port]` of a URL, the unit secrets are bound to.
pub fn origin_of(url: &Url) -> String {
    url.origin().ascii_serialization()
}

/// Normalizes a user-supplied origin or URL to `scheme://host[:port]`.
pub fn normalize_origin(input: &str) -> Option<String> {
    let url = Url::parse(input.trim()).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| origin_of(&url))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_addresses() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.1",
            "172.16.5.4",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "::1",
            "fd00::1",
            "fe80::1",
            "::ffff:192.168.1.1",
        ] {
            assert!(is_private(&ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700::1111"] {
            assert!(!is_private(&ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn url_policy() {
        let strict = NetPolicy {
            allow_private: false,
            whitelist: vec!["192.168.1.5".into()],
        };
        let ok = |u: &str| strict.check_url(&Url::parse(u).unwrap()).is_ok();
        assert!(ok("https://api.openai.com/v1/chat/completions"));
        assert!(!ok("http://127.0.0.1:5001/api"));
        assert!(!ok("http://localhost:11434"));
        assert!(!ok("http://[::1]/"));
        assert!(ok("http://192.168.1.5:5000/v1"));
        assert!(!ok("file:///etc/passwd"));
        let open = NetPolicy {
            allow_private: true,
            whitelist: vec![],
        };
        assert!(
            open.check_url(&Url::parse("http://localhost:5001").unwrap())
                .is_ok()
        );
        assert_eq!(
            normalize_origin("https://API.example.com:443/v1/").as_deref(),
            Some("https://api.example.com")
        );
        assert_eq!(normalize_origin("ftp://x"), None);
    }
}
