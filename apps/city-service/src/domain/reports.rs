// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! City-owned operational report generation (port of `src/reports.ts`).
//!
//! Reports are rendered from City records (assets, incidents, maintenance) into
//! CSV or JSON bytes. CSV cells are escaped and formula injection is
//! neutralized; `pdf` and `excel` are deliberately rejected rather than faked.

use chrono::{DateTime, Datelike, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    first_truthy, iso_from_millis, js_string, js_truthy, json_number, number_from_value,
    parse_timestamp_millis, text_value, JsonMap,
};

pub const SUPPORTED_REPORT_TYPES: [&str; 5] = [
    "maintenance_summary",
    "incident_summary",
    "lifecycle_overview",
    "end_of_life_forecast",
    "custom",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReportType {
    MaintenanceSummary,
    IncidentSummary,
    LifecycleOverview,
    EndOfLifeForecast,
    Custom,
}

impl ReportType {
    pub fn as_str(self) -> &'static str {
        match self {
            ReportType::MaintenanceSummary => "maintenance_summary",
            ReportType::IncidentSummary => "incident_summary",
            ReportType::LifecycleOverview => "lifecycle_overview",
            ReportType::EndOfLifeForecast => "end_of_life_forecast",
            ReportType::Custom => "custom",
        }
    }

    pub fn from_str(value: &str) -> Option<Self> {
        match value {
            "maintenance_summary" => Some(ReportType::MaintenanceSummary),
            "incident_summary" => Some(ReportType::IncidentSummary),
            "lifecycle_overview" => Some(ReportType::LifecycleOverview),
            "end_of_life_forecast" => Some(ReportType::EndOfLifeForecast),
            "custom" => Some(ReportType::Custom),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReportFormat {
    Csv,
    Json,
}

impl ReportFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            ReportFormat::Csv => "csv",
            ReportFormat::Json => "json",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReportError {
    UnsupportedFormat(String),
    UnsupportedType(String),
}

impl ReportError {
    pub fn status(&self) -> u16 {
        match self {
            ReportError::UnsupportedFormat(_) => 415,
            ReportError::UnsupportedType(_) => 400,
        }
    }

    pub fn message(&self) -> String {
        match self {
            ReportError::UnsupportedFormat(format) => {
                format!("unsupported_report_format:{format}")
            }
            ReportError::UnsupportedType(report_type) => {
                format!("unsupported_report_type:{report_type}")
            }
        }
    }
}

impl std::fmt::Display for ReportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message())
    }
}

