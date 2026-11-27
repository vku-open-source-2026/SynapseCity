// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! City stateless HMAC session shell and Tier-2 identity boundary.

use std::sync::Mutex;

use axum::http::HeaderMap;
use base64::Engine;
use chrono::Utc;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::Sha256;
use subtle::ConstantTimeEq;
#[cfg(test)]
use uuid::Uuid;

use crate::config::Config;

type HmacSha256 = Hmac<Sha256>;

pub const ROLE_ADMIN: &str = "admin";
pub const ROLE_MANAGER: &str = "manager";
pub const ROLE_TECHNICIAN: &str = "technician";
pub const ROLE_VOLUNTEER: &str = "volunteer";
#[cfg(test)]
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

/// Login and registration are retired (every /v1/auth/* answers 410), so the
/// production service never mints sessions; it only verifies the Bearer tokens
/// tests and out-of-band operator tooling sign with AUTH_SECRET. The minting
/// helpers below exist for the test suites only.
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct SessionResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_in: i64,
    pub user: SessionUser,
}

#[cfg(test)]
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

#[cfg(test)]
pub fn is_role(value: &str) -> bool {
    matches!(
        value,
        ROLE_ADMIN | ROLE_MANAGER | ROLE_TECHNICIAN | ROLE_VOLUNTEER | ROLE_CITIZEN
    )
}

#[cfg(test)]
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
            "assets:read",
            "assets:write",
            "incidents:read",
            "incidents:write",
            "incidents:verify",
            "maintenance:read",
            "maintenance:write",
            "maintenance:approve",
            "approvals:read",
            "approvals:decide",
            "iot:read",
            "iot:write",
            "alerts:read",
            "alerts:write",
            "budgets:read",
            "budgets:write",
            "budgets:approve",
            "reports:read",
            "reports:write",
            "reports:generate",
            "notifications:read",
            "notifications:write",
            "files:read",
            "files:write",
            "users:read",
            "geofences:read",
            "geofences:write",
            "ingest:write",
            "geo:read",
            "ai:use",
        ],
        ROLE_TECHNICIAN => &[
            "assets:read",
            "incidents:read",
            "maintenance:read",
            "maintenance:write",
            "iot:read",
            "alerts:read",
            "notifications:read",
            "files:read",
            "files:write",
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
    granted
        .iter()
        .any(|value| value == "*" || value == permission)
}

pub fn sanitize_user(value: &Map<String, Value>) -> Map<String, Value> {
    let mut clean = Map::new();
    for (key, entry) in value {
        if !matches!(
            key.as_str(),
            "password"
                | "password_hash"
                | "passwordHash"
                | "passwordhash"
                | "passwordSalt"
                | "password_salt"
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
            "password"
                | "password_hash"
                | "passwordHash"
                | "passwordhash"
                | "passwordSalt"
                | "password_salt"
        )
    })
}

fn signature(secret: &str, payload: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key");
    mac.update(payload.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes())
}

#[cfg(test)]
pub fn sign_token(config: &Config, claims: &SessionPrincipal) -> String {
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(claims).unwrap_or_default());
    let signature = signature(&config.auth_secret, &payload);
    format!("{payload}.{signature}")
}

