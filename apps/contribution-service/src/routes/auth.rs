// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Login and refresh endpoints.

use crate::auth::{authenticate_user, AuthUser};
use crate::error::ApiError;
use crate::models::{LoginRequest, RefreshTokenRequest, TokenResponse};
use crate::ratelimit::{enforce, ClientIp};
use crate::routes::ApiJson;
use crate::state::SharedState;
use axum::extract::State;
use axum::Json;

pub async fn login(
    State(state): State<SharedState>,
    ip: ClientIp,
    ApiJson(payload): ApiJson<LoginRequest>,
) -> Result<Json<TokenResponse>, ApiError> {
    enforce(&state, "login", &ip.0, 5)?;
    if !authenticate_user(
        &state.config.admin_username,
        &state.config.admin_password,
        &payload.username,
        &payload.password,
    ) {
        tracing::warn!(username = %payload.username, ip = %ip.0, "failed login attempt");
        return Err(ApiError::unauthorized("Incorrect username or password"));
    }
    tracing::info!(username = %payload.username, ip = %ip.0, "successful login");
    let access = state.jwt.access_token(&payload.username)?;
    let refresh = state.jwt.refresh_token(&payload.username)?;
    Ok(Json(TokenResponse::new(access, refresh)))
}

pub async fn refresh(
    State(state): State<SharedState>,
    ip: ClientIp,
    ApiJson(payload): ApiJson<RefreshTokenRequest>,
) -> Result<Json<TokenResponse>, ApiError> {
    enforce(&state, "refresh", &ip.0, 10)?;
    let claims = state.jwt.verify(&payload.refresh_token, "refresh")?;
    let access = state.jwt.access_token(&claims.sub)?;
    let refresh = state.jwt.refresh_token(&claims.sub)?;
    Ok(Json(TokenResponse::new(access, refresh)))
}

/// Keep the extractor visible to rustdoc/imports.
#[allow(dead_code)]
fn _auth_marker(_: AuthUser) {}
