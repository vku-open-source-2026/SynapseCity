// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! VietMap tile proxy and basemap configuration.

use crate::error::ApiError;
use crate::state::SharedState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::time::Duration;

const TILE_URL: &str = "https://maps.vietmap.vn/maps/tiles/tm/{z}/{x}/{y}@2x.png";

pub async fn config(State(state): State<SharedState>) -> Json<Value> {
    if state.config.vietmap_api_key.is_some() {
        Json(json!({
            "tileUrl": "/api/map/tiles/{z}/{x}/{y}",
            "attribution": "&copy; <a href=\"https://vietmap.vn\">VietMap</a> | Hoang Sa and Truong Sa belong to Vietnam 🇻🇳",
            "maxZoom": 20,
            "provider": "vietmap",
        }))
    } else {
        Json(json!({
            "tileUrl": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
            "attribution": "&copy; <a href=\"https://openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
            "maxZoom": 20,
            "provider": "osm",
        }))
    }
}

pub async fn tile(
    State(state): State<SharedState>,
    Path((z, x, y)): Path<(i32, i32, i32)>,
) -> Result<Response, ApiError> {
    let Some(api_key) = state.config.vietmap_api_key.as_deref() else {
        return Err(ApiError::service_unavailable(
            "VietMap API key not configured",
        ));
    };
    let url = TILE_URL
        .replace("{z}", &z.to_string())
        .replace("{x}", &x.to_string())
        .replace("{y}", &y.to_string());

    let response = state
        .http
        .get(&url)
        .query(&[("apikey", api_key)])
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| {
            tracing::error!(error = %error, "VietMap tile request failed");
            ApiError::internal("Upstream tile error")
        })?;

    if !response.status().is_success() {
        let status =
            StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
        return Ok((status, Json(json!({ "detail": "Upstream tile error" }))).into_response());
    }

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("image/png")
        .to_string();
    let bytes = response.bytes().await.map_err(|error| {
        tracing::error!(error = %error, "VietMap tile body failed");
        ApiError::internal("Upstream tile error")
    })?;

    let builder = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, content_type)
        .header(CACHE_CONTROL, "public, max-age=86400")
        .header("access-control-allow-origin", "*");
    builder
        .body(Body::from(bytes))
        .map_err(|error| ApiError::internal(format!("tile response error: {error}")))
}
