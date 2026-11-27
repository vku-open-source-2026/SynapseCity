// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Configuration loaded from the same environment variables as the Python
//! backend.

use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageBackend {
    Dx,
    Base,
    Json,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub storage_backend: StorageBackend,
    pub synapsedx_base_url: String,
    pub synapsedx_api_key: String,
    pub synapsedx_token: String,
    pub tier2_timeout_secs: u64,
    pub synapseone_base_url: String,
    pub synapseone_api_key: String,
    pub sync_shared_secret: Option<String>,
    pub vietmap_api_key: Option<String>,
    pub jwt_secret: String,
    pub access_token_expire_minutes: i64,
    pub refresh_token_expire_days: i64,
    pub admin_username: String,
    pub admin_password: String,
    pub environment: String,
    pub cors_origins: Vec<String>,
    pub trust_proxy_headers: bool,
    pub json_storage_dir: PathBuf,
    pub body_limit_bytes: usize,
    pub request_timeout: Duration,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0}")]
    Invalid(String),
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let environment = env_or("ENVIRONMENT", "development").to_lowercase();
        let production = environment == "production";

        let jwt_secret = env_or("JWT_SECRET_KEY", "");
        if jwt_secret.is_empty()
            || jwt_secret == "your-secret-key-change-this-in-production"
            || jwt_secret.len() < 32
        {
            return Err(ConfigError::Invalid(
                "SECURITY ERROR: Invalid JWT_SECRET_KEY; set a random secret of at least 32 characters"
                    .to_string(),
            ));
        }

        let algorithm = env_or("JWT_ALGORITHM", "HS256").to_uppercase();
        if algorithm != "HS256" {
            return Err(ConfigError::Invalid(format!(
                "JWT_ALGORITHM must be HS256, got {algorithm}"
            )));
        }

        let storage_backend = match env_or("STORAGE_BACKEND", "dx")
            .trim()
            .to_lowercase()
            .as_str()
        {
            "dx" | "tier2" | "synapsedx" => StorageBackend::Dx,
            "base" | "tier1" | "synapseone" => StorageBackend::Base,
            "json" => StorageBackend::Json,
            other => {
                return Err(ConfigError::Invalid(format!(
                    "Unsupported STORAGE_BACKEND '{other}' (expected 'dx', 'base' or 'json')"
                )))
            }
        };
        if production && storage_backend == StorageBackend::Json {
            return Err(ConfigError::Invalid(
                "STORAGE_BACKEND=json is a development fallback and is not allowed in production"
                    .to_string(),
            ));
        }

        let synapsedx_base_url = env_or("SYNAPSEDX_BASE_URL", "https://synapsedx.sbs")
            .trim()
            .trim_end_matches('/')
            .to_string();
        validate_dependency_url(&synapsedx_base_url, production)?;

        let synapsedx_api_key = env_or("SYNAPSEDX_API_KEY", "").trim().to_string();
        let synapsedx_token = env_or("SYNAPSEDX_TOKEN", "").trim().to_string();
        if storage_backend == StorageBackend::Dx
            && synapsedx_api_key.is_empty()
            && synapsedx_token.is_empty()
        {
            return Err(ConfigError::Invalid(
                "SYNAPSEDX_API_KEY or SYNAPSEDX_TOKEN is required when STORAGE_BACKEND=dx"
                    .to_string(),
            ));
        }
        let tier2_timeout_secs = parse_u64("SYNAPSEDX_TIMEOUT_SECS", 20)?.clamp(5, 120);

        // Direct Tier-1 remains available only for the scoped legacy migration
        // and rollback path. Production service traffic uses Tier-2 by default.
        let synapseone_base_url = env_or("SYNAPSEONE_BASE_URL", "https://api.synapseone.space")
            .trim()
            .trim_end_matches('/')
            .to_string();
        validate_dependency_url(&synapseone_base_url, production)?;

        let synapseone_api_key = env_or("SYNAPSEONE_API_KEY", "").trim().to_string();
        if storage_backend == StorageBackend::Base && synapseone_api_key.is_empty() {
            return Err(ConfigError::Invalid(
                "SYNAPSEONE_API_KEY is required when STORAGE_BACKEND=base".to_string(),
            ));
        }

        let admin_username = env_or("ADMIN_USERNAME", "admin");
        let admin_password = env_or("ADMIN_PASSWORD", "admin123");
        if production && (admin_password.is_empty() || admin_password == "admin123") {
            return Err(ConfigError::Invalid(
                "ADMIN_PASSWORD must be changed in production".to_string(),
            ));
        }

        let access_token_expire_minutes = parse_i64("ACCESS_TOKEN_EXPIRE_MINUTES", 60)?;
        let refresh_token_expire_days = parse_i64("REFRESH_TOKEN_EXPIRE_DAYS", 7)?;
        if access_token_expire_minutes <= 0 || refresh_token_expire_days <= 0 {
            return Err(ConfigError::Invalid(
                "token expiry values must be positive".to_string(),
            ));
        }

        let cors_origins = env_or("CORS_ORIGINS", "https://contribution.synapsecity.sbs")
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if cors_origins.is_empty() {
            return Err(ConfigError::Invalid(
                "CORS_ORIGINS must contain at least one origin".to_string(),
            ));
        }

        let bind = env_or("BIND_ADDR", "0.0.0.0:8000");
        let trust_proxy_headers = parse_bool("TRUST_PROXY_HEADERS", true);
        let json_storage_dir = PathBuf::from(env_or("JSON_STORAGE_DIR", "."));
        let body_limit_bytes = parse_usize("BODY_LIMIT_BYTES", 25 * 1024 * 1024)?;
        let request_timeout = Duration::from_secs(parse_u64("REQUEST_TIMEOUT_SECS", 60)?);

        Ok(Self {
            bind,
            storage_backend,
            synapsedx_base_url,
            synapsedx_api_key,
            synapsedx_token,
            tier2_timeout_secs,
            synapseone_base_url,
            synapseone_api_key,
            sync_shared_secret: non_empty(env_or("SYNC_SHARED_SECRET", "")),
            vietmap_api_key: non_empty(env_or("VIETMAP_API_KEY", "")),
            jwt_secret,
            access_token_expire_minutes,
            refresh_token_expire_days,
            admin_username,
            admin_password,
            environment,
            cors_origins,
            trust_proxy_headers,
            json_storage_dir,
            body_limit_bytes,
            request_timeout,
        })
    }

    pub fn production(&self) -> bool {
        self.environment == "production"
    }

    pub fn cors_allow_credentials(&self) -> bool {
        true
    }
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn parse_i64(key: &str, default: i64) -> Result<i64, ConfigError> {
    match std::env::var(key) {
        Ok(value) => value
            .parse()
            .map_err(|_| ConfigError::Invalid(format!("{key} must be an integer"))),
        Err(_) => Ok(default),
    }
}

