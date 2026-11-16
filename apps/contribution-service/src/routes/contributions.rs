// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Contribution submission, moderation and leaderboard endpoints.

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::models::ContributionInput;
use crate::ratelimit::{enforce, ClientIp};
use crate::routes::ApiJson;
use crate::state::SharedState;
use crate::util::now_naive_iso;
use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Map, Value};

pub async fn create(
    State(state): State<SharedState>,
    ApiJson(payload): ApiJson<ContributionInput>,
) -> Result<Json<Value>, ApiError> {
    let contribution = payload.validate()?;
    let mut object = Map::new();
    object.insert(
        "contributor_name".to_string(),
        Value::String(contribution.contributor_name),
    );
    object.insert("msv".to_string(), Value::String(contribution.msv));
    object.insert("unit".to_string(), Value::String(contribution.unit));
    object.insert("anonymous".to_string(), Value::Bool(contribution.anonymous));
    object.insert("properties".to_string(), contribution.properties);
    object.insert("geometry".to_string(), contribution.geometry);
    object.insert("status".to_string(), Value::String("pending".to_string()));
    object.insert("timestamp".to_string(), Value::String(now_naive_iso()));
    object.insert("type".to_string(), Value::String("Feature".to_string()));

    if !object.contains_key("feature_code") {
        if let Some(feature_type) = object
            .get("properties")
            .and_then(|properties| properties.get("feature_type"))
            .and_then(Value::as_str)
        {
            if !feature_type.is_empty() {
                object.insert(
                    "feature_code".to_string(),
                    Value::String(feature_type.to_lowercase().replace(' ', "_")),
                );
            }
        }
    }

    state
        .storage
        .add_contribution(Value::Object(object))
        .await?;
    Ok(Json(json!({
        "status": "success",
        "message": "Contribution submitted",
    })))
}

pub async fn list(
    State(state): State<SharedState>,
    _user: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let items = state.storage.get_pending_contributions().await?;
    Ok(Json(Value::Array(items)))
}

pub async fn approve(
    State(state): State<SharedState>,
    _user: AuthUser,
    ip: ClientIp,
    Path(contribution_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    enforce(&state, "contribution_approve", &ip.0, 30)?;
    if !state.storage.approve_contribution(&contribution_id).await? {
        return Err(ApiError::not_found("Contribution not found"));
    }
    Ok(Json(json!({ "status": "success" })))
}

pub async fn reject(
    State(state): State<SharedState>,
    _user: AuthUser,
    ip: ClientIp,
    Path(contribution_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    enforce(&state, "contribution_reject", &ip.0, 30)?;
    if !state.storage.reject_contribution(&contribution_id).await? {
        return Err(ApiError::not_found("Contribution not found"));
    }
    Ok(Json(json!({ "status": "success" })))
}

pub async fn leaderboard(State(state): State<SharedState>) -> Result<Json<Value>, ApiError> {
    let leaderboard = state.storage.get_leaderboard().await?;
    Ok(Json(leaderboard))
}
