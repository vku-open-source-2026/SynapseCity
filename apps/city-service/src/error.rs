// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Stable HTTP error envelope for the City service.

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
    pub dependency: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
            dependency: None,
        }
    }

    pub fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }

    pub fn with_dependency(mut self, dependency: impl Into<String>) -> Self {
        self.dependency = Some(dependency.into());
        self
    }

    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", message)
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn too_large(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::PAYLOAD_TOO_LARGE, code, message)
    }

    pub fn unsupported(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, code, message)
    }

    pub fn bad_gateway(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_GATEWAY, code, message)
    }

    pub fn unavailable(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message)
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "unhandled City error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal_error",
            "The City service encountered an internal error.",
        )
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for ApiError {}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({
            "error": self.message,
            "code": self.code,
        });
        if let Some(details) = self.details {
            body["details"] = details;
        }
        if let Some(dependency) = self.dependency {
            body["dependency"] = json!(dependency);
        }
        (self.status, Json(body)).into_response()
    }
}

impl From<synapsedx::Error> for ApiError {
    fn from(error: synapsedx::Error) -> Self {
        match error.status() {
            Some(404) => Self::not_found("not_found", "Upstream record or dataset was not found."),
            Some(400) | Some(409) | Some(422) => Self::new(
                StatusCode::from_u16(error.status().unwrap_or(502)).unwrap_or(StatusCode::BAD_GATEWAY),
                error.code().unwrap_or("tier2_rejected").to_string(),
                error.to_string(),
            ),
            Some(401) | Some(403) => Self::new(
                StatusCode::BAD_GATEWAY,
                "tier2_unauthorized",
                "The Tier-2 capability rejected the service credential.",
            ),
            _ => {
                tracing::warn!(error = %error, "tier2 call failed");
                Self::bad_gateway("tier2_unavailable", "The Tier-2 capabilities API is unavailable.")
            }
        }
    }
}

pub type ApiResult<T = Response> = Result<T, ApiError>;