impl std::error::Error for ReportError {}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReportRowSet {
    pub columns: Vec<String>,
    pub rows: Vec<JsonMap>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ReportContext {
    #[serde(default)]
    pub asset: Option<JsonMap>,
    #[serde(default)]
    pub assets: Vec<JsonMap>,
    #[serde(default)]
    pub incidents: Vec<JsonMap>,
    #[serde(default)]
    pub maintenance: Vec<JsonMap>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReportArtifact {
    pub content: String,
    pub content_type: String,
    pub extension: ReportFormat,
    pub row_count: usize,
    pub sha256: String,
    pub report_type: ReportType,
}

/// `String(value || 'csv').trim().toLowerCase()`, rejecting aliases such as
/// `pdf`/`excel`.
pub fn normalize_report_format(value: Option<&Value>) -> Result<ReportFormat, ReportError> {
    let format = match value {
        Some(value) if js_truthy(value) => js_string(value).trim().to_lowercase(),
        _ => "csv".to_string(),
    };
    match format.as_str() {
        "csv" => Ok(ReportFormat::Csv),
        "json" => Ok(ReportFormat::Json),
        _ => Err(ReportError::UnsupportedFormat(format)),
    }
}

pub fn normalize_report_type(value: Option<&Value>) -> Result<ReportType, ReportError> {
    let report_type = match value {
        Some(value) if js_truthy(value) => js_string(value).trim().to_lowercase(),
        _ => "maintenance_summary".to_string(),
    };
    ReportType::from_str(&report_type).ok_or(ReportError::UnsupportedType(report_type))
}

fn text(value: Option<&Value>) -> String {
    text_value(value)
}

fn numeric(value: Option<&Value>) -> Option<f64> {
    value.and_then(number_from_value)
}

fn insert_text(row: &mut JsonMap, key: &str, value: String) {
    row.insert(key.to_string(), Value::String(value));
}

fn insert_numeric_or_empty(row: &mut JsonMap, key: &str, value: Option<f64>) {
    let value = match value {
        Some(number) => json_number(number),
        None => Value::String(String::new()),
    };
    row.insert(key.to_string(), value);
}

fn within_filters(row: &JsonMap, filters: &JsonMap) -> bool {
    let date_from = filters
        .get("date_from")
        .filter(|value| js_truthy(value))
        .map(js_string)
        .and_then(|raw| parse_timestamp_millis(&raw));
    let date_to = filters
        .get("date_to")
        .filter(|value| js_truthy(value))
        .map(js_string)
        .and_then(|raw| parse_timestamp_millis(&raw));
    let severity = filters
        .get("severity")
        .filter(|value| js_truthy(value))
        .map(|value| js_string(value).to_lowercase());
    let timestamp = first_truthy(
        row,
        &["occurred_at", "reported_at", "scheduled_date", "created_at"],
    )
    .map(js_string)
    .and_then(|raw| parse_timestamp_millis(&raw));

    if let (Some(from), Some(timestamp)) = (date_from, timestamp) {
        if timestamp < from {
            return false;
        }
    }
    if let (Some(to), Some(timestamp)) = (date_to, timestamp) {
        if timestamp > to {
            return false;
        }
    }
    if let Some(severity) = severity {
        if super::string_value(row.get("severity")).to_lowercase() != severity {
            return false;
        }
    }
    true
}

fn maintenance_rows(context: &ReportContext, filters: &JsonMap) -> ReportRowSet {
    let rows = context
        .maintenance
        .iter()
        .filter(|row| within_filters(row, filters))
        .map(|row| {
            let mut mapped = JsonMap::new();
            insert_text(&mut mapped, "work_order_id", text(row.get("id")));
            insert_text(
                &mut mapped,
                "asset_id",
                text(first_truthy(row, &["asset_id", "assetId"])),
            );
            insert_text(&mut mapped, "title", text(row.get("title")));
            insert_text(&mut mapped, "type", text(row.get("type")));
            insert_text(&mut mapped, "status", text(row.get("status")));
            insert_text(&mut mapped, "priority", text(row.get("priority")));
            insert_text(
                &mut mapped,
                "assigned_to",
                text(first_truthy(row, &["assigned_to", "technician"])),
            );
            insert_text(
                &mut mapped,
                "scheduled_date",
                text(row.get("scheduled_date")),
            );
            insert_text(&mut mapped, "completed_at", text(row.get("completed_at")));
            insert_text(
                &mut mapped,
                "source_alert_id",
                text(row.get("source_alert_id")),
            );
            insert_numeric_or_empty(
                &mut mapped,
                "estimated_cost",
                numeric(row.get("estimated_cost")),
            );
            insert_numeric_or_empty(&mut mapped, "actual_cost", numeric(row.get("actual_cost")));
            mapped
        })
        .collect();

    ReportRowSet {
        columns: [
            "work_order_id",
            "asset_id",
            "title",
            "type",
            "status",
            "priority",
            "assigned_to",
            "scheduled_date",
            "completed_at",
            "source_alert_id",
            "estimated_cost",
            "actual_cost",
        ]
        .iter()
        .map(|column| (*column).to_string())
        .collect(),
        rows,
    }
}

fn incident_rows(context: &ReportContext, filters: &JsonMap) -> ReportRowSet {
    let rows = context
        .incidents
        .iter()
        .filter(|row| within_filters(row, filters))
        .map(|row| {
            let mut mapped = JsonMap::new();
            insert_text(&mut mapped, "incident_id", text(row.get("id")));
            insert_text(
                &mut mapped,
                "incident_number",
                text(first_truthy(row, &["incident_number", "incident_code"])),
            );
            insert_text(&mut mapped, "title", text(row.get("title")));
            insert_text(&mut mapped, "category", text(row.get("category")));
            insert_text(&mut mapped, "severity", text(row.get("severity")));
            insert_text(&mut mapped, "status", text(row.get("status")));
            insert_text(
                &mut mapped,
                "asset_id",
                text(first_truthy(row, &["asset_id", "assetId"])),
            );
            insert_text(&mut mapped, "reported_at", text(row.get("reported_at")));
            insert_text(&mut mapped, "resolved_at", text(row.get("resolved_at")));
            insert_text(
                &mut mapped,
                "resolution_type",
                text(row.get("resolution_type")),
            );
            mapped
        })
        .collect();

    ReportRowSet {
        columns: [
            "incident_id",
            "incident_number",
            "title",
            "category",
            "severity",
            "status",
            "asset_id",
            "reported_at",
            "resolved_at",
            "resolution_type",
        ]
        .iter()
        .map(|column| (*column).to_string())
        .collect(),
        rows,
    }
}

fn lifecycle_rows(context: &ReportContext) -> ReportRowSet {
    let empty = JsonMap::new();
    let rows = context
        .assets
        .iter()
        .map(|asset| {
            let lifecycle = asset
                .get("lifecycle")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let mut mapped = JsonMap::new();
            insert_text(
                &mut mapped,
                "asset_code",
                text(first_truthy(asset, &["asset_code", "feature_code", "id"])),
            );
            insert_text(&mut mapped, "name", text(asset.get("name")));
            insert_text(&mut mapped, "feature_type", text(asset.get("feature_type")));
            insert_text(&mut mapped, "status", text(asset.get("status")));
            insert_text(
                &mut mapped,
                "lifecycle_status",
                text(
                    first_truthy(lifecycle, &["lifecycle_status"])
                        .or_else(|| first_truthy(asset, &["lifecycle_stage"])),
                ),
            );
            insert_text(&mut mapped, "condition", text(asset.get("condition")));
            insert_text(
                &mut mapped,
                "commissioned_date",
                text(lifecycle.get("commissioned_date")),
            );
            insert_text(
                &mut mapped,
                "last_maintenance_date",
                text(lifecycle.get("last_maintenance_date")),
            );
            insert_numeric_or_empty(
                &mut mapped,
                "designed_lifespan_years",
                numeric(lifecycle.get("designed_lifespan_years")),
            );
            mapped
        })
        .collect();

    ReportRowSet {
        columns: [
            "asset_code",
            "name",
            "feature_type",
            "status",
            "lifecycle_status",
            "condition",
            "commissioned_date",
            "last_maintenance_date",
            "designed_lifespan_years",
        ]
        .iter()
        .map(|column| (*column).to_string())
        .collect(),
        rows,
    }
}

fn end_of_life_rows(context: &ReportContext, now: i64) -> ReportRowSet {
    let empty = JsonMap::new();
    let current_year = DateTime::<Utc>::from_timestamp_millis(now)
        .map(|date| date.year())
        .unwrap_or(1970);
    let rows = context
        .assets
        .iter()
        .map(|asset| {
            let lifecycle = asset
                .get("lifecycle")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let commissioned = first_truthy(lifecycle, &["commissioned_date"])
                .map(js_string)
                .and_then(|raw| parse_timestamp_millis(&raw));
            let designed = numeric(lifecycle.get("designed_lifespan_years"));
            let age_years = match commissioned {
                Some(commissioned) if commissioned > 0 => Some(
                    super::js_round(((now - commissioned) as f64 / (365.25 * 86_400_000.0)) * 10.0)
                        / 10.0,
                ),
                _ => None,
            };
            let remaining_years = match (age_years, designed) {
                (Some(age), Some(designed)) => {
                    Some((super::js_round((designed - age) * 10.0) / 10.0).max(0.0))
                }
                _ => None,
            };
            let replacement_year = match (age_years, remaining_years) {
                (Some(_), Some(remaining)) => Some(current_year + remaining.ceil() as i32),
                _ => None,
            };

            let mut mapped = JsonMap::new();
            insert_text(
                &mut mapped,
                "asset_code",
                text(first_truthy(asset, &["asset_code", "feature_code", "id"])),
            );
            insert_text(&mut mapped, "name", text(asset.get("name")));
            insert_text(
                &mut mapped,
                "commissioned_date",
                text(lifecycle.get("commissioned_date")),
            );
            insert_numeric_or_empty(&mut mapped, "designed_lifespan_years", designed);
            insert_numeric_or_empty(&mut mapped, "age_years", age_years);
            insert_numeric_or_empty(&mut mapped, "remaining_years", remaining_years);
            insert_numeric_or_empty(
                &mut mapped,
                "projected_replacement_year",
                replacement_year.map(f64::from),
            );
            insert_text(&mut mapped, "status", text(asset.get("status")));
            mapped
        })
        .collect();

    ReportRowSet {
        columns: [
            "asset_code",
            "name",
            "commissioned_date",
            "designed_lifespan_years",
            "age_years",
            "remaining_years",
            "projected_replacement_year",
            "status",
        ]
        .iter()
        .map(|column| (*column).to_string())
        .collect(),
        rows,
    }
}

/// Builds the report row set, applying the `asset_id` scope before the
/// report-specific transform (matching the TS service).
pub fn build_report_row_set(
    report_type: ReportType,
    context: &ReportContext,
    filters: &JsonMap,
) -> ReportRowSet {
    let scoped_storage: ReportContext;
    let scoped: &ReportContext = if filters.get("asset_id").map(js_truthy).unwrap_or(false) {
        let asset_id = js_string(filters.get("asset_id").unwrap());
        let filter_by_asset = |row: &JsonMap| {
            first_truthy(row, &["asset_id", "assetId"])
                .map(js_string)
                .unwrap_or_default()
                == asset_id
        };
        scoped_storage = ReportContext {
            asset: context.asset.clone(),
            assets: context.assets.clone(),
            incidents: context
                .incidents
                .iter()
                .filter(|row| filter_by_asset(row))
                .cloned()
                .collect(),
            maintenance: context
                .maintenance
                .iter()
                .filter(|row| filter_by_asset(row))
                .cloned()
                .collect(),
        };
        &scoped_storage
    } else {
        context
    };

    match report_type {
        ReportType::MaintenanceSummary => maintenance_rows(scoped, filters),
        ReportType::IncidentSummary => incident_rows(scoped, filters),
        ReportType::LifecycleOverview => lifecycle_rows(scoped),
        ReportType::EndOfLifeForecast => end_of_life_rows(scoped, super::now_millis()),
        ReportType::Custom => incident_rows(scoped, filters),
    }
}

/// Neutralizes a spreadsheet formula and applies RFC 4180 quoting when needed.
pub fn csv_cell_text(value: &str) -> String {
    let neutralized = match value.chars().next() {
        Some('=') | Some('+') | Some('-') | Some('@') => format!("'{value}"),
        _ => value.to_string(),
    };
    if neutralized.contains('"')
        || neutralized.contains(',')
        || neutralized.contains('\n')
        || neutralized.contains('\r')
    {
        return format!("\"{}\"", neutralized.replace('"', "\"\""));
    }
    neutralized
}

pub fn csv_cell(value: Option<&Value>) -> String {
    csv_cell_text(&text(value))
}

pub fn serialize_csv(row_set: &ReportRowSet) -> String {
    let header = row_set
        .columns
        .iter()
        .map(|column| csv_cell_text(column))
        .collect::<Vec<_>>()
        .join(",");
    let lines: Vec<String> = row_set
        .rows
        .iter()
        .map(|row| {
            row_set
                .columns
                .iter()
                .map(|column| csv_cell(row.get(column)))
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect();
    let mut all = Vec::with_capacity(lines.len() + 1);
    all.push(header);
    all.extend(lines);
    format!("{}\n", all.join("\n"))
}

fn sha256_hex(content: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content.as_bytes());
    hasher
        .finalize()
        .iter()
        .map(|byte| format!("{:02x}", *byte))
        .collect()
}

pub fn generate_report(
    report_type: ReportType,
    format: ReportFormat,
    context: &ReportContext,
    filters: &JsonMap,
) -> ReportArtifact {
    generate_report_at(report_type, format, context, filters, super::now_millis())
}

/// Deterministic variant used by tests and by callers that already captured the
/// report generation timestamp.
pub fn generate_report_at(
    report_type: ReportType,
    format: ReportFormat,
    context: &ReportContext,
    filters: &JsonMap,
    now: i64,
) -> ReportArtifact {
    let row_set = build_report_row_set(report_type, context, filters);
    let row_count = row_set.rows.len();
    let content = match format {
        ReportFormat::Csv => serialize_csv(&row_set),
        ReportFormat::Json => {
            let payload = serde_json::json!({
                "report_type": report_type.as_str(),
                "generated_at": iso_from_millis(now),
                "row_count": row_set.rows.len(),
                "rows": row_set.rows,
            });
            let mut encoded =
                serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string());
            encoded.push('\n');
            encoded
        }
    };

    ReportArtifact {
        sha256: sha256_hex(&content),
        content,
        content_type: match format {
            ReportFormat::Csv => "text/csv; charset=utf-8".to_string(),
            ReportFormat::Json => "application/json; charset=utf-8".to_string(),
        },
        extension: format,
        row_count,
        report_type,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> JsonMap {
        value.as_object().unwrap().clone()
    }

    fn context() -> ReportContext {
        ReportContext {
            asset: None,
            assets: vec![map(json!({
                "id": "asset-1", "asset_code": "ASSET-1", "name": "Lamp",
                "feature_type": "street_light", "status": "active",
                "lifecycle": {
                    "lifecycle_status": "in_service",
                    "commissioned_date": "2016-01-01T00:00:00Z",
                    "designed_lifespan_years": 20
                }
            }))],
            incidents: vec![
                map(json!({
                    "id": "inc-1", "incident_number": "INC-1", "title": "Broken lamp",
                    "category": "malfunction", "severity": "high", "status": "open",
                    "asset_id": "asset-1", "reported_at": "2026-11-02T00:00:00Z"
                })),
                map(json!({
                    "id": "inc-2", "title": "Other", "severity": "low", "status": "resolved",
                    "asset_id": "asset-2", "reported_at": "2026-11-02T00:00:00Z"
                })),
            ],
            maintenance: vec![map(json!({
                "id": "wo-1", "asset_id": "asset-1", "title": "Inspect",
                "type": "preventive", "status": "scheduled", "priority": "high",
                "scheduled_date": "2026-11-03T00:00:00Z", "estimated_cost": 12.5
            }))],
        }
    }

    #[test]
    fn csv_cells_are_quoted_and_formulas_neutralized() {
        assert_eq!(csv_cell(Some(&json!("=SUM(A1)"))), "'=SUM(A1)");
        assert_eq!(csv_cell(Some(&json!("+1"))), "'+1");
        assert_eq!(csv_cell(Some(&json!("-1"))), "'-1");
        assert_eq!(csv_cell(Some(&json!("@cmd"))), "'@cmd");
        assert_eq!(csv_cell(Some(&json!("a,b"))), "\"a,b\"");
        assert_eq!(csv_cell(Some(&json!("a\"b"))), "\"a\"\"b\"");
        assert_eq!(csv_cell(Some(&json!("line\nbreak"))), "\"line\nbreak\"");
        assert_eq!(csv_cell(None), "");
        assert_eq!(csv_cell(Some(&json!(3))), "3");
    }

    #[test]
    fn serialize_csv_writes_header_and_rows() {
        let row_set = ReportRowSet {
            columns: vec!["a".to_string(), "b".to_string()],
            rows: vec![map(json!({ "a": 1, "b": "x,y" }))],
        };
        assert_eq!(serialize_csv(&row_set), "a,b\n1,\"x,y\"\n");
        let empty = ReportRowSet {
            columns: vec!["a".to_string()],
            rows: vec![],
        };
        assert_eq!(serialize_csv(&empty), "a\n");
    }

    #[test]
    fn incident_rows_honour_asset_scope_and_filters() {
        let context = context();
        let mut filters = JsonMap::new();
        filters.insert("asset_id".to_string(), Value::String("asset-1".to_string()));
        let rows = build_report_row_set(ReportType::IncidentSummary, &context, &filters);
        assert_eq!(rows.columns[0], "incident_id");
        assert_eq!(rows.rows.len(), 1);
        assert_eq!(rows.rows[0].get("incident_number").unwrap(), "INC-1");
        assert_eq!(rows.rows[0].get("asset_id").unwrap(), "asset-1");

        let mut severity = JsonMap::new();
        severity.insert("severity".to_string(), Value::String("low".to_string()));
        let low = build_report_row_set(ReportType::IncidentSummary, &context, &severity);
        assert_eq!(low.rows.len(), 1);
        assert_eq!(low.rows[0].get("incident_id").unwrap(), "inc-2");
    }

    #[test]
    fn maintenance_and_lifecycle_reports_use_the_documented_columns() {
        let context = context();
        let maintenance =
            build_report_row_set(ReportType::MaintenanceSummary, &context, &JsonMap::new());
        assert_eq!(maintenance.rows.len(), 1);
        assert_eq!(
            maintenance.rows[0].get("estimated_cost").unwrap(),
            &json!(12.5)
        );
        assert_eq!(maintenance.columns.len(), 12);

        let lifecycle =
            build_report_row_set(ReportType::LifecycleOverview, &context, &JsonMap::new());
        assert_eq!(lifecycle.rows[0].get("asset_code").unwrap(), "ASSET-1");
        assert_eq!(
            lifecycle.rows[0].get("lifecycle_status").unwrap(),
            "in_service"
        );
    }

    #[test]
    fn end_of_life_forecast_computes_age_and_replacement_year() {
        let context = context();
        let rows = super::end_of_life_rows(
            &context,
            parse_timestamp_millis("2026-01-01T00:00:00Z").unwrap(),
        );
        assert_eq!(rows.rows[0].get("age_years").unwrap(), &json!(10));
        assert_eq!(rows.rows[0].get("remaining_years").unwrap(), &json!(10));
        assert_eq!(
            rows.rows[0].get("projected_replacement_year").unwrap(),
            &json!(2036)
        );
    }

    #[test]
    fn generate_report_returns_real_bytes_and_sha256() {
        let context = context();
        let artifact = generate_report_at(
            ReportType::IncidentSummary,
            ReportFormat::Csv,
            &context,
            &JsonMap::new(),
            parse_timestamp_millis("2026-11-04T00:00:00Z").unwrap(),
        );
        assert!(artifact
            .content
            .starts_with("incident_id,incident_number,title"));
        assert_eq!(artifact.row_count, 2);
        assert_eq!(artifact.sha256.len(), 64);
        assert!(artifact
            .sha256
            .chars()
            .all(|character| character.is_ascii_hexdigit()));

        let json_artifact = generate_report_at(
            ReportType::MaintenanceSummary,
            ReportFormat::Json,
            &context,
            &JsonMap::new(),
            parse_timestamp_millis("2026-11-04T00:00:00Z").unwrap(),
        );
        let parsed: Value = serde_json::from_str(&json_artifact.content).unwrap();
        assert_eq!(parsed.get("report_type").unwrap(), "maintenance_summary");
        assert_eq!(parsed.get("row_count").unwrap(), 1);
        assert_eq!(
            json_artifact.content_type,
            "application/json; charset=utf-8"
        );
    }

    #[test]
    fn unsupported_formats_and_types_are_reported() {
        let format_error = normalize_report_format(Some(&json!("pdf"))).unwrap_err();
        assert_eq!(format_error.status(), 415);
        assert_eq!(format_error.message(), "unsupported_report_format:pdf");
        assert_eq!(normalize_report_format(None).unwrap(), ReportFormat::Csv);
        assert_eq!(
            normalize_report_format(Some(&json!(" JSON "))).unwrap(),
            ReportFormat::Json
        );

        let type_error = normalize_report_type(Some(&json!("unknown"))).unwrap_err();
        assert_eq!(type_error.status(), 400);
        assert_eq!(type_error.message(), "unsupported_report_type:unknown");
        assert_eq!(
            normalize_report_type(None).unwrap(),
            ReportType::MaintenanceSummary
        );
    }

    #[test]
    fn formula_text_in_a_row_is_neutralized() {
        let mut context = context();
        context.incidents[0].insert(
            "title".to_string(),
            Value::String("=HYPERLINK(\"x\")".to_string()),
        );
        let artifact = generate_report_at(
            ReportType::IncidentSummary,
            ReportFormat::Csv,
            &context,
            &JsonMap::new(),
            super::super::now_millis(),
        );
        assert!(artifact.content.contains("'=HYPERLINK"));
        assert!(!artifact.content.contains(",=HYPERLINK"));
    }

    #[test]
    fn number_formatting_for_csv_matches_javascript() {
        assert_eq!(super::super::js_number_string(12.0), "12");
        assert_eq!(super::super::js_number_string(12.5), "12.5");
    }
}
