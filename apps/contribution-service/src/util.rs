// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Small pure helpers shared by the handlers and storage layer.

use chrono::{SecondsFormat, Utc};
use serde_json::{Map, Value};
use std::collections::HashSet;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

/// Strip HTML tags and escape entities, matching `bleach.clean(tags=[], strip=True)`.
pub fn sanitize_html(input: &str) -> String {
    ammonia::Builder::default()
        .tags(HashSet::new())
        .clean(input)
        .to_string()
}

/// Normalize Unicode, remove diacritics, map `đ/Đ` to `d`, and lowercase.
pub fn normalize_vietnamese(input: &str) -> String {
    let stripped: String = input
        .nfkd()
        .filter(|character| !unicode_normalization::char::is_combining_mark(*character))
        .collect();
    stripped.replace(['đ', 'Đ'], "d").to_lowercase()
}

/// RFC3339 UTC with a `+00:00` suffix and microseconds, matching Python's
/// `datetime.now(timezone.utc).isoformat()`.
pub fn now_utc_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false)
}

/// Naive UTC timestamp with microseconds, matching `datetime.now().isoformat()`
/// in the UTC container used by the Python backend.
pub fn now_naive_iso() -> String {
    Utc::now()
        .naive_utc()
        .format("%Y-%m-%dT%H:%M:%S%.6f")
        .to_string()
}

/// 32 hex characters, matching `uuid4().hex`.
pub fn new_id() -> String {
    Uuid::new_v4().simple().to_string()
}

/// Best-effort Python `str()` for JSON values. Used for payload size limits
/// and CSV cells containing nested objects.
pub fn python_repr(value: &Value) -> String {
    match value {
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'")),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(python_repr).collect::<Vec<_>>().join(", ")
        ),
        Value::Object(map) => format!(
            "{{{}}}",
            map.iter()
                .map(|(key, value)| format!(
                    "'{}': {}",
                    key.replace('\\', "\\\\").replace('\'', "\\'"),
                    python_repr(value)
                ))
                .collect::<Vec<_>>()
                .join(", ")
        ),
    }
}

/// Python `str(value)` as used by `csv.DictWriter`.
pub fn csv_cell(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        Value::Number(number) => number.to_string(),
        other => python_repr(other),
    }
}

/// Recursively sanitize every string in a JSON value.
pub fn sanitize_json_strings(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(sanitize_html(text)),
        Value::Array(items) => Value::Array(items.iter().map(sanitize_json_strings).collect()),
        Value::Object(map) => {
            let mut cleaned = Map::new();
            for (key, value) in map {
                cleaned.insert(key.clone(), sanitize_json_strings(value));
            }
            Value::Object(cleaned)
        }
        other => other.clone(),
    }
}

/// Prefix CSV formula-leading characters to prevent spreadsheet injection.
pub fn csv_safe(value: String) -> String {
    let first = value.chars().next();
    if matches!(first, Some('=' | '+' | '-' | '@')) {
        format!("'{value}")
    } else {
        value
    }
}

/// Validate that a value looks like a GeoJSON geometry (`type` + `coordinates`).
pub fn is_geometry(value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    object.get("type").and_then(Value::as_str).is_some()
        && object
            .get("coordinates")
            .map(Value::is_array)
            .unwrap_or(false)
}