fn parse_u64(key: &str, default: u64) -> Result<u64, ConfigError> {
    match std::env::var(key) {
        Ok(value) => value
            .parse()
            .map_err(|_| ConfigError::Invalid(format!("{key} must be an integer"))),
        Err(_) => Ok(default),
    }
}

fn parse_usize(key: &str, default: usize) -> Result<usize, ConfigError> {
    match std::env::var(key) {
        Ok(value) => value
            .parse()
            .map_err(|_| ConfigError::Invalid(format!("{key} must be an integer"))),
        Err(_) => Ok(default),
    }
}

fn parse_bool(key: &str, default: bool) -> bool {
    match std::env::var(key) {
        Ok(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        Err(_) => default,
    }
}

/// Validate a dependency endpoint before any credential-bearing client is built.
/// Private Docker names and non-loopback private addresses are always rejected.
/// Loopback is available only through an explicit, non-production opt-in.
pub fn validate_dependency_url(value: &str, production: bool) -> Result<(), ConfigError> {
    let allow_local = parse_bool("ALLOW_LOCAL_DEPENDENCIES", false);
    validate_dependency_url_with_options(value, production, allow_local)
}

fn validate_dependency_url_with_options(
    value: &str,
    production: bool,
    allow_local: bool,
) -> Result<(), ConfigError> {
    if production && allow_local {
        return Err(ConfigError::Invalid(
            "ALLOW_LOCAL_DEPENDENCIES=true is refused in production".to_string(),
        ));
    }
    let parsed = url::Url::parse(value)
        .map_err(|error| ConfigError::Invalid(format!("invalid dependency URL: {error}")))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err(ConfigError::Invalid(
            "dependency URL must not contain credentials".to_string(),
        ));
    }
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ConfigError::Invalid(
            "dependency URL must be http(s)".to_string(),
        ));
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| ConfigError::Invalid("dependency URL has no host".to_string()))?;
    let host = host.trim_matches(['[', ']']);
    let loopback = is_loopback_host(host);
    let parsed_ip = host.parse::<IpAddr>().ok();
    let private_ip = parsed_ip.map(is_private_ip).unwrap_or(false);
    let private_name = parsed_ip.is_none() && is_private_hostname(host);
    if (private_ip || private_name) && !loopback {
        return Err(ConfigError::Invalid(format!(
            "dependency URL may not point at a private host: {host}"
        )));
    }
    if loopback && !allow_local {
        return Err(ConfigError::Invalid(
            "loopback dependency URLs require ALLOW_LOCAL_DEPENDENCIES=true outside production"
                .to_string(),
        ));
    }
    if production && parsed.scheme() != "https" {
        return Err(ConfigError::Invalid(
            "production dependency URL must use https".to_string(),
        ));
    }
    Ok(())
}

fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_private()
                || v4.is_loopback()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || (v4.octets()[0] == 100 && (64..=127).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || v6.is_multicast()
                || v6
                    .to_ipv4_mapped()
                    .map(|mapped| is_private_ip(IpAddr::V4(mapped)))
                    .unwrap_or(false)
        }
    }
}

fn is_loopback_host(host: &str) -> bool {
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .map(|ip| match ip {
                IpAddr::V4(v4) => v4.is_loopback(),
                IpAddr::V6(v6) => {
                    v6.is_loopback()
                        || v6
                            .to_ipv4_mapped()
                            .map(|ip| ip.is_loopback())
                            .unwrap_or(false)
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

#[cfg(test)]
mod tests {
    use super::validate_dependency_url_with_options;

    fn validate(raw: &str, production: bool, allow_local: bool) -> Result<(), String> {
        validate_dependency_url_with_options(raw, production, allow_local)
            .map_err(|e| e.to_string())
    }

    #[test]
    fn accepts_public_https_for_both_dependency_settings() {
        for raw in ["https://synapsedx.sbs", "https://api.synapseone.space"] {
            assert!(validate(raw, true, false).is_ok(), "{raw}");
        }
        assert!(validate("https://[2606:4700:4700::1111]/api", true, false).is_ok());
    }

    #[test]
    fn rejects_http_credentials_and_missing_hosts_in_production() {
        for raw in [
            "http://synapsedx.sbs",
            "https://user:pass@synapsedx.sbs",
            "https://user@synapsedx.sbs",
            "https:///missing-host",
        ] {
            assert!(validate(raw, true, false).is_err(), "{raw}");
        }
    }

    #[test]
    fn rejects_private_addresses_even_with_development_opt_in() {
        for raw in [
            "http://10.0.0.1",
            "http://172.16.0.1",
            "http://192.168.1.1",
            "http://169.254.1.1",
            "http://100.64.0.1",
            "http://0.0.0.0",
            "http://255.255.255.255",
            "http://[fe80::1]",
            "http://[fc00::1]",
            "http://[::ffff:10.0.0.1]",
        ] {
            assert!(validate(raw, false, false).is_err(), "{raw}");
            assert!(validate(raw, false, true).is_err(), "{raw}");
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
            assert!(validate(raw, false, false).is_err(), "{raw}");
            assert!(validate(raw, false, true).is_err(), "{raw}");
        }
    }

    #[test]
    fn loopback_requires_explicit_non_production_opt_in() {
        for raw in [
            "http://127.0.0.1:8082",
            "http://localhost:8082",
            "http://[::1]:8082",
            "http://[::ffff:127.0.0.1]:8082",
        ] {
            assert!(validate(raw, false, false).is_err(), "{raw}");
            assert!(validate(raw, false, true).is_ok(), "{raw}");
            assert!(validate(raw, true, true).is_err(), "{raw}");
        }
    }

    #[test]
    fn refuses_local_dependency_flag_in_production() {
        assert!(validate("https://synapsedx.sbs", true, true)
            .unwrap_err()
            .contains("refused in production"));
    }
}
