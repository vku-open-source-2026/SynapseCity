// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! CSV export with the same filtering, column order and injection guard as the
//! Python backend.

use crate::error::ApiError;
use crate::models::ExportQuery;
use crate::state::SharedState;
use crate::util::{csv_cell, csv_safe, normalize_vietnamese, python_repr};
use axum::extract::{Query, State};
use axum::http::header::{CONTENT_DISPOSITION, CONTENT_TYPE};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use csv::{Terminator, WriterBuilder};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const TYPE_MAPPING: &[(&str, &str)] = &[
    ("Trạm điện", "tram_dien"),
    ("Cột điện", "cot_dien"),
    ("Đường ống điện", "duong_ong_dien"),
    ("Đèn đường", "den_duong"),
    ("Đèn giao thông", "den_giao_thong"),
    ("Cống thoát nước", "cong_thoat_nuoc"),
    ("Ống dẫn nước", "ong_dan_nuoc"),
    ("Trụ chữa cháy", "tru_chua_chay"),
    ("Trạm sạc", "tram_sac"),
];

pub async fn export_csv(
    State(state): State<SharedState>,
    Query(query): Query<ExportQuery>,
) -> Result<Response, ApiError> {
    let features = state.storage.get_features().await?;
    let bytes = build_csv(&features, query.types.as_deref())?;
    Ok((
        StatusCode::OK,
        [
            (CONTENT_TYPE, "text/csv; charset=utf-8"),
            (CONTENT_DISPOSITION, "attachment; filename=features.csv"),
        ],
        bytes,
    )
        .into_response())
}

pub fn build_csv(features: &[Value], types: Option<&str>) -> Result<Vec<u8>, ApiError> {
    let requested = types.map(|value| {
        value
            .split(',')
            .filter(|item| !item.trim().is_empty())
            .map(normalize_vietnamese)
            .collect::<BTreeSet<_>>()
    });

    let filtered: Vec<&Value> = features
        .iter()
        .filter(|feature| match &requested {
            None => true,
            Some(requested) => {
                let properties = feature
                    .get("properties")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let feature_type = properties
                    .get("feature_type")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let mut code = feature
                    .get("feature_code")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                if code.is_empty() {
                    code = type_mapping(feature_type).unwrap_or("").to_string();
                }
                let normalized_code = normalize_vietnamese(&code).replace(' ', "_");
                let normalized_type = normalize_vietnamese(feature_type).replace(' ', "_");
                (!normalized_code.is_empty() && requested.contains(&normalized_code))
                    || (!normalized_type.is_empty() && requested.contains(&normalized_type))
            }
        })
        .collect();

    let mut rows: Vec<Map<String, Value>> = Vec::new();
    let mut all_keys: BTreeSet<String> = BTreeSet::new();
    for feature in filtered {
        let properties = feature
            .get("properties")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let geometry = feature.get("geometry");
        let geom_type = geometry
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let coords = geometry
            .and_then(|value| value.get("coordinates"))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new()));
        let wkt = format!("{} {}", geom_type.to_uppercase(), python_repr(&coords));

        let mut raw_code = feature
            .get("feature_code")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if raw_code.is_empty() {
            raw_code = properties
                .get("feature_type")
                .and_then(Value::as_str)
                .and_then(type_mapping)
                .unwrap_or("")
                .to_string();
        }
        let feature_code = normalize_vietnamese(&raw_code).replace(' ', "_");

        let mut row = Map::new();
        row.insert(
            "feature_type".to_string(),
            properties
                .get("feature_type")
                .cloned()
                .unwrap_or_else(|| Value::String(String::new())),
        );
        row.insert("feature_code".to_string(), Value::String(feature_code));
        row.insert("geometry".to_string(), Value::String(wkt));
        // Python's `{**props}` lets properties override the three base columns.
        for (key, value) in &properties {
            row.insert(key.clone(), value.clone());
        }

        let safe_row: Map<String, Value> = row
            .into_iter()
            .map(|(key, value)| {
                let cell = csv_safe(csv_cell(&value));
                all_keys.insert(key.clone());
                (key, Value::String(cell))
            })
            .collect();
        rows.push(safe_row);
    }

    let mut header = vec![
        "feature_type".to_string(),
        "feature_code".to_string(),
        "geometry".to_string(),
    ];
    for key in all_keys {
        if !header.contains(&key) {
            header.push(key);
        }
    }

    let mut writer = WriterBuilder::new()
        .terminator(Terminator::CRLF)
        .from_writer(Vec::new());
    writer
        .write_record(&header)
        .map_err(|error| ApiError::internal(format!("CSV error: {error}")))?;
    for row in rows {
        let record = header
            .iter()
            .map(|key| {
                row.get(key)
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string()
            })
            .collect::<Vec<_>>();
        writer
            .write_record(&record)
            .map_err(|error| ApiError::internal(format!("CSV error: {error}")))?;
    }
    let mut bytes = writer
        .into_inner()
        .map_err(|error| ApiError::internal(format!("CSV error: {error}")))?;
    // A single UTF-8 BOM is correct CSV; the Python version prepends one per
    // streamed chunk, which is treated as a bug here.
    let mut output = Vec::with_capacity(bytes.len() + 3);
    output.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    output.append(&mut bytes);
    Ok(output)
}

fn type_mapping(feature_type: &str) -> Option<&'static str> {
    TYPE_MAPPING
        .iter()
        .find(|(name, _)| *name == feature_type)
        .map(|(_, code)| *code)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn csv_has_expected_header_and_bom() {
        let features = vec![json!({
            "type": "Feature",
            "feature_code": "den_duong",
            "properties": { "feature_type": "Đèn đường", "name": "A" },
            "geometry": { "type": "Point", "coordinates": [106.7, 10.7] },
        })];
        let bytes = build_csv(&features, None).unwrap();
        assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(text.starts_with("feature_type,feature_code,geometry,name\r\n"));
        assert!(
            text.contains("Đèn đường,den_duong,\"POINT [106.7, 10.7]\",A"),
            "{text:?}"
        );
    }

    #[test]
    fn filters_by_normalized_type() {
        let features = vec![json!({
            "properties": { "feature_type": "Trạm điện" },
            "geometry": { "type": "Point", "coordinates": [1.0, 2.0] },
        })];
        let bytes = build_csv(&features, Some("tram_dien")).unwrap();
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(text.contains("tram_dien"));
    }

    #[test]
    fn csv_injection_is_prefixed() {
        let features = vec![json!({
            "properties": { "feature_type": "=cmd", "name": "+SUM(A1)" },
            "geometry": { "type": "Point", "coordinates": [1.0, 2.0] },
        })];
        let bytes = build_csv(&features, None).unwrap();
        let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
        assert!(text.contains("'=cmd"));
        assert!(text.contains("'+SUM(A1)"));
    }
}