pub fn verify_token(config: &Config, token: &str, expected: &str) -> Option<SessionPrincipal> {
    let (payload, provided) = token.split_once('.')?;
    let expected_signature = signature(&config.auth_secret, payload);
    if provided
        .as_bytes()
        .ct_eq(expected_signature.as_bytes())
        .unwrap_u8()
        != 1
    {
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

pub fn is_revoked(jti: Option<&str>) -> bool {
    let Some(jti) = jti else {
        return false;
    };
    let now = Utc::now().timestamp();
    let mut revoked = REVOKED.lock().unwrap_or_else(|poison| poison.into_inner());
    revoked.retain(|(_, exp)| *exp > now);
    revoked.iter().any(|(value, _)| value == jti)
}

#[cfg(test)]
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
                .map(
                    |ch| if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                        ch
                    } else {
                        '-'
                    }
                )
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

#[cfg(test)]
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

/// Lifetime of the capability issued to an anonymous reporter. It authorizes
/// appending photos to that one report and nothing else.
pub const REPORT_EDIT_TTL_SECONDS: i64 = 24 * 60 * 60;

#[derive(Debug, Serialize, Deserialize)]
struct ReportEditClaims {
    incident_id: String,
    exp: i64,
    typ: String,
}

fn report_edit_payload(incident_id: &str, exp: i64) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&ReportEditClaims {
            incident_id: incident_id.to_string(),
            exp,
            typ: "incident_edit".into(),
        })
        .unwrap_or_default(),
    )
}

/// Issue a short-lived signed capability for the anonymous report creator.
/// The incident id alone is not a capability: every append must present this
/// token and only files uploaded for the same report are accepted.
pub fn issue_report_edit_token(config: &Config, incident_id: &str) -> (String, i64) {
    let exp = Utc::now().timestamp() + REPORT_EDIT_TTL_SECONDS;
    let payload = report_edit_payload(incident_id, exp);
    let signature = signature(&config.auth_secret, &payload);
    (format!("{payload}.{signature}"), exp)
}

pub fn verify_report_edit_token(config: &Config, token: &str, incident_id: &str) -> bool {
    let Some((payload, provided)) = token.split_once('.') else {
        return false;
    };
    let expected = signature(&config.auth_secret, payload);
    if provided.as_bytes().ct_eq(expected.as_bytes()).unwrap_u8() != 1 {
        return false;
    }
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(claims) = serde_json::from_slice::<ReportEditClaims>(&bytes) else {
        return false;
    };
    claims.typ == "incident_edit"
        && claims.incident_id == incident_id
        && claims.exp > Utc::now().timestamp()
}

/// Pre-report photo uploads are private and bound to a short-lived draft
/// capability. The draft id alone is not authorization.
pub const REPORT_UPLOAD_TTL_SECONDS: i64 = 30 * 60;

#[derive(Debug, Serialize, Deserialize)]
struct ReportUploadClaims {
    draft_id: String,
    report_hash: String,
    exp: i64,
    typ: String,
}

pub fn issue_report_upload_token(
    config: &Config,
    draft_id: &str,
    report_hash: &str,
) -> (String, i64) {
    let exp = Utc::now().timestamp() + REPORT_UPLOAD_TTL_SECONDS;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&ReportUploadClaims {
            draft_id: draft_id.to_string(),
            report_hash: report_hash.to_string(),
            exp,
            typ: "incident_upload".into(),
        })
        .unwrap_or_default(),
    );
    let signature = signature(&config.auth_secret, &payload);
    (format!("{payload}.{signature}"), exp)
}

fn verified_report_upload_hash(config: &Config, token: &str, draft_id: &str) -> Option<String> {
    let (payload, provided) = token.split_once('.')?;
    let expected = signature(&config.auth_secret, payload);
    if provided.as_bytes().ct_eq(expected.as_bytes()).unwrap_u8() != 1 {
        return None;
    }
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let claims = serde_json::from_slice::<ReportUploadClaims>(&bytes).ok()?;
    if claims.typ != "incident_upload"
        || claims.draft_id != draft_id
        || claims.exp <= Utc::now().timestamp()
    {
        return None;
    }
    Some(claims.report_hash)
}

pub fn verify_report_upload_token(config: &Config, token: &str, draft_id: &str) -> bool {
    verified_report_upload_hash(config, token, draft_id).is_some()
}

pub fn verify_report_upload_token_for_report(
    config: &Config,
    token: &str,
    draft_id: &str,
    report_hash: &str,
) -> bool {
    verified_report_upload_hash(config, token, draft_id)
        .map(|hash| hash == report_hash)
        .unwrap_or(false)
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
