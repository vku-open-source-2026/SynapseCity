// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! City stateless HMAC session shell and Tier-2 identity boundary.

use std::collections::HashSet;
use std::sync::Mutex;

use axum::http::{HeaderMap, StatusCode};
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::config::Config;
use crate::error::ApiError;

type HmacSha256 = Hmac<Sha256>;

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_MANAGER: &str = "manager";
pub const ROLE_TECHNICIAN: &str = "technician";
pub const ROLE_VOLUNTEER: &str = "volunteer";
pub const ROLE_CITIZEN: &str = "citizen";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionPrincipal {
    pub sub: String,
    pub username: String,
    pub email: String,
    pub full_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phone: Option<String>,
    pub role: String,
    pub permissions: Vec<String>,
    pub typ: String,
    pub iat: i64,
    pub exp: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jti: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub demo: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier2_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tier2_refresh_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SessionUser {
    pub id: String,
    pub username: String,
    pub email: String,
    pub full_name: String,
    pub phone: Option<String>,
    pub role: String,
    pub permissions: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone)]
pub struct SessionResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub user: SessionUser,
}

impl SessionResponse {
    pub fn json(&self) -> Value {
        json!({
            "access_token": self.access_token,
            "refresh_token": self.refresh_token,
            "token_type": "Bearer",
            "expires_in": self.expires_in,
            "user": user_json(&self.user),
        })
    }
}

pub fn user_json(user: &SessionUser) -> Value {
    json!({
        "id": user.id,
        "username": user.username,
        "email": user.email,
        "full_name": user.full_name,
        "phone": user.phone,
        "role": user.role,
        "status": "active",
        "permissions": user.permissions,
        "created_at": user.created_at,
        "updated_at": user.updated_at,
    })
}

pub fn is_role(value: &str) -> bool {
    matches!(
        value,
        ROLE_ADMIN | ROLE_MANAGER | ROLE_TECHNICIAN | ROLE_VOLUNTEER | ROLE_CITIZEN
    )
}

pub fn normalize_role(value: &str, fallback: &str) -> String {
    let value = value.trim().to_ascii_lowercase();
    if is_role(&value) {
        value
    } else {
        fallback.to_string()
    }
}

pub fn permissions_for_role(role: &str) -> Vec<String> {
    let values: &[&str] = match role {
        ROLE_ADMIN => &["*"],
        ROLE_MANAGER => &[
            "assets:read", "assets:write",
            "incidents:read", "incidents:write", "incidents:verify",
            "maintenance:read", "maintenance:write",
            "iot:read", "iot:write",
            "alerts:read", "alerts:write",
            "budgets:read", "budgets:write", "budgets:approve",
            "reports:read", "reports:write", "reports:generate",
            "notifications:read", "notifications:write",
            "files:read", "files:write",
            "users:read",
            "geofences:read", "geofences:write",
            "ingest:write", "geo:read", "ai:use",
        ],
        ROLE_TECHNICIAN => &[
            "assets:read",
            "incidents:read",
            "maintenance:read", "maintenance:write",
            "iot:read",
            "alerts:read",
            "notifications:read",
            "files:read", "files:write",
            "geo:read",
        ],
        ROLE_VOLUNTEER => &[
            "assets:read",
            "incidents:read",
            "geofences:read",
            "notifications:read",
            "files:read",
            "geo:read",
            "public:read",
        ],
        _ => &["public:read"],
    };
    values.iter().map(|value| value.to_string()).collect()
}

pub fn has_permission(principal: &SessionPrincipal, permission: &str) -> bool {
    if permission == "authenticated" {
        return true;
    }
    let granted = permissions_for_role(&principal.role);
    granted.iter().any(|value| value == "*" || value == permission)
}

pub fn sanitize_user(value: &Map<String, Value>) -> Map<String, Value> {
    let mut clean = Map::new();
    for (key, entry) in value {
        if !matches!(
            key.as_str(),
            "password" | "password_hash" | "passwordHash" | "passwordhash" | "passwordSalt" | "password_salt"
        ) {
            clean.insert(key.clone(), entry.clone());
        }
    }
    clean
}

pub fn contains_password(value: &Map<String, Value>) -> bool {
    value.keys().any(|key| {
        matches!(
            key.as_str(),
            "password" | "password_hash" | "passwordHash" | "passwordhash" | "passwordSalt" | "password_salt"
        )
    })
}

