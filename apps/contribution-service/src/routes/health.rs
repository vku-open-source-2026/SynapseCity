// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Liveness and readiness probes.

use crate::state::SharedState;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

pub async fn health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "service": "contribution-backend",
        "version": env!("CARGO_PKG_VERSION"),
    }))
}

pub async fn ready(State(state): State<SharedState>) -> Json<Value> {
    Json(json!({
        "status": "ready",
        "service": "contribution-backend",
        "version": env!("CARGO_PKG_VERSION"),
        "storage": match state.config.storage_backend {
            crate::config::StorageBackend::Base => "base",
            crate::config::StorageBackend::Json => "json",
        },
    }))
}
