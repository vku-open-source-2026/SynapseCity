// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! JWT creation/verification and the bearer-auth extractor.

use crate::error::ApiError;
use crate::state::SharedState;
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use chrono::Utc;
use jsonwebtoken::{decode, encode, Algorithm, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: i64,
    #[serde(rename = "type")]
    pub token_type: String,
}

#[derive(Clone)]
pub struct JwtKeys {
    secret: Vec<u8>,
    access_minutes: i64,
    refresh_days: i64,
}

impl JwtKeys {
    pub fn new(secret: &str, access_minutes: i64, refresh_days: i64) -> Self {
        Self {
            secret: secret.as_bytes().to_vec(),
            access_minutes,
            refresh_days,
        }
    }

    pub fn access_token(&self, subject: &str) -> Result<String, ApiError> {
        self.token(subject, "access", self.access_minutes * 60)
    }

    pub fn refresh_token(&self, subject: &str) -> Result<String, ApiError> {
        self.token(subject, "refresh", self.refresh_days * 24 * 60 * 60)
    }

    fn token(&self, subject: &str, token_type: &str, ttl_seconds: i64) -> Result<String, ApiError> {
        let claims = Claims {
            sub: subject.to_string(),
            exp: Utc::now().timestamp() + ttl_seconds,
            token_type: token_type.to_string(),
        };
        encode(
            &Header::new(Algorithm::HS256),
            &claims,
            &EncodingKey::from_secret(&self.secret),
        )
        .map_err(|error| {
            tracing::error!(error = %error, "failed to sign JWT");
            ApiError::internal("Could not create token")
        })
    }

    pub fn verify(&self, token: &str, expected_type: &str) -> Result<Claims, ApiError> {
        let mut validation = Validation::new(Algorithm::HS256);
        validation.leeway = 0;
        validation.validate_exp = true;
        // PyJWT does not require `exp` to be present; preserve that behaviour.
        validation.required_spec_claims.clear();

        let data = decode::<Claims>(token, &DecodingKey::from_secret(&self.secret), &validation)
            .map_err(|_| ApiError::unauthorized("Could not validate credentials"))?;

        if data.claims.token_type != expected_type {
            return Err(ApiError::unauthorized("Invalid token type"));
        }
        if data.claims.sub.trim().is_empty() {
            return Err(ApiError::unauthorized("Could not validate credentials"));
        }
        Ok(data.claims)
    }
}

/// Constant-time credential check for the single env-configured admin account.
pub fn authenticate_user(
    expected_username: &str,
    expected_password: &str,
    username: &str,
    password: &str,
) -> bool {
    let user_ok = digest_eq(expected_username, username);
    let password_ok = digest_eq(expected_password, password);
    user_ok & password_ok
}

fn digest_eq(expected: &str, provided: &str) -> bool {
    let expected = Sha256::digest(expected.as_bytes());
    let provided = Sha256::digest(provided.as_bytes());
    expected.as_slice().ct_eq(provided.as_slice()).into()
}

/// Authenticated principal extracted from a Bearer access token.
#[derive(Debug, Clone)]
pub struct AuthUser(pub String);

impl AuthUser {
    pub fn username(&self) -> &str {
        &self.0
    }
}

impl FromRequestParts<SharedState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedState,
    ) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok());
        let Some(header) = header else {
            // FastAPI's HTTPBearer(auto_error=True) returns 403, not 401.
            return Err(ApiError::forbidden("Not authenticated"));
        };
        let Some(token) = header.strip_prefix("Bearer ") else {
            return Err(ApiError::forbidden("Not authenticated"));
        };
        let claims = state.jwt.verify(token.trim(), "access")?;
        Ok(AuthUser(claims.sub))
    }
}