fn signature(secret: &str, payload: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(payload.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

pub fn sign_token(config: &Config, claims: &SessionPrincipal) -> String {
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(claims).unwrap_or_default());
    let signature = signature(&config.auth_secret, &payload);
    format!("{payload}.{signature}")
}

pub fn verify_token(config: &Config, token: &str, expected: &str) -> Option<SessionPrincipal> {
    let (payload, provided) = token.split_once('.')?;
    let expected_signature = signature(&config.auth_secret, payload);
    if provided.as_bytes().ct_eq(expected_signature.as_bytes()).unwrap_u8() != 1 {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims: SessionPrincipal = serde_json::from_slice(&bytes).ok()?;
    if claims.typ != expected {
        return None;
    }
    if claims.exp <= Utc::now().timestamp() {
        return None;
    }
    if claims.sub.is_empty() || claims.username.is_empty() {
        return None;
    }
    if is_revoked(claims.jti.as_deref()) {
        return None;
    }
    Some(claims)
}

static REVOKED: Mutex<Vec<(String, i64)>> = Mutex::new(Vec::new());

pub fn revoke_session(claims: &SessionPrincipal) {
    let Some(jti) = claims.jti.clone() else {
        return;
    };
    let mut revoked = REVOKED.lock().unwrap_or_else(|poison| poison.into_inner());
    revoked.push((jti, claims.exp));
    revoked.retain(|(_, exp)| *exp > Utc::now().timestamp());
}

pub fn is_revoked(jti: Option<&str>) -> bool {
    let Some(jti) = jti else {
        return false;
    };
    let now = Utc::now().timestamp();
    let mut revoked = REVOKED.lock().unwrap_or_else(|poison| poison.into_inner());
    revoked.retain(|(_, exp)| *exp > now);
    revoked.iter().any(|(value, _)| value == jti)
}

pub fn principal_from_input(
    config: &Config,
    username: &str,
    email: Option<&str>,
    full_name: Option<&str>,
    phone: Option<&str>,
    default_role: &str,
) -> SessionPrincipal {
    let role = normalize_role(default_role, ROLE_CITIZEN);
    let now = Utc::now().timestamp();
    let username = username.trim();
    SessionPrincipal {
        sub: format!(
            "user-{}",
            username
                .to_ascii_lowercase()
                .chars()
                .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') { ch } else { '-' })
                .collect::<String>()
        ),
        username: username.to_string(),
        email: email
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("{username}@synapsecity.local")),
        full_name: full_name
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| username.to_string()),
        phone: phone.map(str::to_string),
        role: role.clone(),
        permissions: permissions_for_role(&role),
        typ: "access".into(),
        iat: now,
        exp: now + config.access_ttl_seconds,
        jti: Some(Uuid::new_v4().to_string()),
        demo: None,
        auth_source: None,
        tier2_token: None,
        tier2_refresh_token: None,
    }
}

pub fn issue_session(config: &Config, mut base: SessionPrincipal, demo: bool) -> SessionResponse {
    let role = normalize_role(&base.role, ROLE_CITIZEN);
    base.role = role.clone();
    base.permissions = permissions_for_role(&role);
    if demo {
        base.demo = Some(true);
    }
    let now = Utc::now().timestamp();
    let access_claims = SessionPrincipal {
        typ: "access".into(),
        iat: now,
        exp: now + config.access_ttl_seconds,
        jti: Some(Uuid::new_v4().to_string()),
        ..base.clone()
    };
    let refresh_claims = SessionPrincipal {
        typ: "refresh".into(),
        iat: now,
        exp: now + config.refresh_ttl_seconds,
        jti: Some(Uuid::new_v4().to_string()),
        ..base.clone()
    };
    SessionResponse {
        access_token: sign_token(config, &access_claims),
        refresh_token: sign_token(config, &refresh_claims),
        expires_in: config.access_ttl_seconds,
        user: SessionUser {
            id: base.sub.clone(),
            username: base.username.clone(),
            email: base.email.clone(),
            full_name: base.full_name.clone(),
            phone: base.phone.clone(),
            role: role.clone(),
            permissions: permissions_for_role(&role),
            created_at: crate::now_iso(),
            updated_at: crate::now_iso(),
        },
    }
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get("authorization")?.to_str().ok()?.trim();
    let (scheme, token) = value.split_once(' ')?;
    if !scheme.eq_ignore_ascii_case("bearer") {
        return None;
    }
    let token = token.trim();
    (!token.is_empty()).then(|| token.to_string())
}

pub fn session_from_headers(config: &Config, headers: &HeaderMap) -> Option<SessionPrincipal> {
    bearer_token(headers).and_then(|token| verify_token(config, &token, "access"))
}

pub fn require_session(config: &Config, headers: &HeaderMap) -> Result<SessionPrincipal, ApiError> {
    session_from_headers(config, headers).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "authentication_required",
        )
    })
}

pub fn require_permission(
    config: &Config,
    headers: &HeaderMap,
    permission: &str,
) -> Result<SessionPrincipal, ApiError> {
    let principal = require_session(config, headers)?;
    if has_permission(&principal, permission) {
        Ok(principal)
    } else {
        Err(ApiError::forbidden(
            "forbidden",
            format!("{permission}_required"),
        ))
    }
}

pub fn user_from_principal(principal: &SessionPrincipal) -> SessionUser {
    SessionUser {
        id: principal.sub.clone(),
        username: principal.username.clone(),
        email: principal.email.clone(),
        full_name: principal.full_name.clone(),
        phone: principal.phone.clone(),
        role: principal.role.clone(),
        permissions: principal.permissions.clone(),
        created_at: crate::now_iso(),
        updated_at: crate::now_iso(),
    }
}

