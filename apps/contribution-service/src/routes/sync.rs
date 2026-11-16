// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Internal acknowledgement used by the daily SynapseFlow export.

use crate::error::ApiError;
use crate::state::SharedState;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderName};
use axum::Json;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

const SYNC_SECRET: HeaderName = HeaderName::from_static("x-sync-secret");

pub async fn ack(
    State(state): State<SharedState>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let Some(expected) = state.config.sync_shared_secret.as_deref() else {
        return Err(ApiError::service_unavailable(
            "Sync acknowledgement is not configured",
        ));
    };
    let provided = headers
        .get(&SYNC_SECRET)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if !constant_time_eq(expected, provided) {
        return Err(ApiError::unauthorized("Invalid sync secret"));
    }

    let payload: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
    let limit = match payload.as_object() {
        Some(object) => object
            .get("limit")
            .and_then(|value| {
                value
                    .as_i64()
                    .or_else(|| value.as_f64().map(|number| number as i64))
                    .or_else(|| value.as_str().and_then(|text| text.parse().ok()))
            })
            .unwrap_or(500),
        None => 500,
    };
    let limit = limit.clamp(1, 1_000);
    let marked = state.storage.mark_synced(limit).await?;
    Ok(Json(json!({ "status": "success", "marked": marked })))
}

fn constant_time_eq(expected: &str, provided: &str) -> bool {
    let expected = Sha256::digest(expected.as_bytes());
    let provided = Sha256::digest(provided.as_bytes());
    expected.as_slice().ct_eq(provided.as_slice()).into()
}
