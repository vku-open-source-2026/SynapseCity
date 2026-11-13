// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Feature collection endpoints.

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::models::FeatureInput;
use crate::ratelimit::{enforce, ClientIp};
use crate::routes::ApiJson;
use crate::state::SharedState;
use axum::extract::{Path, State};
use axum::Json;
use serde_json::{json, Value};

pub async fn list(State(state): State<SharedState>) -> Result<Json<Value>, ApiError> {
    let features = state.storage.get_features().await?;
    Ok(Json(json!({
        "type": "FeatureCollection",
        "features": features,
    })))
}

pub async fn create(
    State(state): State<SharedState>,
    _user: AuthUser,
    ApiJson(payload): ApiJson<FeatureInput>,
) -> Result<Json<Value>, ApiError> {
    let feature = payload.validate()?;
    state.storage.add_feature(feature).await?;
    Ok(Json(json!({ "status": "success" })))
}

pub async fn delete(
    State(state): State<SharedState>,
    _user: AuthUser,
    ip: ClientIp,
    Path(feature_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    enforce(&state, "feature_delete", &ip.0, 20)?;
    if !state.storage.delete_feature(&feature_id).await? {
        return Err(ApiError::not_found("Feature not found"));
    }
    Ok(Json(json!({
        "status": "success",
        "message": format!("Feature {feature_id} deleted"),
    })))
}
