// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Infrastructure alert -> maintenance automation rules
//! (port of `src/alerts.ts`).
//!
//! A critical/high alert that has been acknowledged and is linked to an asset
//! produces exactly one work order. Callers persist `source_alert_id` and check
//! for an existing order before creating a new one, which makes retries
//! idempotent.

use serde_json::Value;

use super::{first_truthy, iso_from_millis, js_string, now_millis, string_value, JsonMap};

pub const MAINTENANCE_ALERT_SEVERITIES: [&str; 2] = ["critical", "high"];

fn sla_hours(severity: &str) -> i64 {
    match severity {
        "critical" => 4,
        "high" => 24,
        "medium" => 72,
        "low" => 168,
        _ => 72,
    }
}

fn priority_for(severity: &str) -> &'static str {
    match severity {
        "critical" => "urgent",
        "high" => "high",
        "medium" => "medium",
        "low" => "low",
        _ => "medium",
    }
}

/// JavaScript `String(alert.id)` behaviour, including the `"undefined"` text
/// produced for a missing id in template literals.
fn ts_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => js_string(value),
    }
}

pub fn is_trigger_severity(severity: &str) -> bool {
    MAINTENANCE_ALERT_SEVERITIES.contains(&severity.to_lowercase().as_str())
}

pub fn should_create_maintenance(alert: &JsonMap) -> bool {
    let status = string_value(alert.get("status")).to_lowercase();
    let asset_id = string_value(first_truthy(alert, &["asset_id", "assetId"]))
        .trim()
        .to_string();
    let severity = string_value(alert.get("severity"));
    is_trigger_severity(&severity)
        && !asset_id.is_empty()
        && ["acknowledged", "active", "open"].contains(&status.as_str())
}

/// ISO timestamp at which a work order of `severity` becomes overdue.
pub fn sla_due_at(severity: &str, now: Option<i64>) -> String {
    let hours = sla_hours(&severity.to_lowercase());
    let now = now.unwrap_or_else(now_millis);
    iso_from_millis(now + hours * 3_600_000)
}

/// Builds the corrective maintenance work order for an alert.
pub fn maintenance_from_alert(alert: &JsonMap, now: Option<i64>) -> JsonMap {
    let now = now.unwrap_or_else(now_millis);
    let severity = string_value(alert.get("severity")).to_lowercase();
    let severity = if severity.is_empty() {
        "medium".to_string()
    } else {
        severity
    };
    let asset_id = string_value(first_truthy(alert, &["asset_id", "assetId"]));
    let alert_id = ts_string(alert.get("id"));
    let title_source = ts_string(first_truthy(alert, &["title", "id"]));
    let title: String = format!("Alert {title_source}: corrective maintenance")
        .chars()
        .take(200)
        .collect();
    let description = string_value(alert.get("description"));
    let created_at = iso_from_millis(now);

    let mut maintenance = JsonMap::new();
    maintenance.insert("id".to_string(), Value::String(format!("alert-{alert_id}")));
    maintenance.insert("asset_id".to_string(), Value::String(asset_id));
    maintenance.insert("source_alert_id".to_string(), Value::String(alert_id));
    maintenance.insert("title".to_string(), Value::String(title));
    maintenance.insert("description".to_string(), Value::String(description));
    maintenance.insert("type".to_string(), Value::String("corrective".to_string()));
    maintenance.insert("status".to_string(), Value::String("scheduled".to_string()));
    maintenance.insert(
        "priority".to_string(),
        Value::String(priority_for(&severity).to_string()),
    );
    maintenance.insert("severity".to_string(), Value::String(severity.clone()));
    maintenance.insert(
        "sla_due_at".to_string(),
        Value::String(sla_due_at(&severity, Some(now))),
    );
    maintenance.insert(
        "scheduled_date".to_string(),
        Value::String(created_at.clone()),
    );
    maintenance.insert("created_at".to_string(), Value::String(created_at));
    maintenance.insert(
        "source".to_string(),
        Value::String("synapsecity-alert-automation".to_string()),
    );
    maintenance
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> JsonMap {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn only_critical_and_high_acknowledged_alerts_trigger_work() {
        assert!(should_create_maintenance(&map(json!({
            "id": "a1", "severity": "critical", "status": "open", "asset_id": "asset-1"
        }))));
        assert!(should_create_maintenance(&map(json!({
            "id": "a2", "severity": "HIGH", "status": "acknowledged", "assetId": "asset-1"
        }))));
        assert!(!should_create_maintenance(&map(json!({
            "id": "a3", "severity": "low", "status": "open", "asset_id": "asset-1"
        }))));
        assert!(!should_create_maintenance(&map(json!({
            "id": "a4", "severity": "critical", "status": "resolved", "asset_id": "asset-1"
        }))));
        assert!(!should_create_maintenance(&map(json!({
            "id": "a5", "severity": "critical", "status": "open", "asset_id": "  "
        }))));
    }

    #[test]
    fn maintenance_order_matches_the_alert_contract() {
        let now = 1_800_000_000_000i64;
        let order = maintenance_from_alert(
            &map(json!({
                "id": "alert-crit",
                "title": "Transformer overheating",
                "description": "Temperature above threshold",
                "severity": "critical",
                "status": "acknowledged",
                "asset_id": "asset-1"
            })),
            Some(now),
        );
        assert_eq!(order.get("id").unwrap(), "alert-alert-crit");
        assert_eq!(order.get("asset_id").unwrap(), "asset-1");
        assert_eq!(order.get("source_alert_id").unwrap(), "alert-crit");
        assert_eq!(order.get("priority").unwrap(), "urgent");
        assert_eq!(order.get("type").unwrap(), "corrective");
        assert_eq!(order.get("status").unwrap(), "scheduled");
        assert_eq!(
            order.get("sla_due_at").unwrap(),
            &Value::String(iso_from_millis(now + 4 * 3_600_000))
        );
        assert_eq!(
            order.get("scheduled_date").unwrap(),
            &Value::String(iso_from_millis(now))
        );
    }

    #[test]
    fn sla_defaults_and_priorities_follow_severity() {
        let now = 1_800_000_000_000i64;
        assert_eq!(
            sla_due_at("high", Some(now)),
            iso_from_millis(now + 24 * 3_600_000)
        );
        assert_eq!(
            sla_due_at("unknown", Some(now)),
            iso_from_millis(now + 72 * 3_600_000)
        );
        let low = maintenance_from_alert(
            &map(json!({ "id": "a", "severity": "low", "asset_id": "x" })),
            Some(now),
        );
        assert_eq!(low.get("priority").unwrap(), "low");
        assert_eq!(low.get("severity").unwrap(), "low");
    }

    #[test]
    fn missing_title_falls_back_to_the_alert_id() {
        let order = maintenance_from_alert(
            &map(json!({ "id": "a1", "severity": "high", "asset_id": "x" })),
            Some(0),
        );
        assert_eq!(
            order.get("title").unwrap(),
            "Alert a1: corrective maintenance"
        );
    }
}
