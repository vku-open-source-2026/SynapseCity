// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP routes and the FastAPI-compatible JSON extractor.

pub mod auth;
pub mod contributions;
pub mod export;
pub mod features;
pub mod health;
pub mod map;
pub mod sos;
pub mod sync;

use crate::error::ApiError;
use crate::state::SharedState;
use axum::extract::{FromRequest, Request};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::de::DeserializeOwned;
use serde_json::json;

/// JSON body extractor that maps parse failures to FastAPI's 422 shape.
pub struct ApiJson<T>(pub T);

impl<T, S> FromRequest<S> for ApiJson<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(ApiJson(value)),
            Err(rejection) => Err(ApiError::unprocessable(json!([{
                "loc": ["body"],
                "msg": rejection.body_text(),
                "type": "value_error.json",
            }]))),
        }
    }
}

pub fn router(state: SharedState) -> Router {
    Router::new()
        .route("/health", get(health::health))
        .route("/ready", get(health::ready))
        // nginx routes /api/ to this service; expose the probes there too.
        .route("/api/health", get(health::health))
        .route("/api/ready", get(health::ready))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/refresh", post(auth::refresh))
        .route("/api/features", get(features::list).post(features::create))
        .route(
            "/api/features/{feature_id}",
            axum::routing::delete(features::delete),
        )
        .route(
            "/api/contributions",
            get(contributions::list).post(contributions::create),
        )
        .route(
            "/api/contributions/{contribution_id}/approve",
            post(contributions::approve),
        )
        .route(
            "/api/contributions/{contribution_id}",
            axum::routing::delete(contributions::reject),
        )
        .route("/api/leaderboard", get(contributions::leaderboard))
        .route("/api/sos", get(sos::list).post(sos::create))
        .route("/api/sos/{report_id}/ack", post(sos::ack))
        .route("/api/sos/{report_id}/resolve", post(sos::resolve))
        .route("/api/sync/ack", post(sync::ack))
        .route("/api/export_csv", get(export::export_csv))
        .route("/api/map/tiles/{z}/{x}/{y}", get(map::tile))
        .route("/api/map/config", get(map::config))
        .with_state(state)
}
