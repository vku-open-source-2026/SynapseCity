// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! City environment and production fail-closed checks.

use std::collections::HashSet;
use std::time::Duration;

use url::Url;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub tier2_url: String,
    pub tier2_api_key: Option<String>,
    pub tier2_token: Option<String>,
    pub tier2_timeout: Duration,
    pub allow_local_dependencies: bool,
    pub auth_secret: String,
    pub auth_secret_ephemeral: bool,
    pub is_production: bool,
    pub auth_mode: String,
    pub demo_enabled: bool,
    pub bootstrap_admins: HashSet<String>,
    pub default_role: String,
    pub access_ttl_seconds: i64,
    pub refresh_ttl_seconds: i64,
    pub cors_origin: String,
    pub public_url: String,
    pub files_max_bytes: usize,
    pub photo_max_bytes: usize,
    pub document_max_bytes: usize,
    pub notification_external: bool,
    pub hitl_required: bool,
    pub approval_sla_minutes: u64,
    pub required_approvals: u32,
    pub maintenance_approver_roles: Vec<String>,
    pub eop_approver_roles: Vec<String>,
    pub dispatch_approver_roles: Vec<String>,
    pub public_rate_limit: u32,
    pub public_ai_rate_limit: u32,
    pub auth_rate_limit: u32,
    pub require_turnstile: bool,
    pub metrics_token: Option<String>,
}

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().map(|value| value.trim().to_string())
}

