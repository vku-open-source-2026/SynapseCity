// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Pure City business logic, ported one-to-one from the TypeScript service.
//!
//! Every module in this tree is side-effect free: it works on plain JSON
//! records, never touches the network, storage or process environment, and can
//! therefore be unit tested without a running Tier-2 capability.

pub mod alerts;
pub mod analytics;
pub mod authz;
pub mod csv;
pub mod files;
pub mod geo;
pub mod incidents;
pub mod notifications;
pub mod preventive;
pub mod reports;
pub mod risk;

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};
use serde_json::Value;

/// The record representation used throughout the domain modules. It matches the
/// `Record<string, unknown>` objects the TypeScript service stores in Tier-2.
pub type JsonMap = serde_json::Map<String, Value>;

// ---------------------------------------------------------------------------
// JavaScript-compatible value helpers
// ---------------------------------------------------------------------------

/// JavaScript truthiness for JSON values.
pub(crate) fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number
            .as_f64()
            .map(|float| float != 0.0 && !float.is_nan())
            .unwrap_or(false),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// Formats a finite number the way JavaScript's `String(number)` does for the
/// values this service produces (integral floats stay integral).
pub(crate) fn js_number_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value == f64::INFINITY {
        return "Infinity".to_string();
    }
    if value == f64::NEG_INFINITY {
        return "-Infinity".to_string();
    }
    if value == 0.0 {
        return "0".to_string();
    }
    // JS integral numbers < 1e21 have no decimal point.
    if value.fract() == 0.0 && value.abs() < 1e21 {
        return format!("{value:.0}");
    }
    format!("{value}")
}

/// JavaScript `String(value)` for JSON values.
pub(crate) fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number
            .as_f64()
            .map(js_number_string)
            .unwrap_or_else(|| number.to_string()),
        Value::String(text) => text.clone(),
        Value::Array(_) | Value::Object(_) => {
            serde_json::to_string(value).unwrap_or_else(|_| String::new())
        }
    }
}

/// JavaScript `String(value || '')`: falsy values become an empty string.
pub(crate) fn string_value(value: Option<&Value>) -> String {
    match value {
        Some(value) if js_truthy(value) => js_string(value),
        _ => String::new(),
    }
}

/// The TypeScript `text()` helper: `null`/`undefined` become `''`, everything
/// else goes through `String(value)` (so `false` becomes `"false"`).
pub(crate) fn text_value(value: Option<&Value>) -> String {
    match value {
        None | Some(Value::Null) => String::new(),
        Some(value) => js_string(value),
    }
}

/// JavaScript `Number(value)` returning `None` when the result is not finite.
pub(crate) fn number_from_value(value: &Value) -> Option<f64> {
    let parsed = match value {
        Value::Null => Some(0.0),
        Value::Bool(flag) => Some(if *flag { 1.0 } else { 0.0 }),
        Value::Number(number) => number.as_f64(),
        Value::String(text) => {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                Some(0.0)
            } else {
                trimmed.parse::<f64>().ok()
            }
        }
        Value::Array(_) | Value::Object(_) => None,
    };
    parsed.filter(|float| float.is_finite())
}

/// First key that is present and not JSON `null` (JavaScript `??`).
pub(crate) fn first_non_null<'a>(map: &'a JsonMap, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| match map.get(*key) {
        None | Some(Value::Null) => None,
        Some(value) => Some(value),
    })
}

/// First key whose value is JavaScript-truthy (JavaScript `||`).
pub(crate) fn first_truthy<'a>(map: &'a JsonMap, keys: &[&str]) -> Option<&'a Value> {
    keys.iter().find_map(|key| match map.get(*key) {
        Some(value) if js_truthy(value) => Some(value),
        _ => None,
    })
}

/// JavaScript `Math.round`.
pub(crate) fn js_round(value: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    (value + 0.5).floor()
}

/// Clamps a number between `min` and `max` (mirrors the risk `clamp` helper).
pub(crate) fn clamp_number(value: f64, min: f64, max: f64) -> f64 {
    value.max(min).min(max)
}

/// Builds a JSON number, using an integer representation when possible so that
/// serialized output matches JavaScript's `JSON.stringify` for whole numbers.
pub(crate) fn json_number(value: f64) -> Value {
    if !value.is_finite() {
        return Value::Null;
    }
    if value.fract() == 0.0 && value >= i64::MIN as f64 && value <= i64::MAX as f64 {
        return Value::from(value as i64);
    }
    serde_json::Number::from_f64(value)
        .map(Value::Number)
        .unwrap_or(Value::Null)
}

/// JavaScript `Date.parse` for the timestamp formats the service accepts.
pub(crate) fn parse_timestamp_millis(raw: &str) -> Option<i64> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(date) = NaiveDate::parse_from_str(trimmed, "%Y-%m-%d") {
        return date
            .and_hms_opt(0, 0, 0)
            .map(|naive| naive.and_utc().timestamp_millis());
    }
    for format in [
        "%Y-%m-%dT%H:%M:%S%.f",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M:%S",
    ] {
        if let Ok(naive) = NaiveDateTime::parse_from_str(trimmed, format) {
            return Some(naive.and_utc().timestamp_millis());
        }
    }
    None
}

/// JavaScript `new Date(millis).toISOString()` (always UTC, millisecond
/// precision, `Z` suffix).
pub(crate) fn iso_from_millis(millis: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(millis)
        .map(|date| date.to_rfc3339_opts(SecondsFormat::Millis, true))
        .unwrap_or_else(|| "1970-01-01T00:00:00.000Z".to_string())
}

/// Current time in Unix milliseconds.
pub(crate) fn now_millis() -> i64 {
    Utc::now().timestamp_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn javascript_string_helpers_handle_falsy_values() {
        assert_eq!(string_value(Some(&json!(0))), "");
        assert_eq!(string_value(Some(&json!(false))), "");
        assert_eq!(string_value(Some(&json!(""))), "");
        assert_eq!(string_value(Some(&json!(12.0))), "12");
        assert_eq!(text_value(Some(&json!(false))), "false");
        assert_eq!(text_value(Some(&Value::Null)), "");
        assert_eq!(text_value(None), "");
    }

    #[test]
    fn timestamps_round_trip_as_iso_millis() {
        let millis = parse_timestamp_millis("2026-11-04T00:00:00Z").unwrap();
        assert_eq!(iso_from_millis(millis), "2026-11-04T00:00:00.000Z");
    }

    #[test]
    fn round_matches_javascript_for_half_values() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(2.4), 2.0);
        assert_eq!(js_round(-2.5), -2.0);
    }
}