// ---------------------------------------------------------------------------
// Tier-2 identity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct VerifiedIdentity {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    pub access_token: Option<String>,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct Tier2Session {
    pub identity: VerifiedIdentity,
    pub token: Option<String>,
    pub refresh_token: Option<String>,
    pub exchanged: bool,
}

fn first_string(values: &[Option<&Value>]) -> String {
    values
        .iter()
        .filter_map(|value| value.and_then(|entry| entry.as_str()))
        .map(str::trim)
        .find(|value| !value.is_empty())
        .unwrap_or("")
        .to_string()
}

fn scopes_of(raw: &Value) -> Vec<String> {
    raw.get("scopes")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

pub fn identity_from_session(session: &Value) -> Result<VerifiedIdentity, ApiError> {
    let access_token = first_string(&[session.get("accessToken"), session.get("access_token")]);
    let refresh_token = first_string(&[session.get("refreshToken"), session.get("refresh_token")]);
    let user = session.get("user").cloned().unwrap_or_else(|| json!({}));
    let email = first_string(&[user.get("email"), session.get("email")]);
    let user_id = first_string(&[
        user.get("id"),
        user.get("sub"),
        session.get("userId"),
        session.get("sub"),
    ]);
    if user_id.is_empty() && email.is_empty() {
        return Err(ApiError::bad_gateway(
            "identity_missing_subject",
            "The identity provider returned no subject.",
        ));
    }
    let display_name = first_string(&[
        user.get("display_name"),
        user.get("displayName"),
        user.get("full_name"),
    ]);
    let mut scopes = scopes_of(session);
    scopes.extend(scopes_of(&user));
    Ok(VerifiedIdentity {
        user_id: if user_id.is_empty() {
            format!("user-{email}")
        } else {
            user_id
        },
        email,
        display_name: if display_name.is_empty() {
            "".into()
        } else {
            display_name
        },
        access_token: (!access_token.is_empty()).then_some(access_token),
        refresh_token: (!refresh_token.is_empty()).then_some(refresh_token),
        expires_in: session
            .get("expiresIn")
            .or_else(|| session.get("expires_in"))
            .and_then(Value::as_i64),
        scopes,
    })
}

pub fn role_for_identity(
    config: &Config,
    identity: &VerifiedIdentity,
    profile: Option<&Map<String, Value>>,
) -> String {
    let email = identity.email.to_ascii_lowercase();
    if !email.is_empty() && config.bootstrap_admins.contains(&email) {
        return ROLE_ADMIN.into();
    }
    if let Some(profile) = profile {
        if profile
            .get("status")
            .and_then(Value::as_str)
            .map(|value| !value.eq_ignore_ascii_case("inactive"))
            .unwrap_or(true)
        {
            if let Some(raw) = profile.get("role").and_then(Value::as_str) {
                if !raw.trim().is_empty() {
                    return normalize_role(raw, ROLE_CITIZEN);
                }
            }
        }
    }
    normalize_role(&config.default_role, ROLE_CITIZEN)
}

pub fn auth_error_status(error: &synapsedx::Error) -> (StatusCode, String, String) {
    match error.status() {
        Some(401) => (
            StatusCode::UNAUTHORIZED,
            "invalid_credentials".into(),
            "Email or password is incorrect.".into(),
        ),
        Some(400) | Some(422) => (
            StatusCode::BAD_REQUEST,
            "invalid_request".into(),
            "The identity provider rejected the request.".into(),
        ),
        Some(403) => (
            StatusCode::FORBIDDEN,
            "auth_rejected".into(),
            "The identity provider rejected this identity operation.".into(),
        ),
        Some(429) => (
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited".into(),
            "Too many authentication attempts.".into(),
        ),
        Some(409) => (
            StatusCode::CONFLICT,
            "identity_conflict".into(),
            "The identity already exists.".into(),
        ),
        Some(503) | Some(502) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_not_configured".into(),
            "The Tier-2 identity capability is unavailable.".into(),
        ),
        Some(404) => (
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_not_configured".into(),
            "The Tier-2 identity capability is not published on this deployment.".into(),
        ),
        _ => (
            StatusCode::SERVICE_UNAVAILABLE,
            "identity_not_configured".into(),
            "Identity verification is unavailable.".into(),
        ),
    }
}

pub fn identity_error(error: synapsedx::Error) -> ApiError {
    let (status, code, detail) = auth_error_status(&error);
    ApiError::new(status, code, detail)
}

pub fn exchange_enabled() -> bool {
    matches!(
        std::env::var("CITY_AUTH_EXCHANGE")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "true" | "1"
    )
}

pub fn exchange_scopes() -> Vec<String> {
    std::env::var("CITY_AUTH_EXCHANGE_SCOPES")
        .unwrap_or_else(|_| "read,write".into())
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect()
}

pub fn bootstrap_admins_set(raw: &str) -> HashSet<String> {
    raw.split(',')
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}