fn env_bool(name: &str) -> bool {
    matches!(
        env(name).unwrap_or_default().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env(name)
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_u32(name: &str, fallback: u32) -> u32 {
    env(name)
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_list(name: &str, fallback: &str) -> Vec<String> {
    env(name)
        .unwrap_or_else(|| fallback.to_string())
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn is_private_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        std::net::IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_unique_local()
                || v6.is_unicast_link_local()
                || v6.is_multicast()
                || v6
                    .to_ipv4_mapped()
                    .map(|mapped| {
                        mapped.is_private()
                            || mapped.is_loopback()
                            || mapped.is_link_local()
                            || mapped.is_unspecified()
                            || mapped.is_broadcast()
                            || mapped.is_multicast()
                    })
                    .unwrap_or(false)
        }
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| match ip {
                std::net::IpAddr::V4(v4) => v4.is_loopback(),
                std::net::IpAddr::V6(v6) => {
                    v6.is_loopback()
                        || v6.to_ipv4_mapped().map(|mapped| mapped.is_loopback()).unwrap_or(false)
                }
            })
            .unwrap_or(false)
}

fn is_private_hostname(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host == "host.docker.internal"
        || host == "gateway.docker.internal"
        || host.ends_with(".localhost")
        || host.ends_with(".local")
        || host.ends_with(".internal")
        || host.ends_with(".docker")
        || host.ends_with(".svc")
        || host.ends_with(".cluster.local")
        || !host.contains('.')
}

/// Accept a public Tier-2 endpoint. RFC1918/link-local/private Docker names and
/// URLs with embedded credentials are always rejected; loopback is accepted
/// only when `ALLOW_LOCAL_DEPENDENCIES=true` outside production.
fn public_dependency(raw: &str, allow_local: bool, is_production: bool) -> Result<String, String> {
    if is_production && allow_local {
        return Err(
            "ALLOW_LOCAL_DEPENDENCIES=true is refused in production".into(),
        );
    }
    let url = Url::parse(raw)
        .map_err(|error| format!("SYNAPSEDX_BASE_URL is not an absolute URL: {raw} ({error})"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("SYNAPSEDX_BASE_URL must not contain credentials".into());
    }
    let host = url.host_str().unwrap_or("");
    if host.is_empty() {
        return Err("SYNAPSEDX_BASE_URL must include a host".into());
    }
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let loopback = is_loopback_host(host);
    let parsed_ip = host.parse::<std::net::IpAddr>().ok();
    let private_ip = parsed_ip.map(is_private_ip).unwrap_or(false);
    let private_name = parsed_ip.is_none() && is_private_hostname(host);
    if private_ip && !loopback {
        return Err("SYNAPSEDX_BASE_URL must not use a private or link-local address".into());
    }
    if private_name && !loopback {
        return Err("SYNAPSEDX_BASE_URL must not use a private Docker or internal hostname".into());
    }
    if loopback && !allow_local {
        return Err("SYNAPSEDX_BASE_URL must be a public HTTPS endpoint".into());
    }
    if url.scheme() != "https" && !(allow_local && loopback) {
        return Err("SYNAPSEDX_BASE_URL must use HTTPS".into());
    }
    if !matches!(url.scheme(), "http" | "https") {
        return Err("SYNAPSEDX_BASE_URL must use HTTP(S)".into());
    }
    Ok(raw.trim_end_matches('/').to_string())
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let is_production = env("NODE_ENV").as_deref() == Some("production");
        let allow_local = env_bool("ALLOW_LOCAL_DEPENDENCIES");
        let tier2_url = public_dependency(
            &env("SYNAPSEDX_BASE_URL").unwrap_or_else(|| "https://synapsedx.sbs".into()),
            allow_local,
            is_production,
        )?;
        let auth_mode = env("CITY_AUTH_MODE")
            .or_else(|| env("AUTH_MODE"))
            .unwrap_or_else(|| "tier2".into())
            .to_ascii_lowercase();
        let demo_enabled = match env("AUTH_DEMO_MODE").as_deref() {
            Some(value) if value.eq_ignore_ascii_case("true") => true,
            Some(value) if value.eq_ignore_ascii_case("false") => false,
            _ => !is_production,
        };

        let configured_secret = env("AUTH_SECRET").unwrap_or_default();
        let (auth_secret, auth_secret_ephemeral) = if configured_secret.is_empty() {
            if is_production {
                return Err(
                    "AUTH_SECRET must be set in production (an ephemeral secret would invalidate every session on restart)"
                        .into(),
                );
            }
            tracing::warn!(
                "[synapsecity] AUTH_SECRET is not set; using an ephemeral session secret. Existing sessions are invalid after a restart."
            );
            (
                format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                ),
                true,
            )
        } else {
            if configured_secret.len() < 32 {
                tracing::warn!(
                    "[synapsecity] AUTH_SECRET is shorter than 32 characters; use a strong secret in production."
                );
            }
            (configured_secret, false)
        };

        let bootstrap_admins = env("CITY_BOOTSTRAP_ADMIN_EMAILS")
            .unwrap_or_default()
            .split(',')
            .map(|entry| entry.trim().to_ascii_lowercase())
            .filter(|entry| !entry.is_empty())
            .collect();

        let access_ttl = env_u64("AUTH_ACCESS_TTL_SECONDS", 3600).max(60) as i64;
        let refresh_ttl = env_u64("AUTH_REFRESH_TTL_SECONDS", 604_800).max(access_ttl as u64) as i64;
        let files_max = env_u64("CITY_FILES_MAX_BYTES", 10 * 1024 * 1024).max(1024) as usize;

        Ok(Self {
            port: env("PORT")
                .and_then(|value| value.parse::<u16>().ok())
                .unwrap_or(8083),
            tier2_url,
            tier2_api_key: env("SYNAPSEDX_API_KEY").filter(|value| !value.is_empty()),
            tier2_token: env("SYNAPSEDX_TOKEN").filter(|value| !value.is_empty()),
            tier2_timeout: Duration::from_millis(env_u64("SYNAPSEDX_TIMEOUT_MS", 20_000).clamp(1_000, 120_000)),
            allow_local_dependencies: allow_local,
            auth_secret,
            auth_secret_ephemeral,
            is_production,
            auth_mode,
            demo_enabled,
            bootstrap_admins,
            default_role: env("CITY_AUTH_DEFAULT_ROLE")
                .unwrap_or_else(|| "citizen".into())
                .to_ascii_lowercase(),
            access_ttl_seconds: access_ttl,
            refresh_ttl_seconds: refresh_ttl,
            cors_origin: env("CORS_ORIGIN").unwrap_or_else(|| "https://synapsecity.sbs".into()),
            public_url: env("CITY_PUBLIC_URL")
                .unwrap_or_else(|| "https://synapsecity.sbs".into())
                .trim_end_matches('/')
                .to_string(),
            files_max_bytes: files_max,
            photo_max_bytes: env_u64("CITY_PHOTO_MAX_BYTES", files_max as u64).max(1024) as usize,
            document_max_bytes: env_u64("CITY_DOCUMENT_MAX_BYTES", files_max as u64).max(1024) as usize,
            notification_external: env_bool("CITY_NOTIFY_EXTERNAL") || env_bool("SYNAPSEDX_NOTIFY_EXTERNAL"),
            hitl_required: env_bool("CITY_HITL_REQUIRED"),
            approval_sla_minutes: env_u64("CITY_APPROVAL_SLA_MINUTES", 15).clamp(1, 7 * 24 * 60),
            required_approvals: env_u32("CITY_REQUIRED_APPROVALS", 1).clamp(1, 5),
            maintenance_approver_roles: env_list(
                "CITY_MAINTENANCE_APPROVER_ROLES",
                "operations-manager,asset-manager",
            ),
            eop_approver_roles: env_list("CITY_EOP_APPROVER_ROLES", "operations-manager,duty-manager"),
            dispatch_approver_roles: env_list(
                "CITY_DISPATCH_APPROVER_ROLES",
                "operations-manager,duty-manager",
            ),
            public_rate_limit: env_u32("PUBLIC_RATE_LIMIT", 40),
            public_ai_rate_limit: env_u32("PUBLIC_AI_RATE_LIMIT", 20),
            auth_rate_limit: env_u32("AUTH_RATE_LIMIT", 30),
            require_turnstile: env_bool("REQUIRE_TURNSTILE"),
            metrics_token: env("METRICS_TOKEN").filter(|value| !value.is_empty()),
        })
    }

    pub fn demo_auth_allowed(&self) -> bool {
        self.auth_mode == "demo" && self.demo_enabled
    }

    pub fn tier2_client(&self) -> Result<synapsedx::Client, String> {
        let mut credentials = synapsedx::Credentials::none();
        if let Some(token) = &self.tier2_token {
            credentials = credentials.with_token(token.clone());
        }
        if let Some(key) = &self.tier2_api_key {
            credentials = credentials.with_api_key(key.clone());
        }
        synapsedx::Client::builder(self.tier2_url.clone())
            .credentials(credentials)
            .timeout(self.tier2_timeout)
            .retries(1)
            .build()
            .map_err(|error| error.to_string())
    }
}


