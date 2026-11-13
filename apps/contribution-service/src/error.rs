// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! API error type that mirrors FastAPI's `{"detail": ...}` envelope.

use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub detail: Value,
    pub headers: HeaderMap,
}

impl ApiError {
    pub fn new(status: StatusCode, detail: impl Into<Value>) -> Self {
        Self {
            status,
            detail: detail.into(),
            headers: HeaderMap::new(),
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        let mut error = Self::new(StatusCode::UNAUTHORIZED, message.into());
        error
            .headers
            .insert(header::WWW_AUTHENTICATE, HeaderValue::from_static("Bearer"));
        error
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, message.into())
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message.into())
    }

    pub fn unprocessable(detail: Value) -> Self {
        Self::new(StatusCode::UNPROCESSABLE_ENTITY, detail)
    }

    pub fn service_unavailable(message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, message.into())
    }

    pub fn too_many_requests(message: impl Into<String>) -> Self {
        Self::new(StatusCode::TOO_MANY_REQUESTS, message.into())
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, message.into())
    }

    /// FastAPI/Pydantic-style validation error body.
    pub fn validation(field: &str, message: impl Into<String>) -> Self {
        Self::unprocessable(json!([{
            "loc": ["body", field],
            "msg": message.into(),
            "type": "value_error",
        }]))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "detail": self.detail }));
        (self.status, self.headers, body).into_response()
    }
}

impl From<synapseone::Error> for ApiError {
    fn from(error: synapseone::Error) -> Self {
        tracing::error!(error = %error, "SynapseBase request failed");
        ApiError::internal("Storage backend request failed")
    }
}

impl From<reqwest::Error> for ApiError {
    fn from(error: reqwest::Error) -> Self {
        tracing::error!(error = %error, "upstream request failed");
        ApiError::internal("Upstream request failed")
    }
}
