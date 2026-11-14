// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Incident public/private split (port of `src/incidents.ts`).
//!
//! `city-incidents` is the public projection, so the record written to Tier-2
//! may only contain fields that are safe for the anonymous SynapseLDS export.
//! Reporter identity, contact details, internal notes and internal comments are
//! stored in the private `city-incident-internal` sidecar instead of being
//! stripped at read time.

use serde_json::Value;

use super::{
    first_truthy, iso_from_millis, js_string, js_truthy, now_millis, parse_timestamp_millis,
    string_value, JsonMap,
};

pub const INTERNAL_INCIDENT_FIELDS: [&str; 18] = [
    "reported_by",
    "contact_info",
    "reporter_name",
    "reporter_phone",
    "reporter_email",
    "reporter_id_card",
    "internal_notes",
    "internal_attachments",
    "assigned_to",
    "assigned_at",
    "resolution_notes",
    "merged_reporter_ids",
    "maintenance_record_id",
    "cost_status",
    "cost_approved_at",
    "cost_approval_id",
    "cost_approved_by",
    "cost_approval_roles",
];

pub const PUBLIC_FIELDS: [&str; 26] = [
    "id",
    "incidentId",
    "incident_number",
    "incident_code",
    "title",
    "description",
    "category",
    "severity",
    "status",
    "asset_id",
    "location",
    "occurredAt",
    "reported_at",
    "created_at",
    "updated_at",
    "upvotes",
    "photos",
    "public_visible",
    "reporter_type",
    "resolution_type",
    "resolved_at",
    "closed_at",
    "acknowledged_at",
    "merged_into",
    "source",
    "sourceVersion",
];

fn public_comment(comment: &Value) -> Option<JsonMap> {
    let entry = comment.as_object()?;
    if matches!(entry.get("is_internal"), Some(Value::Bool(true))) {
        return None;
    }
    let mut clean = JsonMap::new();
    if let Some(value) = entry.get("id") {
        clean.insert("id".to_string(), value.clone());
    }
    if let Some(value) = entry.get("comment") {
        clean.insert("comment".to_string(), value.clone());
    }
    if let Some(value) = first_truthy(entry, &["posted_at", "created_at"]) {
        clean.insert("posted_at".to_string(), value.clone());
    }
    if let Some(value) = first_truthy(entry, &["created_at", "posted_at"]) {
        clean.insert("created_at".to_string(), value.clone());
    }
    clean.insert("is_internal".to_string(), Value::Bool(false));
    if entry.get("user_name").map(js_truthy).unwrap_or(false)
        && matches!(entry.get("public_author"), Some(Value::Bool(true)))
    {
        if let Some(value) = entry.get("user_name") {
            clean.insert("user_name".to_string(), value.clone());
        }
    }
    Some(clean)
}

/// Redacts a full operational incident into the public projection shape.
pub fn to_published_incident(record: &JsonMap) -> JsonMap {
    let mut published = JsonMap::new();
    for field in PUBLIC_FIELDS {
        if let Some(value) = record.get(field) {
            published.insert(field.to_string(), value.clone());
        }
    }
    for field in INTERNAL_INCIDENT_FIELDS {
        published.remove(field);
    }

    let comments: Vec<Value> = record
        .get("comments")
        .and_then(Value::as_array)
        .map(|comments| {
            comments
                .iter()
                .filter_map(public_comment)
                .map(Value::Object)
                .collect()
        })
        .unwrap_or_default();
    published.insert("comments".to_string(), Value::Array(comments));

    let reporter_type = string_value(record.get("reporter_type"));
    published.insert(
        "reporter_type".to_string(),
        Value::String(if reporter_type.is_empty() {
            "citizen".to_string()
        } else {
            reporter_type
        }),
    );
    if !record.contains_key("public_visible") {
        published.insert("public_visible".to_string(), Value::Bool(true));
    }
    published
}

