// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Configuration loaded from the same environment variables as the Python
//! backend.

use std::net::IpAddr;
use std::path::PathBuf;
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StorageBackend {
    Base,
    Json,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub bind: String,
    pub storage_backend: StorageBackend,
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

        let storage_backend = match env_or("STORAGE_BACKEND", "base")
            .trim()
            .to_lowercase()
            .as_str()
        {
            "base" => StorageBackend::Base,
            "json" => StorageBackend::Json,
            other => {
                return Err(ConfigError::Invalid(format!(
                    "Unsupported STORAGE_BACKEND '{other}' (expected 'base' or 'json')"
                )))
            }
        };
        if production && storage_backend == StorageBackend::Json {
            return Err(ConfigError::Invalid(
                "STORAGE_BACKEND=json is a development fallback and is not allowed in production"
                    .to_string(),
            ));
        }

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

/// Production dependencies must be public HTTPS endpoints. Local test
/// overrides are explicitly opt-in.
fn validate_dependency_url(value: &str, production: bool) -> Result<(), ConfigError> {
    let parsed = url::Url::parse(value)
        .map_err(|error| ConfigError::Invalid(format!("invalid dependency URL: {error}")))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(ConfigError::Invalid(
            "dependency URL must be http(s)".to_string(),
        ));
    }
    let allow_local = std::env::var("ALLOW_LOCAL_DEPENDENCIES")
        .map(|value| matches!(value.as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    if allow_local {
        return Ok(());
    }
    if production {
        if parsed.scheme() != "https" {
            return Err(ConfigError::Invalid(
                "production dependency URL must use https".to_string(),
            ));
        }
        let host = parsed
            .host_str()
            .ok_or_else(|| ConfigError::Invalid("dependency URL has no host".to_string()))?;
        if is_private_host(host) {
            return Err(ConfigError::Invalid(format!(
                "production dependency URL may not point at a private host: {host}"
            )));
        }
    }
    Ok(())
}

fn is_private_host(host: &str) -> bool {
    let lower = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if matches!(lower.as_str(), "localhost" | "127.0.0.1" | "::1") {
        return true;
    }
    if let Ok(ip) = lower.parse::<IpAddr>() {
        return match ip {
            IpAddr::V4(ip) => {
                ip.is_private() || ip.is_loopback() || ip.is_link_local() || ip.is_unspecified()
            }
            IpAddr::V6(ip) => ip.is_loopback() || ip.is_unspecified(),
        };
    }
    false
}
