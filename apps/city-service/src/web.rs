// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Axum request/response helpers for City routes.

use std::collections::HashMap;

use axum::body::Bytes;
use axum::extract::Request;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{Map, Value};

use crate::error::{ApiError, ApiResult};

pub const JSON_BODY_LIMIT: usize = 2 * 1024 * 1024;

pub async fn raw_body(req: Request, limit: usize) -> ApiResult<(Bytes, HeaderMap, Uri)> {
    let (parts, body) = req.into_parts();
    let bytes = axum::body::to_bytes(body, limit)
        .await
        .map_err(|_| ApiError::too_large("payload_too_large", "The request body is too large."))?;
    Ok((bytes, parts.headers, parts.uri))
}

pub async fn json_body(req: Request, limit: usize) -> ApiResult<(Map<String, Value>, HeaderMap, Uri)> {
    let (bytes, headers, uri) = raw_body(req, limit).await?;
    if bytes.is_empty() {
        return Ok((Map::new(), headers, uri));
    }
    let value: Value = serde_json::from_slice(&bytes)
        .map_err(|_| ApiError::bad_request("invalid_json", "The request body must be a JSON object."))?;
    match value {
        Value::Object(map) => Ok((map, headers, uri)),
        _ => Err(ApiError::bad_request(
            "request_body_must_be_an_object",
            "The request body must be a JSON object.",
        )),
    }
}

pub fn query_map(uri: &Uri) -> HashMap<String, String> {
    let mut values = HashMap::new();
    if let Some(query) = uri.query() {
        for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
            values.insert(key.into_owned(), value.into_owned());
        }
    }
    values
}

pub fn json_response(value: Value) -> Response {
    (StatusCode::OK, Json(value)).into_response()
}

pub fn status_json(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

pub fn created(value: Value) -> Response {
    status_json(StatusCode::CREATED, value)
}

pub fn accepted(value: Value) -> Response {
    status_json(StatusCode::ACCEPTED, value)
}

pub fn no_content() -> Response {
    StatusCode::NO_CONTENT.into_response()
}

pub fn text_response(content_type: &str, body: String) -> Response {
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, content_type.to_string())],
        body,
    )
        .into_response()
}

pub fn send_record(data: Map<String, Value>) -> Response {
    let version = data.get("record_version").and_then(Value::as_i64);
    let mut response = json_response(Value::Object(data));
    if let Some(version) = version {
        if let Ok(value) = HeaderValue::from_str(&format!("\"{version}\"")) {
            response.headers_mut().insert(header::ETAG, value);
        }
        if let Ok(value) = HeaderValue::from_str(&version.to_string()) {
            response.headers_mut().insert("x-record-version", value);
        }
    }
    response
}

pub fn send_page(mut items: Vec<Value>, query: &HashMap<String, String>, default_limit: i64) -> Response {
    let limit = query
        .get("limit")
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| (value.floor() as i64).clamp(0, 500))
        .unwrap_or(default_limit);
    let offset = query
        .get("offset")
        .or_else(|| query.get("skip"))
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite())
        .map(|value| (value.floor() as i64).clamp(0, 1_000_000))
        .unwrap_or(0);
    let total = items.len();
    let start = offset as usize;
    let values = if start >= items.len() {
        Vec::new()
    } else {
        items.drain(start..).take(limit.max(0) as usize).collect()
    };
    let mut response = json_response(Value::Array(values));
    response.headers_mut().insert(
        "x-total-count",
        HeaderValue::from_str(&total.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    response
}

pub fn private_input(body: &Map<String, Value>) -> Map<String, Value> {
    match body.get("data") {
        Some(Value::Object(data)) => data.clone(),
        _ => body.clone(),
    }
}

pub fn object_body(value: &Value) -> Result<Map<String, Value>, ApiError> {
    value
        .as_object()
        .cloned()
        .ok_or_else(|| ApiError::bad_request("request_body_must_be_an_object", "Expected a JSON object."))
}

pub fn required_string(body: &Map<String, Value>, field: &str) -> Result<String, ApiError> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            let code = format!("field_required:{field}");
            ApiError::new(StatusCode::BAD_REQUEST, code.clone(), code)
        })
}

pub fn string_field(body: &Map<String, Value>, field: &str) -> Option<String> {
    body.get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

pub fn bool_field(body: &Map<String, Value>, field: &str) -> Option<bool> {
    let value = body.get(field)?;
    if let Some(boolean) = value.as_bool() {
        return Some(boolean);
    }
    match value.as_str()?.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

pub fn number_field(body: &Map<String, Value>, field: &str) -> Option<f64> {
    body.get(field)
        .and_then(|value| {
            value
                .as_f64()
                .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
        })
        .filter(|value| value.is_finite())
}

pub fn row_value(map: Map<String, Value>) -> Value {
    Value::Object(map)
}