/// Extracts the fields that may only live in the private sidecar dataset.
pub fn to_internal_incident(record: &JsonMap) -> Option<JsonMap> {
    let mut internal = JsonMap::new();
    for field in INTERNAL_INCIDENT_FIELDS {
        if let Some(value) = record.get(field) {
            internal.insert(field.to_string(), value.clone());
        }
    }
    let internal_comments: Vec<Value> = record
        .get("comments")
        .and_then(Value::as_array)
        .map(|comments| {
            comments
                .iter()
                .filter(|comment| {
                    comment
                        .as_object()
                        .map(|entry| matches!(entry.get("is_internal"), Some(Value::Bool(true))))
                        .unwrap_or(false)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if !internal_comments.is_empty() {
        internal.insert(
            "internal_comments".to_string(),
            Value::Array(internal_comments),
        );
    }
    if internal.is_empty() {
        return None;
    }
    let updated_at = first_truthy(record, &["updated_at"])
        .cloned()
        .unwrap_or_else(|| Value::String(iso_from_millis(now_millis())));
    internal.insert("updated_at".to_string(), updated_at);
    Some(internal)
}

/// Merges the private sidecar back into an operator-facing incident view.
pub fn merge_incident_internal(public_incident: &JsonMap, internal: Option<&JsonMap>) -> JsonMap {
    let Some(internal) = internal else {
        return public_incident.clone();
    };
    let mut merged = public_incident.clone();
    for field in INTERNAL_INCIDENT_FIELDS {
        if let Some(value) = internal.get(field) {
            merged.insert(field.to_string(), value.clone());
        }
    }

    let mut comments: Vec<Value> = public_incident
        .get("comments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if let Some(internal_comments) = internal.get("internal_comments").and_then(Value::as_array) {
        comments.extend(internal_comments.iter().cloned());
    }
    comments.sort_by(|left, right| {
        let timestamp = |value: &Value| {
            value
                .as_object()
                .and_then(|entry| entry.get("created_at"))
                .map(js_string)
                .and_then(|raw| parse_timestamp_millis(&raw))
        };
        match (timestamp(left), timestamp(right)) {
            (Some(left), Some(right)) => left.cmp(&right),
            // The TS comparator yields NaN for an unparsable date; Array.sort
            // treats that as "equal" and keeps the original order.
            _ => std::cmp::Ordering::Equal,
        }
    });
    merged.insert("comments".to_string(), Value::Array(comments));
    merged
}

/// Final read-time redaction for the anonymous public API.
pub fn to_public_incident_view(record: &JsonMap) -> JsonMap {
    let mut view = to_published_incident(record);
    view.remove("reported_by");
    view.remove("assigned_to");
    view.remove("resolution_notes");
    view.insert(
        "reporter_type".to_string(),
        Value::String("citizen".to_string()),
    );
    view
}

pub fn incident_is_publicly_visible(record: &JsonMap) -> bool {
    if matches!(record.get("public_visible"), Some(Value::Bool(false))) {
        return false;
    }
    if record.get("deleted_at").map(js_truthy).unwrap_or(false) {
        return false;
    }
    let status = string_value(record.get("status")).to_lowercase();
    !["deleted", "purged", "rejected"].contains(&status.as_str())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> JsonMap {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn published_projection_drops_private_fields_and_internal_comments() {
        let record = map(json!({
            "id": "inc-1",
            "incident_number": "INC-1",
            "title": "Broken lamp",
            "status": "open",
            "reported_by": "reporter-user",
            "contact_info": "secret@example.com",
            "assigned_to": "technician-user",
            "internal_notes": "private note",
            "cost_status": "approved",
            "comments": [
                { "id": "c1", "comment": "public", "created_at": "2026-11-02T00:00:00Z", "is_internal": false,
                  "user_name": "Citizen", "public_author": true },
                { "id": "c2", "comment": "private", "created_at": "2026-11-03T00:00:00Z", "is_internal": true }
            ]
        }));
        let published = to_published_incident(&record);
        assert_eq!(published.get("title").unwrap(), "Broken lamp");
        assert!(!published.contains_key("reported_by"));
        assert!(!published.contains_key("contact_info"));
        assert!(!published.contains_key("assigned_to"));
        assert!(!published.contains_key("internal_notes"));
        assert!(!published.contains_key("cost_status"));
        assert_eq!(published.get("reporter_type").unwrap(), "citizen");
        assert_eq!(published.get("public_visible").unwrap(), true);
        let comments = published.get("comments").unwrap().as_array().unwrap();
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].get("comment").unwrap(), "public");
        assert_eq!(
            comments[0].get("posted_at").unwrap(),
            "2026-11-02T00:00:00Z"
        );
        assert_eq!(comments[0].get("is_internal").unwrap(), false);
        assert_eq!(comments[0].get("user_name").unwrap(), "Citizen");
    }

    #[test]
    fn internal_sidecar_only_exists_when_private_data_exists() {
        assert!(to_internal_incident(&map(json!({ "id": "inc-1", "title": "x" }))).is_none());

        let record = map(json!({
            "id": "inc-1",
            "reporter_phone": "0900",
            "internal_notes": "note",
            "updated_at": "2026-11-04T00:00:00Z",
            "comments": [
                { "id": "c1", "comment": "public", "is_internal": false },
                { "id": "c2", "comment": "private", "is_internal": true }
            ]
        }));
        let internal = to_internal_incident(&record).unwrap();
        assert_eq!(internal.get("reporter_phone").unwrap(), "0900");
        assert_eq!(internal.get("internal_notes").unwrap(), "note");
        assert_eq!(internal.get("updated_at").unwrap(), "2026-11-04T00:00:00Z");
        assert_eq!(
            internal
                .get("internal_comments")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn merge_restores_private_fields_and_sorts_comments() {
        let public = map(json!({
            "id": "inc-1",
            "comments": [
                { "id": "c2", "created_at": "2026-11-03T00:00:00Z" },
                { "id": "c1", "created_at": "2026-11-01T00:00:00Z" }
            ]
        }));
        let internal = map(json!({
            "assigned_to": "tech-1",
            "internal_notes": "note",
            "internal_comments": [
                { "id": "c3", "created_at": "2026-11-02T00:00:00Z", "is_internal": true }
            ]
        }));
        let merged = merge_incident_internal(&public, Some(&internal));
        assert_eq!(merged.get("assigned_to").unwrap(), "tech-1");
        assert_eq!(merged.get("internal_notes").unwrap(), "note");
        let ids: Vec<&str> = merged
            .get("comments")
            .unwrap()
            .as_array()
            .unwrap()
            .iter()
            .map(|comment| comment.get("id").unwrap().as_str().unwrap())
            .collect();
        assert_eq!(ids, vec!["c1", "c3", "c2"]);

        let untouched = merge_incident_internal(&public, None);
        assert_eq!(untouched, public);
    }

    #[test]
    fn public_view_forces_citizen_and_visibility_respects_status() {
        let record = map(json!({
            "id": "inc-1",
            "reporter_type": "operator",
            "reported_by": "u1",
            "comments": []
        }));
        let view = to_public_incident_view(&record);
        assert_eq!(view.get("reporter_type").unwrap(), "citizen");
        assert!(!view.contains_key("reported_by"));

        assert!(incident_is_publicly_visible(&map(
            json!({ "status": "open" })
        )));
        assert!(!incident_is_publicly_visible(&map(
            json!({ "status": "rejected" })
        )));
        assert!(!incident_is_publicly_visible(&map(
            json!({ "public_visible": false })
        )));
        assert!(!incident_is_publicly_visible(&map(
            json!({ "deleted_at": "2026-01-01" })
        )));
    }
}