#[cfg(test)]
impl Config {
    pub fn for_test(tier2_url: impl Into<String>) -> Self {
        Self {
            port: 0,
            tier2_url: tier2_url.into(),
            tier2_api_key: Some("test-key".into()),
            tier2_token: None,
            tier2_timeout: Duration::from_secs(5),
            allow_local_dependencies: true,
            auth_secret: "0123456789012345678901234567890123456789012345678901234567890123".into(),
            auth_secret_ephemeral: false,
            is_production: false,
            auth_mode: "demo".into(),
            demo_enabled: true,
            bootstrap_admins: HashSet::new(),
            default_role: "citizen".into(),
            access_ttl_seconds: 3600,
            refresh_ttl_seconds: 604_800,
            cors_origin: "http://localhost".into(),
            public_url: "http://localhost".into(),
            files_max_bytes: 10 * 1024 * 1024,
            photo_max_bytes: 10 * 1024 * 1024,
            document_max_bytes: 10 * 1024 * 1024,
            notification_external: false,
            hitl_required: false,
            approval_sla_minutes: 15,
            required_approvals: 1,
            maintenance_approver_roles: vec!["asset-manager".into()],
            eop_approver_roles: vec!["duty-manager".into()],
            dispatch_approver_roles: vec!["duty-manager".into()],
            public_rate_limit: 1_000,
            public_ai_rate_limit: 1_000,
            auth_rate_limit: 1_000,
            require_turnstile: false,
            metrics_token: None,
        }
    }
}


#[cfg(test)]
mod tests {
    use super::public_dependency;

    #[test]
    fn accepts_public_https_endpoint() {
        assert_eq!(
            public_dependency("https://synapsedx.sbs", false, true).unwrap(),
            "https://synapsedx.sbs"
        );
        assert_eq!(
            public_dependency("https://[2606:4700:4700::1111]/api", false, true).unwrap(),
            "https://[2606:4700:4700::1111]/api"
        );
    }

    #[test]
    fn rejects_non_https_public_endpoint() {
        assert!(public_dependency("http://synapsedx.sbs", false, true).is_err());
        assert!(public_dependency("http://example.com:8080", false, false).is_err());
    }

    #[test]
    fn rejects_credentials_in_url() {
        assert!(public_dependency("https://user:pass@synapsedx.sbs", false, true).is_err());
        assert!(public_dependency("https://user@synapsedx.sbs", false, true).is_err());
    }

    #[test]
    fn rejects_private_ipv4_and_ipv6() {
        for raw in [
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://192.168.1.1",
            "http://169.254.1.1",
            "http://100.64.0.1",
            "http://0.0.0.0",
            "http://[fe80::1]",
            "http://[fc00::1]",
            "http://[::ffff:10.0.0.1]",
        ] {
            assert!(
                public_dependency(raw, false, false).is_err(),
                "expected rejection for {raw}"
            );
            assert!(
                public_dependency(raw, true, false).is_err(),
                "private address must stay rejected even with allow_local: {raw}"
            );
        }
    }

    #[test]
    fn rejects_private_docker_and_single_label_hosts() {
        for raw in [
            "http://redis:6379",
            "http://city-service:8083",
            "http://host.docker.internal:8082",
            "http://gateway.docker.internal:8082",
            "http://service.local",
            "http://service.internal",
            "http://service.svc",
            "http://service.cluster.local",
        ] {
            assert!(
                public_dependency(raw, false, false).is_err(),
                "expected rejection for {raw}"
            );
            assert!(
                public_dependency(raw, true, false).is_err(),
                "private Docker host must stay rejected with allow_local: {raw}"
            );
        }
    }

    #[test]
    fn loopback_only_with_explicit_dev_opt_in() {
        assert!(public_dependency("http://127.0.0.1:8082", false, false).is_err());
        assert!(public_dependency("http://localhost:8082", false, false).is_err());
        assert!(public_dependency("http://[::1]:8082", false, false).is_err());
        assert_eq!(
            public_dependency("http://127.0.0.1:8082", true, false).unwrap(),
            "http://127.0.0.1:8082"
        );
        assert_eq!(
            public_dependency("http://localhost:8082", true, false).unwrap(),
            "http://localhost:8082"
        );
        assert_eq!(
            public_dependency("http://[::1]:8082", true, false).unwrap(),
            "http://[::1]:8082"
        );
        assert_eq!(
            public_dependency("http://[::ffff:127.0.0.1]:8082", true, false).unwrap(),
            "http://[::ffff:127.0.0.1]:8082"
        );
    }

    #[test]
    fn refuses_local_dependencies_in_production() {
        assert!(public_dependency("http://127.0.0.1:8082", true, true).is_err());
    }
}
