// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Pure role, permission and credential-sanitising helpers ported from
//! `src/auth.ts`, plus the normalisation/role helpers from `src/identity.ts`.
//!
//! The session shell, token signing and HTTP middleware are deliberately not
//! ported here: only the deterministic authorization vocabulary lives in the
//! domain layer.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{first_non_null, js_string, number_from_value, string_value, JsonMap};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionRole {
    Admin,
    Manager,
    Technician,
    Volunteer,
    Citizen,
}

impl Default for SessionRole {
    fn default() -> Self {
        SessionRole::Citizen
    }
}

impl SessionRole {
    pub const ALL: [SessionRole; 5] = [
        SessionRole::Admin,
        SessionRole::Manager,
        SessionRole::Technician,
        SessionRole::Volunteer,
        SessionRole::Citizen,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            SessionRole::Admin => "admin",
            SessionRole::Manager => "manager",
            SessionRole::Technician => "technician",
            SessionRole::Volunteer => "volunteer",
            SessionRole::Citizen => "citizen",
        }
    }

    pub fn from_token(value: &str) -> Option<Self> {
        match value.to_lowercase().as_str() {
            "admin" => Some(SessionRole::Admin),
            "manager" => Some(SessionRole::Manager),
            "technician" => Some(SessionRole::Technician),
            "volunteer" => Some(SessionRole::Volunteer),
            "citizen" => Some(SessionRole::Citizen),
            _ => None,
        }
    }
}

impl std::fmt::Display for SessionRole {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// `String(value || '').toLowerCase()`, falling back when the role is unknown.
pub fn normalize_role(value: Option<&Value>, fallback: SessionRole) -> SessionRole {
    SessionRole::from_token(&string_value(value)).unwrap_or(fallback)
}

pub fn normalize_role_default(value: Option<&Value>) -> SessionRole {
    normalize_role(value, SessionRole::Citizen)
}

fn role_permissions(role: SessionRole) -> &'static [&'static str] {
    match role {
        SessionRole::Admin => &["*"],
        SessionRole::Manager => &[
            "assets:read",
            "assets:write",
            "incidents:read",
            "incidents:write",
            "incidents:verify",
            "maintenance:read",
            "maintenance:write",
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
        SessionRole::Technician => &[
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
        SessionRole::Volunteer => &[
            "assets:read",
            "incidents:read",
            "geofences:read",
            "notifications:read",
            "files:read",
            "geo:read",
            "public:read",
        ],
        SessionRole::Citizen => &["public:read"],
    }
}

pub fn permissions_for_role(role: SessionRole) -> Vec<String> {
    role_permissions(role)
        .iter()
        .map(|permission| (*permission).to_string())
        .collect()
}

/// The minimal principal shape the permission check needs. The `permissions`
/// array carried by a token is intentionally ignored: permissions are always
/// derived from the signed role.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PermissionPrincipal {
    #[serde(default)]
    pub role: SessionRole,
    #[serde(default)]
    pub permissions: Vec<String>,
}

pub type SessionPrincipal = PermissionPrincipal;

pub fn has_permission(principal: Option<&PermissionPrincipal>, permission: &str) -> bool {
    let Some(principal) = principal else {
        return false;
    };
    if permission == "authenticated" {
        return true;
    }
    let granted = role_permissions(principal.role);
    granted.contains(&"*") || granted.contains(&permission)
}

pub const SENSITIVE_USER_FIELDS: [&str; 6] = [
    "password",
    "password_hash",
    "passwordHash",
    "passwordhash",
    "passwordSalt",
    "password_salt",
];

/// Removes credential fields from a user/operator record before returning it.
/// Non-object values (including arrays) are returned unchanged, matching the TS
/// helper.
pub fn sanitize_user(value: &Value) -> Value {
    let Some(record) = value.as_object() else {
        return value.clone();
    };
    let mut clean = JsonMap::new();
    for (key, entry) in record {
        if !SENSITIVE_USER_FIELDS.contains(&key.as_str()) {
            clean.insert(key.clone(), entry.clone());
        }
    }
    Value::Object(clean)
}

pub fn contains_password(body: &JsonMap) -> bool {
    body.keys()
        .any(|key| SENSITIVE_USER_FIELDS.contains(&key.as_str()))
}

// ---------------------------------------------------------------------------
// identity.ts pure helpers
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IdentityError {
    pub code: String,
    pub status: u16,
}

impl IdentityError {
    fn missing_subject() -> Self {
        Self {
            code: "identity_missing_subject".to_string(),
            status: 502,
        }
    }
}

impl std::fmt::Display for IdentityError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.code)
    }
}

