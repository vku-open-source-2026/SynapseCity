// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Emergency SOS intake and operator status changes.

use crate::auth::AuthUser;
use crate::error::ApiError;
use crate::models::{SOSReportInput, SosQuery};
use crate::ratelimit::{enforce, ClientIp};
use crate::routes::ApiJson;
use crate::state::SharedState;
use crate::util::now_naive_iso;
use axum::extract::{Path, Query, State};
use axum::Json;
use serde_json::{json, Map, Value};

pub async fn create(
    State(state): State<SharedState>,
    ip: ClientIp,
    ApiJson(payload): ApiJson<SOSReportInput>,
) -> Result<Json<Value>, ApiError> {
    enforce(&state, "sos_create", &ip.0, 20)?;
    let report = payload.validate()?;
    let timestamp = now_naive_iso();
    let mut object = Map::new();
    object.insert(
        "contributor_name".to_string(),
        Value::String(report.contributor_name),
    );
    object.insert("msv".to_string(), Value::String(report.msv));
    object.insert("unit".to_string(), Value::String(report.unit));
    object.insert(
        "emergency_type".to_string(),
        Value::String(report.emergency_type),
    );
    object.insert("severity".to_string(), Value::String(report.severity));
    object.insert("message".to_string(), Value::String(report.message));
    if let Some(district) = report.district {
        object.insert("district".to_string(), Value::String(district));
    }
    if let Some(ward) = report.ward {
        object.insert("ward".to_string(), Value::String(ward));
    }
    if let Some(contact_phone) = report.contact_phone {
        object.insert("contact_phone".to_string(), Value::String(contact_phone));
    }
    if let Some(geometry) = report.geometry {
        object.insert("geometry".to_string(), geometry);
    }
    object.insert("status".to_string(), Value::String("pending".to_string()));
    object.insert("created_at".to_string(), Value::String(timestamp.clone()));
    object.insert("updated_at".to_string(), Value::String(timestamp));
    object.insert(
        "source".to_string(),
        Value::String("datacollector".to_string()),
    );

    state.storage.add_sos_report(Value::Object(object)).await?;
    Ok(Json(json!({
        "status": "success",
        "message": "SOS report submitted",
    })))
}

pub async fn list(
    State(state): State<SharedState>,
    _user: AuthUser,
    Query(query): Query<SosQuery>,
) -> Result<Json<Value>, ApiError> {
    let reports = state
        .storage
        .get_sos_reports(query.status.as_deref())
        .await?;
    Ok(Json(Value::Array(reports)))
}

pub async fn ack(
    State(state): State<SharedState>,
    _user: AuthUser,
    ip: ClientIp,
    Path(report_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    enforce(&state, "sos_ack", &ip.0, 30)?;
    if !state
        .storage
        .update_sos_status(&report_id, "acknowledged")
        .await?
    {
        return Err(ApiError::not_found("SOS report not found"));
    }
    Ok(Json(json!({ "status": "success" })))
}

pub async fn resolve(
    State(state): State<SharedState>,
    _user: AuthUser,
    ip: ClientIp,
    Path(report_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    enforce(&state, "sos_resolve", &ip.0, 30)?;
    if !state
        .storage
        .update_sos_status(&report_id, "resolved")
        .await?
    {
        return Err(ApiError::not_found("SOS report not found"));
    }
    Ok(Json(json!({ "status": "success" })))
}