impl std::error::Error for IdentityError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedIdentity {
    pub user_id: String,
    pub email: String,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<f64>,
    pub scopes: Vec<String>,
    pub raw: JsonMap,
}

fn string_field(map: &JsonMap, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| match map.get(*key) {
            Some(Value::String(text)) => Some(text.trim().to_string()),
            _ => None,
        })
        .unwrap_or_default()
}

fn scopes_of(map: &JsonMap) -> Vec<String> {
    map.get("scopes")
        .and_then(Value::as_array)
        .map(|scopes| {
            scopes
                .iter()
                .map(js_string)
                .filter(|scope| !scope.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Normalizes the Tier-2 `auth.login`/`register`/`oidc` session response.
pub fn identity_from_session(session: &JsonMap) -> Result<VerifiedIdentity, IdentityError> {
    let access_token = string_field(session, &["accessToken", "access_token"]);
    let refresh_token = string_field(session, &["refreshToken", "refresh_token"]);
    let empty_user = JsonMap::new();
    let user = session
        .get("user")
        .and_then(Value::as_object)
        .unwrap_or(&empty_user);
    let email = {
        let value = string_field(user, &["email"]);
        if value.is_empty() {
            string_field(session, &["email"])
        } else {
            value
        }
    };
    let user_id = {
        let value = string_field(user, &["id", "sub"]);
        if value.is_empty() {
            string_field(session, &["userId", "sub"])
        } else {
            value
        }
    };
    if user_id.is_empty() && email.is_empty() {
        return Err(IdentityError::missing_subject());
    }
    let display_name = {
        let value = string_field(user, &["display_name", "displayName", "full_name"]);
        if !value.is_empty() {
            value
        } else if !email.is_empty() {
            email.clone()
        } else {
            user_id.clone()
        }
    };
    let expires_raw =
        first_non_null(session, &["expiresIn", "expires_in"]).and_then(number_from_value);
    let expires_in = expires_raw.filter(|value| value.is_finite());

    let mut scopes = scopes_of(session);
    scopes.extend(scopes_of(user));

    let mut raw = session.clone();
    raw.insert("user".to_string(), Value::Object(user.clone()));

    Ok(VerifiedIdentity {
        user_id: if user_id.is_empty() {
            format!("user-{}", email.to_lowercase())
        } else {
            user_id
        },
        email,
        display_name,
        access_token: (!access_token.is_empty()).then_some(access_token),
        refresh_token: (!refresh_token.is_empty()).then_some(refresh_token),
        expires_in,
        scopes,
        raw,
    })
}

/// Maps a verified identity to a City role. The identity provider and the
/// caller never supply the role: it comes from the bootstrap allow-list, a City
/// operator profile, or the configured fallback.
pub fn role_for_identity(
    identity: &VerifiedIdentity,
    profile: Option<&JsonMap>,
    bootstrap_admins: &[String],
    fallback: SessionRole,
) -> SessionRole {
    let email = identity.email.to_lowercase();
    if !email.is_empty()
        && bootstrap_admins
            .iter()
            .any(|admin| admin.to_lowercase() == email)
    {
        return SessionRole::Admin;
    }
    if let Some(profile) = profile {
        let status = string_value(profile.get("status"));
        let status = if status.is_empty() {
            "active".to_string()
        } else {
            status.to_lowercase()
        };
        if status != "inactive" {
            let raw = string_value(profile.get("role")).trim().to_lowercase();
            if !raw.is_empty() {
                return SessionRole::from_token(&raw).unwrap_or(SessionRole::Citizen);
            }
        }
    }
    fallback
}

pub fn permissions_for_identity(role: SessionRole) -> Vec<String> {
    permissions_for_role(role)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn administrator_has_the_only_wildcard() {
        assert_eq!(permissions_for_role(SessionRole::Admin), vec!["*"]);
        assert_eq!(
            permissions_for_role(SessionRole::Citizen),
            vec!["public:read"]
        );
        for role in SessionRole::ALL {
            if role != SessionRole::Admin {
                assert!(!permissions_for_role(role).contains(&"*".to_string()));
            }
        }
    }

    #[test]
    fn permission_checks_ignore_the_token_permission_array() {
        let principal = PermissionPrincipal {
            role: SessionRole::Citizen,
            permissions: vec!["*".to_string()],
        };
        assert!(!has_permission(Some(&principal), "assets:write"));
        assert!(has_permission(Some(&principal), "public:read"));
        assert!(has_permission(Some(&principal), "authenticated"));
        assert!(!has_permission(None, "public:read"));

        let manager = PermissionPrincipal {
            role: SessionRole::Manager,
            permissions: vec![],
        };
        assert!(has_permission(Some(&manager), "users:read"));
        assert!(!has_permission(Some(&manager), "users:admin"));
        assert!(has_permission(Some(&manager), "budgets:approve"));

        let technician = PermissionPrincipal {
            role: SessionRole::Technician,
            permissions: vec![],
        };
        assert!(has_permission(Some(&technician), "maintenance:write"));
        assert!(!has_permission(Some(&technician), "reports:read"));
        assert!(!has_permission(Some(&technician), "users:read"));
    }

    #[test]
    fn role_normalization_defaults_to_citizen() {
        assert_eq!(
            normalize_role(Some(&json!("MANAGER")), SessionRole::Citizen),
            SessionRole::Manager
        );
        assert_eq!(
            normalize_role(Some(&json!("unknown")), SessionRole::Volunteer),
            SessionRole::Volunteer
        );
        assert_eq!(normalize_role_default(None), SessionRole::Citizen);
        assert_eq!(
            normalize_role_default(Some(&json!(false))),
            SessionRole::Citizen
        );
    }

    #[test]
    fn sensitive_fields_are_removed_from_user_records() {
        let sanitized = sanitize_user(&json!({
            "id": "u1",
            "username": "operator",
            "password": "secret",
            "password_hash": "hash",
            "passwordHash": "hash",
            "passwordSalt": "salt",
            "role": "admin"
        }));
        assert_eq!(sanitized.get("id").unwrap(), "u1");
        assert!(sanitized.get("password").is_none());
        assert!(sanitized.get("password_hash").is_none());
        assert!(sanitized.get("passwordHash").is_none());
        assert!(sanitized.get("passwordSalt").is_none());
        // Arrays are returned untouched, matching the TS helper.
        assert_eq!(sanitize_user(&json!(["password"])), json!(["password"]));

        let body = json!({ "username": "x", "password": "y" })
            .as_object()
            .unwrap()
            .clone();
        assert!(contains_password(&body));
        assert!(!contains_password(
            json!({ "username": "x" }).as_object().unwrap()
        ));
    }

    #[test]
    fn identity_session_normalization_and_role_mapping() {
        let session = json!({
            "accessToken": " access-token ",
            "refresh_token": "refresh",
            "expiresIn": 3600,
            "scopes": ["read", "write"],
            "user": {
                "id": "user-1",
                "email": "operator@example.com",
                "display_name": "Operator",
                "scopes": ["city"]
            }
        });
        let identity = identity_from_session(session.as_object().unwrap()).unwrap();
        assert_eq!(identity.user_id, "user-1");
        assert_eq!(identity.email, "operator@example.com");
        assert_eq!(identity.display_name, "Operator");
        assert_eq!(identity.access_token.as_deref(), Some("access-token"));
        assert_eq!(identity.scopes, vec!["read", "write", "city"]);
        assert_eq!(identity.expires_in, Some(3600.0));

        let bootstrap = vec!["admin@example.com".to_string()];
        assert_eq!(
            role_for_identity(&identity, None, &bootstrap, SessionRole::Citizen),
            SessionRole::Citizen
        );
        let admin_identity = VerifiedIdentity {
            email: "admin@example.com".to_string(),
            ..identity.clone()
        };
        assert_eq!(
            role_for_identity(&admin_identity, None, &bootstrap, SessionRole::Citizen),
            SessionRole::Admin
        );

        let profile = json!({ "role": "technician", "status": "active" })
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            role_for_identity(&identity, Some(&profile), &bootstrap, SessionRole::Citizen),
            SessionRole::Technician
        );
        let inactive = json!({ "role": "manager", "status": "inactive" })
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            role_for_identity(
                &identity,
                Some(&inactive),
                &bootstrap,
                SessionRole::Volunteer
            ),
            SessionRole::Volunteer
        );
        let unknown = json!({ "role": "superuser", "status": "active" })
            .as_object()
            .unwrap()
            .clone();
        assert_eq!(
            role_for_identity(&identity, Some(&unknown), &bootstrap, SessionRole::Manager),
            SessionRole::Citizen
        );

        let missing = json!({ "user": {} }).as_object().unwrap().clone();
        let error = identity_from_session(&missing).unwrap_err();
        assert_eq!(error.code, "identity_missing_subject");
        assert_eq!(error.status, 502);
    }

    #[test]
    fn identity_falls_back_to_the_email_subject() {
        let session = json!({ "user": { "email": "Person@Example.com" } })
            .as_object()
            .unwrap()
            .clone();
        let identity = identity_from_session(&session).unwrap();
        assert_eq!(identity.user_id, "user-person@example.com");
        assert_eq!(identity.display_name, "Person@Example.com");
    }
}
