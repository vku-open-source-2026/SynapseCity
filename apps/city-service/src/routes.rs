// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP dispatcher for the City service.
//!
//! The route vocabulary and status codes mirror the former Express service.
//! Data lives in Tier-2; this process keeps only signed sessions, metrics and
//! small read caches.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};

use crate::ai;
use crate::auth::{self, SessionPrincipal, VerifiedIdentity};
use crate::config::Config;
use crate::domain;
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use crate::tier2::{
    self, AllRows, DatasetKey, DatasetSpec, ASSETS, INCIDENTS, INCIDENT_INTERNAL, MAINTENANCE,
    NOTIFICATIONS, REPORTS, USERS,
};
use crate::web;

const JSON_LIMIT: usize = 2 * 1024 * 1024;

struct Ctx<'a> {
    state: &'a AppState,
    headers: &'a HeaderMap,
    uri: &'a Uri,
    query: &'a HashMap<String, String>,
    body: &'a Map<String, Value>,
    session: Option<&'a SessionPrincipal>,
}

impl<'a> Ctx<'a> {
    fn config(&self) -> &Config {
        &self.state.config
    }

    fn opts(&self) -> synapsedx::RequestOptions {
        tier2::request_options(self.config(), self.headers, self.session)
    }

    fn client(&self) -> &synapsedx::Client {
        &self.state.tier2
    }

    fn principal(&self) -> Option<&SessionPrincipal> {
        self.session
    }
}

pub fn route_label(path: &str) -> String {
    let path = path.split('?').next().unwrap_or("/");
    let segments: Vec<&str> = path
        .split('/')
        .filter(|value| !value.is_empty())
        .take(3)
        .collect();
    format!("/{}", segments.join("/"))
}

fn method_name(method: &axum::http::Method) -> &'static str {
    match *method {
        axum::http::Method::GET => "GET",
        axum::http::Method::POST => "POST",
        axum::http::Method::PUT => "PUT",
        axum::http::Method::PATCH => "PATCH",
        axum::http::Method::DELETE => "DELETE",
        axum::http::Method::HEAD => "HEAD",
        _ => "OTHER",
    }
}

fn is_anonymous(path: &str) -> bool {
    path == "/health"
        || path == "/ready"
        || path == "/metrics"
        || path == "/v1/city"
        || path.starts_with("/v1/auth")
        || path.starts_with("/v1/public")
        || path.starts_with("/v1/map")
        || path == "/v1/ai/status"
        || path == "/v1/ai/chat"
}

fn operator_permission(method: &str, path: &str) -> &'static str {
    let read = method == "GET" || method == "HEAD";
    if path.starts_with("/v1/users") {
        if path.starts_with("/v1/users/me") {
            return "authenticated";
        }
        return if read { "users:read" } else { "users:admin" };
    }
    if path.starts_with("/v1/assets") {
        return if read { "assets:read" } else { "assets:write" };
    }
    if path.starts_with("/v1/incidents") {
        if path.ends_with("/verify") {
            return "incidents:verify";
        }
        return if read { "incidents:read" } else { "incidents:write" };
    }
    if path.starts_with("/v1/maintenance") || path.starts_with("/v1/preventive-maintenance") {
        return if read { "maintenance:read" } else { "maintenance:write" };
    }
    if path.starts_with("/v1/iot") {
        return if read { "iot:read" } else { "iot:write" };
    }
    if path.starts_with("/v1/alerts") {
        return if read { "alerts:read" } else { "alerts:write" };
    }
    if path.starts_with("/v1/budgets") {
        if path.ends_with("/approve") {
            return "budgets:approve";
        }
        return if read { "budgets:read" } else { "budgets:write" };
    }
    if path.starts_with("/v1/reports") {
        if path.ends_with("/generate") {
            return "reports:generate";
        }
        return if read { "reports:read" } else { "reports:write" };
    }
    if path.starts_with("/v1/notifications") {
        if path.starts_with("/v1/notifications/preferences") {
            return "notifications:read";
        }
        if read || path.ends_with("/read") || path.ends_with("/mark-all-read") {
            return "notifications:read";
        }
        return "notifications:write";
    }
    if path.starts_with("/v1/files") {
        return if read { "files:read" } else { "files:write" };
    }
    if path.starts_with("/v1/geofences") {
        return if read { "geofences:read" } else { "geofences:write" };
    }
    if path.starts_with("/v1/geo") {
        return "geo:read";
    }
    if path.starts_with("/v1/ingest") {
        return "ingest:write";
    }
    if path.starts_with("/v1/ai") {
        return "ai:use";
    }
    "authenticated"
}

fn rate_limit(
    state: &AppState,
    name: &str,
    headers: &HeaderMap,
    max: u32,
    window: Duration,
) -> Result<(), ApiError> {
    if let Some(retry) = state.limiter.check(name, headers, window, max) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limited",
            format!("{name}_limit_exceeded"),
        )
        .with_details(json!({ "retry_after_seconds": retry })));
    }
    Ok(())
}

pub async fn dispatch(State(state): State<AppState>, req: Request) -> ApiResult<Response> {
    let method = method_name(req.method());
    let headers = req.headers().clone();
    let uri = req.uri().clone();
    let path = uri.path().to_string();
    let lower_path = path.to_ascii_lowercase();
    for prefix in ["/v1/emergency", "/v1/hazards", "/v1/sos"] {
        if lower_path == prefix || lower_path.starts_with(&format!("{prefix}/")) {
            return Ok(not_found());
        }
    }
    let query = web::query_map(&uri);
    let raw_upload = method == "POST"
        && (path == "/v1/files/upload" || path == "/v1/public/files")
        || method == "PUT"
        && (path.starts_with("/v1/files/") && path.ends_with("/content"));

    if path.starts_with("/v1/auth") {
        rate_limit(&state, "auth", &headers, state.config.auth_rate_limit, Duration::from_secs(300))?;
    }
    if path.starts_with("/v1/public") {
        rate_limit(
            &state,
            "public-report",
            &headers,
            state.config.public_rate_limit,
            Duration::from_secs(600),
        )?;
    }
    if path.starts_with("/v1/ai") {
        rate_limit(
            &state,
            "public-ai",
            &headers,
            state.config.public_ai_rate_limit,
            Duration::from_secs(60),
        )?;
    }

    if raw_upload {
        let limit = state.config.files_max_bytes + 1024 * 1024;
        let (bytes, _, _) = web::raw_body(req, limit).await?;
        let session = auth::session_from_headers(&state.config, &headers);
        let ctx = Ctx {
            state: &state,
            headers: &headers,
            uri: &uri,
            query: &query,
            body: &Map::new(),
            session: session.as_ref(),
        };
        let segments: Vec<String> = path
            .trim_matches('/')
            .split('/')
            .filter(|value| !value.is_empty())
            .map(|value| percent_encoding::percent_decode_str(value).decode_utf8_lossy().to_string())
            .collect();
        return match (method, segments.iter().map(String::as_str).collect::<Vec<_>>().as_slice()) {
            ("POST", ["v1", "files", "upload"]) => files_upload_raw(ctx, bytes, false).await,
            ("POST", ["v1", "public", "files"]) => files_upload_raw(ctx, bytes, true).await,
            ("PUT", ["v1", "files", id, "content"]) => files_update_raw(ctx, id, bytes).await,
            _ => Ok(not_found()),
        };
    }

    let body = if matches!(method, "POST" | "PUT" | "PATCH") {
        let (body, _, _) = web::json_body(req, JSON_LIMIT).await?;
        body
    } else {
        Map::new()
    };
    let session = auth::session_from_headers(&state.config, &headers);
    if path.starts_with("/v1")
        && !is_anonymous(&path)
        && session.is_none()
    {
        return Err(ApiError::unauthorized("authentication_required"));
    }
    if path.starts_with("/v1") && !is_anonymous(&path) {
        if let Some(session) = session.as_ref() {
            let permission = operator_permission(&method, &path);
            if !auth::has_permission(session, permission) {
                return Err(ApiError::forbidden(
                    "forbidden",
                    format!("{permission}_required"),
                ));
            }
        }
    }
    let ctx = Ctx {
        state: &state,
        headers: &headers,
        uri: &uri,
        query: &query,
        body: &body,
        session: session.as_ref(),
    };
    let segments: Vec<String> = path
        .trim_matches('/')
        .split('/')
        .filter(|value| !value.is_empty())
        .map(|value| percent_encoding::percent_decode_str(value).decode_utf8_lossy().to_string())
        .collect();
    let keys: Vec<String> = segments.iter().map(|value| value.to_ascii_lowercase()).collect();
    let key_refs: Vec<&str> = keys.iter().map(String::as_str).collect();
    let raw = &segments;

    match (method, key_refs.as_slice()) {
        ("GET", ["health"]) => health(&ctx, false).await,
        ("GET", ["ready"]) => health(&ctx, true).await,
        ("GET", ["metrics"]) => metrics(&ctx),
        ("GET", ["v1", "city"]) => Ok(web::json_response(city_metadata(&ctx))),
        ("POST", ["v1", "auth", "login"]) | ("POST", ["v1", "auth", "register"]) => Ok(workspace_moved()),
        (_, ["v1", "auth", "refresh"]) => Ok(workspace_moved()),
        ("POST", ["v1", "auth", "logout"]) => auth_logout(&ctx).await,
        ("POST", ["v1", "auth", "change-password"]) => auth_change_password(&ctx).await,
        ("GET", ["v1", "auth", "me"]) => auth_me(&ctx),
        ("GET", ["v1", "auth", "verify"]) => auth_verify(&ctx),
        (_, ["v1", "auth", "login"]) | (_, ["v1", "auth", "register"]) => Ok(workspace_moved()),
        ("GET", ["v1", "files", "quota"]) => files_quota(&ctx).await,
        ("GET", ["v1", "files"]) => files_list(&ctx).await,
        ("POST", ["v1", "files"]) => files_create(&ctx).await,
        ("GET", ["v1", "files", id]) => files_get(&ctx, id).await,
        ("GET", ["v1", "files", id, "content"]) => files_content(&ctx, id, false).await,
        ("POST", ["v1", "files", id, "presign"]) => files_presign(&ctx, id).await,
        ("POST", ["v1", "files", id, "complete"]) => files_complete(&ctx, id).await,
        ("DELETE", ["v1", "files", id]) => files_delete(&ctx, id).await,
        ("GET", ["v1", "assets"]) => assets_list(&ctx).await,
        ("POST", ["v1", "assets"]) => assets_create(&ctx).await,
        ("GET", ["v1", "assets", id]) => assets_get(&ctx, id).await,
        ("PATCH", ["v1", "assets", id]) | ("PUT", ["v1", "assets", id]) => assets_patch(&ctx, id).await,
        ("DELETE", ["v1", "assets", id]) => assets_delete(&ctx, id).await,
        ("POST", ["v1", "assets", id, "photos"]) => assets_photos(&ctx, id).await,
        ("POST", ["v1", "assets", id, "attachments"]) => assets_attachments(&ctx, id).await,
        ("DELETE", ["v1", "assets", id, "attachments", url]) => assets_attachment_delete(&ctx, id, url).await,
        ("GET", ["v1", "assets", id, "documents"]) => assets_documents(&ctx, id).await,
        ("POST", ["v1", "assets", id, "documents"]) => assets_document_add(&ctx, id).await,
        ("PUT", ["v1", "assets", id, "lifecycle-status"]) => assets_lifecycle(&ctx, id).await,
        ("PUT", ["v1", "assets", id, "criticality"]) => assets_criticality(&ctx, id).await,
        ("GET", ["v1", "assets", id, "risk"]) => assets_risk(&ctx, id).await,
        ("GET", ["v1", "risk", "top"]) => risk_top(&ctx).await,
        ("POST", ["v1", "assets", id, "risk", "work-order"]) => assets_risk_work_order(&ctx, id).await,
        ("GET", ["v1", "assets", id, "health-score"]) => assets_health(&ctx, id).await,
        ("POST", ["v1", "assets", id, "reports"]) => assets_report(&ctx, id).await,
        ("GET", ["v1", "assets", id, "preventive-maintenance"]) => assets_preventive(&ctx, id, None).await,
        ("GET", ["v1", "assets", id, "preventive-maintenance", view]) => assets_preventive(&ctx, id, Some(view)).await,
        ("POST", ["v1", "preventive-maintenance"]) => preventive_create(&ctx).await,
        ("PUT", ["v1", "preventive-maintenance", plan_id]) => preventive_update(&ctx, plan_id).await,
        ("GET", ["v1", "incidents"]) => incidents_list(&ctx).await,
        ("POST", ["v1", "incidents"]) => incidents_create(&ctx).await,
        ("GET", ["v1", "incidents", id]) => incidents_get(&ctx, id).await,
        ("PATCH", ["v1", "incidents", id]) | ("PUT", ["v1", "incidents", id]) => incidents_patch(&ctx, id).await,
        ("POST", ["v1", "incidents", id, "acknowledge"]) => incidents_action(&ctx, id, "acknowledge").await,
        ("POST", ["v1", "incidents", id, "assign"]) => incidents_action(&ctx, id, "assign").await,
        ("POST", ["v1", "incidents", id, "resolve"]) => incidents_action(&ctx, id, "resolve").await,
        ("POST", ["v1", "incidents", id, "comments"]) => incidents_action(&ctx, id, "comments").await,
        ("POST", ["v1", "incidents", id, "upvote"]) => incidents_action(&ctx, id, "upvote").await,
        ("POST", ["v1", "incidents", id, "create-maintenance"]) => incidents_action(&ctx, id, "create-maintenance").await,
        ("POST", ["v1", "incidents", id, "close"]) => incidents_action(&ctx, id, "close").await,
        ("POST", ["v1", "incidents", id, "reject"]) => incidents_action(&ctx, id, "reject").await,
        ("POST", ["v1", "incidents", id, "cost-approval"]) => incidents_action(&ctx, id, "cost-approval").await,
        ("POST", ["v1", "incidents", id, "approve-cost"]) => incidents_action(&ctx, id, "approve-cost").await,
        ("POST", ["v1", "incidents", id, "verify"]) => incidents_action(&ctx, id, "verify").await,
        ("POST", ["v1", "incidents", id, "check-duplicates"]) => incidents_action(&ctx, id, "check-duplicates").await,
        ("GET", ["v1", "incidents", id, "merge-suggestions"]) => incidents_action(&ctx, id, "merge-suggestions").await,
        ("POST", ["v1", "incidents", id, "merge"]) => incidents_action(&ctx, id, "merge").await,
        ("GET", ["v1", "incidents", id, "related"]) => incidents_action(&ctx, id, "related").await,
        ("POST", ["v1", "incidents", "merge-suggestions", _, _]) => Ok(web::status_json(
            StatusCode::NOT_FOUND,
            json!({ "error": "merge_suggestion_not_found" }),
        )),
        ("GET", ["v1", "hitl", "approvals"]) => hitl_list(&ctx).await,
        ("POST", ["v1", "hitl", "approvals", id, "decide"]) => hitl_decide(&ctx, id).await,
        ("GET", ["v1", "maintenance", "upcoming"]) => maintenance_upcoming(&ctx).await,
        ("GET", ["v1", "maintenance", "asset", asset_id]) => maintenance_asset(&ctx, asset_id).await,
        ("POST", ["v1", "maintenance", id, "approval"]) => maintenance_approval(&ctx, id).await,
        ("POST", ["v1", "maintenance", id, "photos"]) => maintenance_photos(&ctx, id).await,
        ("POST", ["v1", "maintenance", id, action]) => maintenance_action(&ctx, id, action).await,
        ("GET", ["v1", "maintenance"]) => generic_list(&ctx, DatasetKey::Maintenance).await,
        ("POST", ["v1", "maintenance"]) => generic_create(&ctx, DatasetKey::Maintenance).await,
        ("GET", ["v1", "maintenance", id]) => generic_get(&ctx, DatasetKey::Maintenance, id).await,
        ("PUT", ["v1", "maintenance", id]) => generic_update(&ctx, DatasetKey::Maintenance, id).await,
        ("GET", ["v1", "iot", "sensors"]) => generic_list(&ctx, DatasetKey::Sensors).await,
        ("POST", ["v1", "iot", "sensors"]) => generic_create(&ctx, DatasetKey::Sensors).await,
        ("GET", ["v1", "iot", "sensors", id]) => generic_get(&ctx, DatasetKey::Sensors, id).await,
        ("PUT", ["v1", "iot", "sensors", id]) => generic_update(&ctx, DatasetKey::Sensors, id).await,
        ("DELETE", ["v1", "iot", "sensors", id]) => iot_sensor_delete(&ctx, id).await,
        ("GET", ["v1", "iot", "sensors", id, "data"]) => iot_readings(&ctx, id, false).await,
        ("GET", ["v1", "iot", "sensors", id, "readings"]) => iot_readings(&ctx, id, true).await,
        ("POST", ["v1", "iot", "sensors", id, "data"]) => iot_write(&ctx, id).await,
        ("POST", ["v1", "iot", "sensors", "batch-ingest"]) => iot_batch(&ctx).await,
        ("GET", ["v1", "iot", "sensors", id, "status"]) => iot_status(&ctx, id).await,
        ("GET", ["v1", "iot", "sensors", id, "statistics"]) => iot_statistics(&ctx, id).await,
        ("GET", ["v1", "iot", "assets", asset_id, "iot-data"]) => iot_asset(&ctx, asset_id).await,
        ("GET", ["v1", "alerts"]) => generic_list(&ctx, DatasetKey::Alerts).await,
        ("POST", ["v1", "alerts"]) => alerts_create(&ctx).await,
        ("GET", ["v1", "alerts", id]) => generic_get(&ctx, DatasetKey::Alerts, id).await,
        ("PUT", ["v1", "alerts", id]) => generic_update(&ctx, DatasetKey::Alerts, id).await,
        ("POST", ["v1", "alerts", id, "acknowledge"]) => alerts_ack(&ctx, id).await,
        ("POST", ["v1", "alerts", id, action]) => alerts_action(&ctx, id, action).await,
        ("GET", ["v1", "budgets"]) => generic_list(&ctx, DatasetKey::Budgets).await,
        ("POST", ["v1", "budgets"]) => generic_create(&ctx, DatasetKey::Budgets).await,
        ("GET", ["v1", "budgets", id]) => generic_get(&ctx, DatasetKey::Budgets, id).await,
        ("PUT", ["v1", "budgets", id]) => generic_update(&ctx, DatasetKey::Budgets, id).await,
        ("GET", ["v1", "budgets", id, "transactions"]) => budget_transactions(&ctx, id).await,
        ("POST", ["v1", "budgets", id, "transactions"]) => budget_transaction_create(&ctx, id).await,
        ("POST", ["v1", "budgets", "transactions", id, "approval"]) => budget_transaction_approval(&ctx, id).await,
        ("POST", ["v1", "budgets", "transactions", id, "approve"]) => budget_transaction_approve(&ctx, id).await,
        ("POST", ["v1", "budgets", id, action]) => budget_action(&ctx, id, action).await,
        ("GET", ["v1", "reports"]) => reports_list(&ctx).await,
        ("POST", ["v1", "reports"]) => reports_create(&ctx, None).await,
        ("GET", ["v1", "reports", id]) => reports_get(&ctx, id).await,
        ("PUT", ["v1", "reports", id]) => generic_update(&ctx, DatasetKey::Reports, id).await,
        ("POST", ["v1", "reports", id, "generate"]) => reports_generate(&ctx, id).await,
        ("GET", ["v1", "reports", id, "download"]) => reports_download(&ctx, id).await,
        ("GET", ["v1", "notifications"]) => notifications_list(&ctx).await,
        ("POST", ["v1", "notifications"]) => notifications_create(&ctx).await,
        ("GET", ["v1", "notifications", "unread-count"]) => notifications_unread(&ctx).await,
        ("GET", ["v1", "notifications", "capabilities"]) => Ok(web::json_response(json!(
            domain::notifications::notification_capability_status(ctx.config().notification_external)
        ))),
        ("GET", ["v1", "notifications", "preferences"]) => notifications_preferences_get(&ctx).await,
        ("PUT", ["v1", "notifications", "preferences"]) => notifications_preferences_put(&ctx).await,
        ("POST", ["v1", "notifications", "mark-all-read"]) => notifications_mark_all(&ctx).await,
        ("GET", ["v1", "notifications", id, "delivery"]) => notifications_delivery(&ctx, id).await,
        ("POST", ["v1", "notifications", id, "read"]) => notifications_read(&ctx, id).await,
        ("GET", ["v1", "users", "me"]) => users_me(&ctx).await,
        ("PUT", ["v1", "users", "me"]) => users_me_update(&ctx).await,
        ("GET", ["v1", "users", "technicians"]) => users_by_role(&ctx, "technician").await,
        ("GET", ["v1", "users", "volunteers"]) => users_by_role(&ctx, "volunteer").await,
        ("GET", ["v1", "users"]) => generic_list(&ctx, DatasetKey::Users).await,
        ("POST", ["v1", "users"]) => users_create(&ctx).await,
        ("GET", ["v1", "users", id]) => users_get(&ctx, id).await,
        ("PUT", ["v1", "users", id]) => users_update(&ctx, id).await,
        ("DELETE", ["v1", "users", id]) => users_delete(&ctx, id).await,
        ("GET", ["v1", "geofences"]) => generic_list(&ctx, DatasetKey::Geofences).await,
        ("POST", ["v1", "geofences"]) => generic_create(&ctx, DatasetKey::Geofences).await,
        ("GET", ["v1", "geofences", id]) => generic_get(&ctx, DatasetKey::Geofences, id).await,
        ("PUT", ["v1", "geofences", id]) => generic_update(&ctx, DatasetKey::Geofences, id).await,
        ("POST", ["v1", "geofences", id, "test"]) => geofence_test(&ctx, id).await,
        ("GET", ["v1", "geo", "assets", "nearby"]) => geo_nearby(&ctx).await,
        ("GET", ["v1", "geo", "assets", "within-bounds"]) => geo_bounds(&ctx).await,
        ("POST", ["v1", "geo", "assets", "within-polygon"]) => geo_polygon(&ctx).await,
        ("GET", ["v1", "geo", "search-address"]) => geo_search(&ctx).await,
        ("POST", ["v1", "geo", "geocode"]) => geo_geocode(&ctx).await,
        ("POST", ["v1", "geo", "reverse-geocode"]) => geo_reverse(&ctx).await,
        ("GET", ["v1", "geo", "assets", id, "distance-to"]) => geo_distance(&ctx, id).await,
        ("POST", ["v1", "geo", "coverage"]) => geo_coverage(&ctx).await,
        ("POST", ["v1", "ingest", "csv"]) => ingest_csv(&ctx).await,
        ("GET", ["v1", "public", "files", id, "content"]) => files_content(&ctx, id, true).await,
        ("GET", ["v1", "public", "assets"]) => public_assets(&ctx).await,
        ("GET", ["v1", "public", "assets", code, "qr-code"]) => public_asset_aux(&ctx, code, "qr").await,
        ("GET", ["v1", "public", "assets", code, "maintenance-summary"]) => public_asset_aux(&ctx, code, "maintenance").await,
        ("GET", ["v1", "public", "assets", code]) => public_asset(&ctx, code).await,
        ("GET", ["v1", "public", "incidents"]) => public_incidents(&ctx).await,
        ("POST", ["v1", "public", "incidents"]) => public_incident_create(&ctx).await,
        ("POST", ["v1", "public", "incidents", id, "photos"]) => public_incident_photos(&ctx, id).await,
        ("GET", ["v1", "public", "incidents", id]) => public_incident(&ctx, id).await,
        ("GET", ["v1", "map", "config"]) => Ok(web::json_response(json!({
            "provider": "synapsedx", "tileUrl": "/v1/map/tiles/{z}/{x}/{y}.png",
            "attribution": "&copy; VIETMAP", "maxZoom": 20, "maxNativeZoom": 20, "style": "tm"
        }))),
        ("GET", ["v1", "map", "status"]) => Ok(web::json_response(json!({
            "provider": "synapsedx",
            "configured": ctx.config().tier2_api_key.is_some() || ctx.config().tier2_token.is_some(),
            "service": "synapsecity"
        }))),
        ("GET", ["v1", "map", "tiles", z, x, y]) => map_tile(&ctx, z, x, y).await,
        ("GET", ["v1", "ai", "status"]) => ai_status(&ctx).await,
        ("POST", ["v1", "ai", "chat"]) => ai_chat(&ctx).await,
        _ => {
            let _ = raw;
            Ok(not_found())
        }
    }
}

fn workspace_moved() -> Response {
    web::status_json(
        StatusCode::GONE,
        json!({
            "error": "workspace_moved",
            "workspace_url": "https://synapsedx.sbs/workspace",
            "detail": "Tier-3 work interfaces moved to the SynapseDX workspace.",
        }),
    )
}

fn not_found() -> Response {
    web::status_json(
        StatusCode::NOT_FOUND,
        json!({ "error": "not_found", "product": "synapsecity" }),
    )
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

fn to_map(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn values_from_rows(rows: Vec<Map<String, Value>>) -> Vec<Value> {
    rows.into_iter().map(Value::Object).collect()
}

fn query_filters(query: &HashMap<String, String>) -> HashMap<String, String> {
    query.clone()
}

const FILTER_IGNORED: &[&str] = &[
    "limit", "offset", "skip", "page", "with_total", "sort", "order", "days", "hours", "all",
    "view", "radius_meters", "lng", "lat", "lon", "longitude", "latitude", "min_lng", "min_lat",
    "max_lng", "max_lat", "metric", "unread_only",
];

fn matches_filters(row: &Map<String, Value>, filters: &HashMap<String, String>) -> bool {
    for (key, raw) in filters {
        if FILTER_IGNORED.contains(&key.as_str()) || raw.is_empty() {
            continue;
        }
        let value = row.get(key);
        if raw.contains(',') {
            let allowed: Vec<String> = raw
                .split(',')
                .map(|entry| entry.trim().to_ascii_lowercase())
                .filter(|entry| !entry.is_empty())
                .collect();
            let candidate = value
                .map(|value| value.as_str().unwrap_or("").to_ascii_lowercase())
                .unwrap_or_default();
            if !allowed.contains(&candidate) {
                return false;
            }
            continue;
        }
        if key.ends_with("_from") || key.ends_with("_after") {
            let field = key.trim_end_matches("_from").trim_end_matches("_after");
            let candidate = value.and_then(Value::as_str).and_then(compare_timestamp);
            let threshold = compare_timestamp(raw);
            if let (Some(candidate), Some(threshold)) = (candidate, threshold) {
                if candidate < threshold {
                    return false;
                }
            }
            continue;
        }
        if key.ends_with("_to") || key.ends_with("_before") {
            let field = key.trim_end_matches("_to").trim_end_matches("_before");
            let candidate = value.and_then(Value::as_str).and_then(compare_timestamp);
            let threshold = compare_timestamp(raw);
            if let (Some(candidate), Some(threshold)) = (candidate, threshold) {
                if candidate > threshold {
                    return false;
                }
            }
            continue;
        }
        if key == "q" || key == "search" {
            let needle = raw.to_ascii_lowercase();
            let haystack = [
                "name", "title", "description", "asset_code", "feature_code", "incident_number",
                "sensor_code", "report_code",
            ]
            .iter()
            .filter_map(|field| row.get(*field).and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
            if !haystack.contains(&needle) {
                return false;
            }
            continue;
        }
        if let Some(array) = value.and_then(Value::as_array) {
            if !array
                .iter()
                .filter_map(Value::as_str)
                .any(|entry| entry.eq_ignore_ascii_case(raw))
            {
                return false;
            }
            continue;
        }
        match value {
            None | Some(Value::Null) => return false,
            Some(Value::Bool(flag)) => {
                if flag.to_string() != raw.to_ascii_lowercase() {
                    return false;
                }
            }
            Some(value) => {
                let candidate = value
                    .as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| value.to_string());
                if candidate.to_ascii_lowercase() != raw.to_ascii_lowercase() {
                    return false;
                }
            }
        }
    }
    true
}

fn compare_timestamp(value: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|date| date.timestamp_millis())
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|date| date.and_hms_opt(0, 0, 0))
                .map(|date| date.and_utc().timestamp_millis())
        })
}

fn has_filters(query: &HashMap<String, String>) -> bool {
    query
        .keys()
        .any(|key| !FILTER_IGNORED.contains(&key.as_str()))
}

async fn list_rows(ctx: &Ctx<'_>, spec: DatasetSpec) -> ApiResult<Vec<Map<String, Value>>> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, spec, 5000).await?;
    Ok(rows.items)
}

async fn generic_list(ctx: &Ctx<'_>, key: DatasetKey) -> ApiResult<Response> {
    let spec = tier2::spec_for(key);
    let rows = list_rows(ctx, spec).await?;
    let filters = query_filters(ctx.query);
    let filtered: Vec<Value> = rows
        .into_iter()
        .filter(|row| matches_filters(row, &filters))
        .map(Value::Object)
        .collect();
    Ok(web::send_page(filtered, ctx.query, 100))
}

async fn generic_get(ctx: &Ctx<'_>, key: DatasetKey, id: &str) -> ApiResult<Response> {
    let spec = tier2::spec_for(key);
    let opts = ctx.opts();
    let row = tier2::get(ctx.client(), &opts, spec, id).await?;
    Ok(web::send_record(row))
}

async fn generic_create(ctx: &Ctx<'_>, key: DatasetKey) -> ApiResult<Response> {
    let spec = tier2::spec_for(key);
    let opts = ctx.opts();
    let input = web::private_input(ctx.body);
    let row = tier2::create(ctx.client(), &opts, spec, input, None).await?;
    Ok(web::created(Value::Object(row)))
}

async fn generic_update(ctx: &Ctx<'_>, key: DatasetKey, id: &str) -> ApiResult<Response> {
    let spec = tier2::spec_for(key);
    let opts = ctx.opts();
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let input = web::private_input(ctx.body);
    let row = tier2::update(ctx.client(), &opts, spec, id, input, version).await?;
    Ok(web::send_record(row))
}

async fn find_record(
    ctx: &Ctx<'_>,
    spec: DatasetSpec,
    reference: &str,
    match_keys: &[&str],
) -> ApiResult<Option<Map<String, Value>>> {
    let opts = ctx.opts();
    if let Ok(row) = tier2::get(ctx.client(), &opts, spec, reference).await {
        return Ok(Some(row));
    }
    let rows = tier2::list_all(ctx.client(), &opts, spec, 5000).await?;
    let needle = reference.to_ascii_lowercase();
    Ok(rows.items.into_iter().find(|row| {
        match_keys.iter().any(|key| {
            row.get(*key)
                .and_then(Value::as_str)
                .map(|value| value.eq_ignore_ascii_case(&needle))
                .unwrap_or(false)
        })
    }))
}

fn asset_code(row: &Map<String, Value>) -> String {
    row.get("asset_code")
        .or_else(|| row.get("assetCode"))
        .or_else(|| row.get("assetId"))
        .or_else(|| row.get("feature_code"))
        .or_else(|| row.get("id"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn asset_view(row: &Map<String, Value>) -> Map<String, Value> {
    let mut data = row.clone();
    let code = asset_code(&data);
    data.entry("id".to_string()).or_insert_with(|| json!(code));
    data.entry("asset_code".to_string()).or_insert_with(|| json!(code));
    data.entry("name".to_string()).or_insert_with(|| json!(code));
    let feature_type = data.get("assetType").cloned().unwrap_or_else(|| json!("infrastructure"));
    data.entry("feature_type".to_string()).or_insert(feature_type);
    data.entry("feature_code".to_string()).or_insert_with(|| json!(code));
    data.entry("status".to_string()).or_insert_with(|| json!("active"));
    let location = data
        .get("location")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let geometry = data
        .get("geometry")
        .cloned()
        .or_else(|| location.get("geometry").cloned())
        .unwrap_or_else(|| json!({"type":"Point","coordinates":[0,0]}));
    data.insert("geometry".into(), geometry.clone());
    let mut location = location;
    location.insert("geometry".into(), geometry);
    data.insert("location".into(), Value::Object(location));
    data
}

fn coordinates_of(row: &Map<String, Value>) -> Option<(f64, f64)> {
    if let Some(geometry) = row.get("geometry").and_then(Value::as_object) {
        if geometry.get("type").and_then(Value::as_str) == Some("Point") {
            if let Some(coordinates) = geometry.get("coordinates").and_then(Value::as_array) {
                if coordinates.len() >= 2 {
                    if let (Some(lng), Some(lat)) = (coordinates[0].as_f64(), coordinates[1].as_f64()) {
                        if lat.abs() <= 90.0 && lng.abs() <= 180.0 && (lat != 0.0 || lng != 0.0) {
                            return Some((lng, lat));
                        }
                    }
                }
            }
        }
    }
    let location = row.get("location").and_then(Value::as_object)?;
    if let Some(coordinates) = location.get("coordinates").and_then(Value::as_object) {
        let lng = coordinates.get("longitude").and_then(Value::as_f64)?;
        let lat = coordinates.get("latitude").and_then(Value::as_f64)?;
        if lat.abs() <= 90.0 && lng.abs() <= 180.0 && (lat != 0.0 || lng != 0.0) {
            return Some((lng, lat));
        }
    }
    None
}

fn point_of(row: &Map<String, Value>) -> Option<domain::geo::Point> {
    coordinates_of(row).map(|(longitude, latitude)| domain::geo::Point {
        longitude,
        latitude,
    })
}

fn incident_number() -> String {
    format!(
        "INC-{}-{}",
        Utc::now().format("%Y"),
        &uuid::Uuid::new_v4().simple().to_string()[..6].to_ascii_uppercase()
    )
}

fn incident_view(row: &Map<String, Value>) -> Map<String, Value> {
    let mut data = row.clone();
    let id = data
        .get("id")
        .or_else(|| data.get("incidentId"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    data.entry("id".to_string()).or_insert_with(|| json!(id));
    let incident_code = data.get("incident_number").cloned().unwrap_or_else(|| json!(id));
    data.entry("incident_code".to_string()).or_insert(incident_code);
    let incident_number = data.get("incident_code").cloned().unwrap_or_else(|| json!(id));
    data.entry("incident_number".to_string()).or_insert(incident_number);
    data.entry("reporter_type".to_string()).or_insert_with(|| json!("admin"));
    data.entry("upvotes".to_string()).or_insert_with(|| json!(0));
    data.entry("comments".to_string()).or_insert_with(|| json!([]));
    data.entry("photos".to_string()).or_insert_with(|| json!([]));
    let reported_at = data.get("occurredAt").cloned().or_else(|| data.get("created_at").cloned()).unwrap_or(Value::Null);
    data.entry("reported_at".to_string()).or_insert(reported_at);
    data.entry("created_at".to_string()).or_insert(Value::Null);
    let updated_at = data.get("created_at").cloned().unwrap_or(Value::Null);
    data.entry("updated_at".to_string()).or_insert(updated_at);
    data
}

fn file_url(config: &Config, id: &str, public: bool) -> String {
    domain::files::city_file_url(id, public, Some(&config.public_url))
}

fn file_view(config: &Config, record: &Map<String, Value>) -> Value {
    let id = record.get("id").and_then(Value::as_str).unwrap_or("");
    let public = record.get("public").and_then(Value::as_bool).unwrap_or(false);
    let mut view = record.clone();
    view.insert("file_id".into(), json!(id));
    view.entry("filename".to_string())
        .or_insert_with(|| record.get("file_name").cloned().unwrap_or(Value::Null));
    view.entry("content_type".to_string())
        .or_insert_with(|| record.get("contentType").cloned().unwrap_or(Value::Null));
    view.entry("checksum_sha256".to_string())
        .or_insert_with(|| record.get("checksumSha256").cloned().unwrap_or(Value::Null));
    let url = file_url(config, id, public);
    view.insert("download_url".into(), json!(url));
    view.insert("file_url".into(), json!(url));
    Value::Object(view)
}

fn file_error(error: domain::files::FileError) -> ApiError {
    let mut api = ApiError::new(
        StatusCode::from_u16(error.status()).unwrap_or(StatusCode::BAD_REQUEST),
        error.code(),
        error.code(),
    );
    if let Some(dependency) = error.dependency() {
        api = api.with_dependency(dependency);
    }
    api
}

// ---------------------------------------------------------------------------
// Metadata, health, metrics
// ---------------------------------------------------------------------------

fn city_metadata(ctx: &Ctx<'_>) -> Value {
    json!({
        "service": "synapsecity",
        "product": "synapsecity",
        "tier": 3,
        "version": "0.1.0",
        "domain": "infrastructure",
        "publicUrl": "https://synapsecity.sbs",
        "features": [
            "assets", "asset-lifecycle", "incidents", "maintenance", "preventive-maintenance",
            "technician-portal", "iot", "alerts", "notifications", "budgets", "reports",
            "users", "geofences", "ingest", "map", "geocoding", "ai", "public-asset-map",
            "public-incident-reporting", "public-incident-lookup"
        ],
        "notOwned": [
            "hazards", "emergency-events", "eop", "dispatch", "resources", "sitrep", "aar",
            "emergency-command-centre"
        ],
        "datasets": tier2::DATASETS.iter().map(|spec| spec.id).collect::<Vec<_>>(),
        "dependency": ctx.config().tier2_url,
        "capabilities": {
            "datasets": { "status": "available", "transport": "synapsedx" },
            "records": { "status": "available", "transport": "synapsedx" },
            "files": domain::files::files_capability_status(),
            "identity": { "status": if ctx.config().demo_auth_allowed() { "demo" } else { "available" }, "mode": ctx.config().auth_mode },
            "geo": { "status": "shared", "provider": "tier2" },
        },
    })
}

async fn health(ctx: &Ctx<'_>, ready: bool) -> ApiResult<Response> {
    let opts = ctx.opts();
    match ctx.client().health(&opts).await {
        Ok(tier2) => Ok(web::status_json(
            StatusCode::OK,
            json!({
                "status": if ready { "ready" } else { "ok" },
                "service": "synapsecity",
                "tier": 3,
                "tier2": tier2,
                "tier2Url": ctx.config().tier2_url,
            }),
        )),
        Err(error) => Ok(web::status_json(
            StatusCode::SERVICE_UNAVAILABLE,
            json!({
                "status": if ready { "not_ready" } else { "degraded" },
                "service": "synapsecity",
                "tier": 3,
                "tier2Url": ctx.config().tier2_url,
                "dependency": { "name": "synapsedx", "status": "unavailable", "error": error.to_string() },
            }),
        )),
    }
}

fn metrics(ctx: &Ctx<'_>) -> ApiResult<Response> {
    if let Some(token) = &ctx.config().metrics_token {
        let provided = ctx
            .headers
            .get("x-metrics-token")
            .and_then(|value| value.to_str().ok())
            .or_else(|| {
                ctx.headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.strip_prefix("Bearer "))
            });
        if provided != Some(token.as_str()) {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "metrics_token_required",
                "metrics_token_required",
            ));
        }
    }
    Ok(web::text_response(
        "text/plain; version=0.0.4; charset=utf-8",
        ctx.state.metrics.render(),
    ))
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

fn user_from_identity(identity: &VerifiedIdentity, role: &str, profile: Option<&Map<String, Value>>) -> SessionPrincipal {
    let username = profile
        .and_then(|profile| profile.get("username"))
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if identity.email.is_empty() {
                identity.user_id.clone()
            } else {
                identity.email.clone()
            }
        });
    let now = Utc::now().timestamp();
    SessionPrincipal {
        sub: identity.user_id.clone(),
        username: username.clone(),
        email: if identity.email.is_empty() {
            format!("{username}@synapsecity.local")
        } else {
            identity.email.clone()
        },
        full_name: profile
            .and_then(|profile| profile.get("full_name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                (!identity.display_name.is_empty()).then(|| identity.display_name.clone())
            })
            .unwrap_or_else(|| username.clone()),
        phone: profile
            .and_then(|profile| profile.get("phone"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| identity.scopes.first().cloned().filter(|_| false)),
        role: role.to_string(),
        permissions: auth::permissions_for_role(role),
        typ: "access".into(),
        iat: now,
        exp: now + 3600,
        jti: Some(uuid::Uuid::new_v4().to_string()),
        demo: None,
        auth_source: Some("tier2".into()),
        tier2_token: identity.access_token.clone(),
        tier2_refresh_token: identity.refresh_token.clone(),
    }
}

async fn find_city_profile(ctx: &Ctx<'_>, identity: &VerifiedIdentity) -> Option<Map<String, Value>> {
    let opts = ctx.opts();
    if let Ok(profile) = tier2::get(ctx.client(), &opts, USERS, &identity.user_id).await {
        return Some(profile);
    }
    let rows = tier2::list_all(ctx.client(), &opts, USERS, 500).await.ok()?;
    let email = identity.email.to_ascii_lowercase();
    rows.items.into_iter().find(|row| {
        row.get("email")
            .and_then(Value::as_str)
            .map(|value| value.eq_ignore_ascii_case(&email))
            .unwrap_or(false)
    })
}

fn session_for_identity(
    ctx: &Ctx<'_>,
    identity: &VerifiedIdentity,
    role: &str,
    session: &auth::Tier2Session,
    profile: Option<&Map<String, Value>>,
) -> ApiResult<Value> {
    let mut base = user_from_identity(identity, role, profile);
    base.tier2_token = session.token.clone();
    base.tier2_refresh_token = session.refresh_token.clone();
    base.auth_source = Some("tier2".into());
    Ok(auth::issue_session(ctx.config(), base, false).json())
}

async fn auth_login(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let identifier = web::string_field(ctx.body, "email")
        .or_else(|| web::string_field(ctx.body, "username"))
        .unwrap_or_default();
    let password = web::string_field(ctx.body, "password").unwrap_or_default();
    if identifier.is_empty() {
        return Err(ApiError::bad_request("email_required", "email_required"));
    }
    if password.trim().is_empty() {
        return Err(ApiError::bad_request("password_required", "password_required"));
    }
    if ctx.config().demo_auth_allowed() {
        let role = auth::normalize_role(
            &std::env::var("AUTH_DEMO_ROLE").unwrap_or_else(|_| "admin".into()),
            auth::ROLE_CITIZEN,
        );
        let base = auth::principal_from_input(
            ctx.config(),
            &identifier,
            web::string_field(ctx.body, "email").as_deref(),
            web::string_field(ctx.body, "full_name").as_deref(),
            web::string_field(ctx.body, "phone").as_deref(),
            &role,
        );
        return Ok(web::json_response(auth::issue_session(ctx.config(), base, true).json()));
    }
    if !identifier.contains('@') {
        return Err(ApiError::bad_request(
            "email_required",
            "Tier-2 identity requires an email address.",
        ));
    }
    let opts = ctx.opts();
    let session = ctx
        .client()
        .auth()
        .login(&identifier, Some(&password), web::string_field(ctx.body, "org_slug").as_deref(), &opts)
        .await
        .map_err(auth::identity_error)?;
    let value = serde_json::to_value(&session).unwrap_or(Value::Null);
    let identity = auth::identity_from_session(&value)?;
    let profile = find_city_profile(ctx, &identity).await;
    let role = auth::role_for_identity(ctx.config(), &identity, profile.as_ref());
    let response = session_for_identity(ctx, &identity, &role, &auth::Tier2Session {
        identity: identity.clone(),
        token: Some(session.access_token.clone()),
        refresh_token: Some(session.refresh_token.clone()),
        exchanged: false,
    }, profile.as_ref())?;
    Ok(web::json_response(response))
}

async fn auth_register(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let email = web::string_field(ctx.body, "email").unwrap_or_default().to_ascii_lowercase();
    let password = web::string_field(ctx.body, "password").unwrap_or_default();
    let full_name = web::string_field(ctx.body, "full_name")
        .or_else(|| web::string_field(ctx.body, "display_name"))
        .unwrap_or_default();
    if email.is_empty() {
        return Err(ApiError::bad_request("email_required", "email_required"));
    }
    if !email.contains('@') {
        return Err(ApiError::bad_request("email_invalid", "email_invalid"));
    }
    if password.len() < 6 {
        return Err(ApiError::bad_request("password_too_short", "password_too_short"));
    }
    if ctx.config().demo_auth_allowed() {
        let base = auth::principal_from_input(
            ctx.config(),
            &web::string_field(ctx.body, "username").unwrap_or_else(|| email.clone()),
            Some(&email),
            Some(if full_name.is_empty() { &email } else { &full_name }),
            web::string_field(ctx.body, "phone").as_deref(),
            auth::ROLE_CITIZEN,
        );
        return Ok(web::status_json(
            StatusCode::CREATED,
            auth::issue_session(ctx.config(), base, true).json(),
        ));
    }
    let opts = ctx.opts();
    let session = ctx
        .client()
        .auth()
        .register(
            &email,
            &password,
            (!full_name.is_empty()).then_some(full_name.as_str()),
            web::string_field(ctx.body, "org_slug").as_deref(),
            &opts,
        )
        .await
        .map_err(auth::identity_error)?;
    let value = serde_json::to_value(&session).unwrap_or(Value::Null);
    let identity = auth::identity_from_session(&value)?;
    let profile = json!({ "username": if full_name.is_empty() { email.clone() } else { full_name.clone() } });
    let response = session_for_identity(
        ctx,
        &identity,
        auth::ROLE_CITIZEN,
        &auth::Tier2Session {
            identity: identity.clone(),
            token: Some(session.access_token.clone()),
            refresh_token: Some(session.refresh_token.clone()),
            exchanged: false,
        },
        Some(profile.as_object().unwrap_or(&Map::new())),
    )?;
    Ok(web::status_json(StatusCode::CREATED, response))
}

async fn auth_refresh(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let token = web::string_field(ctx.body, "refresh_token").unwrap_or_default();
    let principal = auth::verify_token(ctx.config(), &token, "refresh").ok_or_else(|| {
        ApiError::new(StatusCode::UNAUTHORIZED, "invalid_refresh_token", "invalid_refresh_token")
    })?;
    if principal.demo == Some(true) && !ctx.config().demo_auth_allowed() {
        return Err(ApiError::unavailable(
            "identity_not_configured",
            "Identity verification is unavailable.",
        ));
    }
    if principal.auth_source.as_deref() == Some("tier2") {
        let refresh = principal.tier2_refresh_token.clone().ok_or_else(|| {
            ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_refresh_token",
                "no_tier2_refresh_token",
            )
        })?;
        let opts = ctx.opts();
        let rotated = ctx
            .client()
            .auth()
            .refresh(&refresh, &opts)
            .await
            .map_err(auth::identity_error)?;
        let mut base = principal.clone();
        base.tier2_token = Some(rotated.access_token);
        base.tier2_refresh_token = Some(rotated.refresh_token);
        base.permissions = auth::permissions_for_role(&base.role);
        return Ok(web::json_response(auth::issue_session(ctx.config(), base, false).json()));
    }
    let mut base = principal.clone();
    base.permissions = auth::permissions_for_role(&base.role);
    Ok(web::json_response(auth::issue_session(ctx.config(), base, principal.demo == Some(true)).json()))
}

async fn auth_logout(ctx: &Ctx<'_>) -> ApiResult<Response> {
    if let Some(principal) = ctx.principal() {
        auth::revoke_session(principal);
    }
    let token = web::string_field(ctx.body, "refresh_token").unwrap_or_default();
    if let Some(principal) = auth::verify_token(ctx.config(), &token, "refresh") {
        auth::revoke_session(&principal);
        if let Some(refresh) = principal.tier2_refresh_token {
            let opts = ctx.opts();
            let _ = ctx.client().auth().logout(&refresh, &opts).await;
        }
    }
    Ok(web::no_content())
}

async fn auth_change_password(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let principal = ctx.principal().ok_or_else(|| {
        ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "authentication_required")
    })?;
    let current = web::string_field(ctx.body, "current_password").unwrap_or_default();
    let new_password = web::string_field(ctx.body, "new_password").unwrap_or_default();
    if current.trim().is_empty() || new_password.trim().is_empty() {
        return Err(ApiError::bad_request(
            "current_and_new_password_required",
            "current and new password are required",
        ));
    }
    if principal.auth_source.as_deref() != Some("tier2") || principal.tier2_token.is_none() {
        return Err(ApiError::unavailable(
            "identity_not_configured",
            "Password changes require the Tier-2 identity capability.",
        ));
    }
    let opts = ctx.opts();
    ctx.client()
        .auth()
        .change_password(&current, &new_password, &opts)
        .await
        .map_err(auth::identity_error)?;
    Ok(web::no_content())
}

fn auth_me(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let principal = ctx.principal().ok_or_else(|| {
        ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "authentication_required")
    })?;
    Ok(web::json_response(auth::user_json(&auth::user_from_principal(principal))))
}

fn auth_verify(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let principal = ctx.principal().ok_or_else(|| {
        ApiError::new(StatusCode::UNAUTHORIZED, "unauthorized", "authentication_required")
    })?;
    Ok(web::json_response(json!({
        "valid": true,
        "user_id": principal.sub,
        "username": principal.username,
        "role": principal.role,
        "permissions": principal.permissions,
        "identity_source": principal.auth_source.clone().unwrap_or_else(|| "legacy".into()),
    })))
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

fn requester_can_use_file(principal: Option<&SessionPrincipal>, record: &Map<String, Value>) -> bool {
    if record.get("public").and_then(Value::as_bool) == Some(true) {
        return true;
    }
    let Some(principal) = principal else {
        return false;
    };
    if [auth::ROLE_ADMIN, auth::ROLE_MANAGER].contains(&principal.role.as_str()) {
        return true;
    }
    let owner = record
        .get("owner")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    !owner.is_empty()
        && [principal.sub.to_ascii_lowercase(), principal.username.to_ascii_lowercase()]
            .contains(&owner)
}

async fn file_metadata(ctx: &Ctx<'_>, id: &str) -> ApiResult<Option<Map<String, Value>>> {
    let opts = ctx.opts();
    match tier2::get(ctx.client(), &opts, tier2::FILES, id).await {
        Ok(row) => Ok(Some(row)),
        Err(error) if error.status == StatusCode::NOT_FOUND => Ok(None),
        Err(error) => Err(error),
    }
}

async fn save_file_metadata(ctx: &Ctx<'_>, file: Map<String, Value>) -> ApiResult<Map<String, Value>> {
    let opts = ctx.opts();
    let id = file.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    if id.is_empty() {
        return Err(ApiError::bad_request("file_id_required", "file id is required"));
    }
    match tier2::create(ctx.client(), &opts, tier2::FILES, file.clone(), Some(&id)).await {
        Ok(saved) => Ok(saved),
        Err(error) if error.status == StatusCode::CONFLICT || error.status == StatusCode::BAD_REQUEST => {
            tier2::update(ctx.client(), &opts, tier2::FILES, &id, file, None).await
        }
        Err(error) => Err(error),
    }
}

async fn files_quota(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let quota = ctx.client().files().quota(&opts).await.map_err(ApiError::from)?;
    let mut value = quota;
    if let Some(object) = value.as_object_mut() {
        object.insert("cityMaxFileBytes".into(), json!(ctx.config().files_max_bytes));
        object.insert("allowedTypes".into(), json!(domain::files::UPLOAD_MIME_TYPES));
    }
    Ok(web::json_response(value))
}

async fn files_list(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let principal = ctx.principal();
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, tier2::FILES, 5000).await?;
    let filters = query_filters(ctx.query);
    let values: Vec<Value> = rows
        .items
        .into_iter()
        .filter(|row| requester_can_use_file(principal, row))
        .filter(|row| matches_filters(row, &filters))
        .map(|row| file_view(ctx.config(), &row))
        .collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn files_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let principal = ctx.principal().ok_or_else(|| ApiError::unauthorized("authentication_required"))?;
    let body = web::private_input(ctx.body);
    if web::bool_field(&body, "is_public") == Some(true)
        && ![auth::ROLE_ADMIN, auth::ROLE_MANAGER].contains(&principal.role.as_str())
    {
        return Err(ApiError::forbidden(
            "public_file_forbidden",
            "Only an administrator or manager may create a public file.",
        ));
    }
    let validated = domain::files::validate_upload(
        body.get("filename").or_else(|| body.get("file_name")),
        body.get("content_type").or_else(|| body.get("contentType")),
        body.get("size"),
        None,
        Some(ctx.config().files_max_bytes as i64),
    )
    .map_err(file_error)?;
    let id = uuid::Uuid::new_v4().to_string();
    let checksum = domain::files::normalize_checksum(
        body.get("checksum_sha256").or_else(|| body.get("checksumSha256")),
    )
    .map_err(file_error)?;
    let metadata = json!({
        "id": id,
        "filename": validated.filename,
        "contentType": validated.content_type,
        "size": validated.size,
        "checksumSha256": checksum,
        "datasetId": tier2::FILES.id,
        "recordId": id,
    });
    let opts = ctx.opts();
    let ticket = ctx
        .client()
        .files()
        .create(metadata, &opts)
        .await
        .map_err(ApiError::from)?;
    let now = crate::now_iso();
    let mut file = Map::new();
    file.insert("id".into(), json!(ticket.id));
    file.insert("filename".into(), json!(validated.filename));
    file.insert("contentType".into(), json!(validated.content_type));
    file.insert("size".into(), json!(validated.size));
    if let Some(checksum) = checksum {
        file.insert("checksumSha256".into(), json!(checksum));
    }
    file.insert("owner".into(), json!(principal.sub));
    file.insert("public".into(), json!(web::bool_field(&body, "is_public") == Some(true)));
    file.insert("created_at".into(), json!(now));
    file.insert("updated_at".into(), json!(now));
    file.insert("source".into(), json!("synapsecity"));
    file.insert("storage".into(), json!("tier2-files"));
    let saved = save_file_metadata(ctx, file).await?;
    let presigned = ctx
        .client()
        .files()
        .presign(&saved.get("id").and_then(Value::as_str).unwrap_or("").to_string(), "PUT", Some(900), &opts)
        .await
        .ok()
        .map(|value| json!({
            "method": value.get("method"),
            "url": value.get("url"),
            "expires_in": value.get("expiresIn").or_else(|| value.get("expires_in")).cloned().unwrap_or(json!(900)),
        }));
    let mut view = file_view(ctx.config(), &saved);
    if let Some(object) = view.as_object_mut() {
        object.insert("upload".into(), json!({
            "method": "PUT",
            "url": format!("{}/v1/files/{}/content", ctx.config().public_url, saved.get("id").and_then(Value::as_str).unwrap_or("")),
            "contentType": validated.content_type,
            "presigned": presigned,
        }));
    }
    Ok(web::created(view))
}

async fn files_upload_raw(ctx: Ctx<'_>, bytes: Bytes, public: bool) -> ApiResult<Response> {
    let principal = ctx.principal().cloned();
    if !public && principal.is_none() {
        return Err(ApiError::unauthorized("authentication_required"));
    }
    if public {
        enforce_turnstile(&ctx)?;
    }
    if bytes.is_empty() {
        return Err(ApiError::bad_request("binary_body_required", "binary body is required"));
    }
    let filename = ctx
        .headers
        .get("x-file-name")
        .or_else(|| ctx.headers.get("x-filename"))
        .and_then(|value| value.to_str().ok())
        .map(|value| percent_encoding::percent_decode_str(value).decode_utf8_lossy().to_string())
        .unwrap_or_default();
    if filename.is_empty() {
        return Err(ApiError::bad_request("x_file_name_required", "X-File-Name is required"));
    }
    let content_type = ctx
        .headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .to_string();
    let allowlist = if public { &domain::files::IMAGE_MIME_TYPES[..] } else { &domain::files::UPLOAD_MIME_TYPES[..] };
    let max_bytes = if public { ctx.config().photo_max_bytes } else { ctx.config().files_max_bytes };
    let validated = domain::files::validate_upload(
        Some(&json!(filename)),
        Some(&json!(content_type)),
        Some(&json!(bytes.len())),
        Some(allowlist),
        Some(max_bytes as i64),
    )
    .map_err(file_error)?;
    let checksum = domain::files::checksum_of(&bytes);
    let provided = ctx
        .headers
        .get("x-checksum-sha256")
        .and_then(|value| value.to_str().ok());
    if let Some(provided) = provided {
        if let Some(expected) = domain::files::normalize_checksum(Some(&json!(provided))).map_err(file_error)? {
            if expected != checksum {
                return Err(ApiError::bad_request("checksum_mismatch", "checksum mismatch"));
            }
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    let metadata = json!({
        "id": id,
        "filename": validated.filename,
        "contentType": validated.content_type,
        "size": validated.size,
        "checksumSha256": checksum,
        "datasetId": tier2::FILES.id,
        "recordId": id,
    });
    let opts = ctx.opts();
    ctx.client()
        .files()
        .upload(metadata, bytes, &validated.content_type, &opts)
        .await
        .map_err(ApiError::from)?;
    let now = crate::now_iso();
    let mut file = Map::new();
    file.insert("id".into(), json!(id));
    file.insert("filename".into(), json!(validated.filename));
    file.insert("contentType".into(), json!(validated.content_type));
    file.insert("size".into(), json!(validated.size));
    file.insert("checksumSha256".into(), json!(checksum));
    file.insert(
        "owner".into(),
        json!(if public {
            "anonymous"
        } else {
            principal.as_ref().map(|value| value.sub.as_str()).unwrap_or("anonymous")
        }),
    );
    file.insert("public".into(), json!(public));
    file.insert("created_at".into(), json!(now));
    file.insert("updated_at".into(), json!(now));
    file.insert("source".into(), json!("synapsecity"));
    file.insert("storage".into(), json!("tier2-files"));
    let saved = save_file_metadata(&ctx, file).await?;
    Ok(web::created(file_view(ctx.config(), &saved)))
}

async fn files_update_raw(ctx: Ctx<'_>, id: &str, bytes: Bytes) -> ApiResult<Response> {
    let principal = ctx.principal().cloned().ok_or_else(|| ApiError::unauthorized("authentication_required"))?;
    let Some(record) = file_metadata(&ctx, id).await? else {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    };
    if !requester_can_use_file(Some(&principal), &record) {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    }
    if bytes.is_empty() {
        return Err(ApiError::bad_request("binary_body_required", "binary body is required"));
    }
    let content_type = ctx
        .headers
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .or_else(|| record.get("contentType").and_then(Value::as_str))
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .to_string();
    let checksum = domain::files::checksum_of(&bytes);
    let opts = ctx.opts();
    ctx.client()
        .files()
        .upload_bytes(id, bytes.clone(), &content_type, Some(&checksum), &opts)
        .await
        .map_err(ApiError::from)?;
    let mut file = record;
    file.insert("contentType".into(), json!(content_type));
    file.insert("size".into(), json!(bytes.len()));
    file.insert("checksumSha256".into(), json!(checksum));
    file.insert("updated_at".into(), json!(crate::now_iso()));
    let saved = save_file_metadata(&ctx, file).await?;
    Ok(web::json_response(file_view(ctx.config(), &saved)))
}

async fn files_get(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(record) = file_metadata(ctx, id).await? else {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    };
    if !requester_can_use_file(ctx.principal(), &record) {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    }
    Ok(web::json_response(file_view(ctx.config(), &record)))
}

async fn files_content(ctx: &Ctx<'_>, id: &str, public: bool) -> ApiResult<Response> {
    let Some(record) = file_metadata(ctx, id).await? else {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    };
    if public {
        if record.get("public").and_then(Value::as_bool) != Some(true) {
            return Err(ApiError::not_found("file_not_found", "file_not_found"));
        }
    } else if !requester_can_use_file(ctx.principal(), &record) {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    }
    let opts = ctx.opts();
    let download = ctx.client().files().download(id, &opts).await.map_err(ApiError::from)?;
    let content_type = download
        .header("content-type")
        .map(str::to_string)
        .or_else(|| record.get("contentType").and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(|| "application/octet-stream".into());
    let checksum = download.header("x-checksum-sha256").map(str::to_string).or_else(|| record.get("checksumSha256").and_then(Value::as_str).map(str::to_string));
    let mut response = Response::new(axum::body::Body::from(download.data));
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    if let Some(checksum) = checksum {
        if let Ok(value) = HeaderValue::from_str(&checksum) {
            response.headers_mut().insert("x-checksum-sha256", value);
        }
    }
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static(if public { "public, max-age=300" } else { "private, no-store" }),
    );
    Ok(response)
}

async fn files_presign(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(record) = file_metadata(ctx, id).await? else {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    };
    if !requester_can_use_file(ctx.principal(), &record) {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    }
    let method = web::string_field(ctx.body, "method").unwrap_or_else(|| "GET".into()).to_ascii_uppercase();
    let method = if ["GET", "HEAD", "PUT", "DELETE"].contains(&method.as_str()) { method } else { "GET".into() };
    let expires = ctx
        .body
        .get("expires_in")
        .or_else(|| ctx.body.get("expiresIn"))
        .and_then(Value::as_i64)
        .unwrap_or(900);
    let opts = ctx.opts();
    let signed = ctx
        .client()
        .files()
        .presign(id, &method, Some(expires), &opts)
        .await
        .map_err(ApiError::from)?;
    let mut response = web::json_response(json!({
        "file_id": id,
        "method": signed.get("method").and_then(Value::as_str).unwrap_or(&method),
        "url": signed.get("url"),
        "expires_in": signed.get("expiresIn").or_else(|| signed.get("expires_in")).cloned().unwrap_or(json!(expires)),
    }));
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    Ok(response)
}

async fn files_complete(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(record) = file_metadata(ctx, id).await? else {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    };
    if !requester_can_use_file(ctx.principal(), &record) {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    }
    let size = ctx.body.get("size").and_then(Value::as_i64);
    let opts = ctx.opts();
    let completed = ctx.client().files().complete(id, size, &opts).await.map_err(ApiError::from)?;
    let mut file = record;
    if let Some(size) = completed.size {
        file.insert("size".into(), json!(size));
    }
    if let Some(content_type) = completed.content_type {
        file.insert("contentType".into(), json!(content_type));
    }
    if let Some(checksum) = completed.checksum_sha256 {
        file.insert("checksumSha256".into(), json!(checksum));
    }
    file.insert("updated_at".into(), json!(crate::now_iso()));
    let saved = save_file_metadata(ctx, file).await?;
    Ok(web::json_response(file_view(ctx.config(), &saved)))
}

async fn files_delete(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(record) = file_metadata(ctx, id).await? else {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    };
    if !requester_can_use_file(ctx.principal(), &record) {
        return Err(ApiError::not_found("file_not_found", "file_not_found"));
    }
    let opts = ctx.opts();
    let _ = ctx.client().files().delete(id, &opts).await;
    let _ = tier2::delete(ctx.client(), &opts, tier2::FILES, id).await;
    Ok(web::no_content())
}

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

async fn all_assets(ctx: &Ctx<'_>) -> ApiResult<Vec<Map<String, Value>>> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, ASSETS, 5000).await?;
    Ok(rows.items.into_iter().map(|row| asset_view(&row)).collect())
}

async fn find_asset(ctx: &Ctx<'_>, reference: &str) -> ApiResult<Option<Map<String, Value>>> {
    let opts = ctx.opts();
    if let Ok(row) = tier2::get(ctx.client(), &opts, ASSETS, reference).await {
        return Ok(Some(asset_view(&row)));
    }
    let rows = tier2::list_all(ctx.client(), &opts, ASSETS, 5000).await?;
    let needle = reference.to_ascii_lowercase();
    Ok(rows.items.into_iter().find(|row| {
        ["asset_code", "feature_code", "assetId", "id"]
            .iter()
            .any(|key| row.get(*key).and_then(Value::as_str).map(|value| value.eq_ignore_ascii_case(&needle)).unwrap_or(false))
    }).map(|row| asset_view(&row)))
}

async fn assets_list(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let rows = all_assets(ctx).await?;
    let filters = query_filters(ctx.query);
    let values: Vec<Value> = rows
        .into_iter()
        .filter(|row| matches_filters(row, &filters))
        .map(Value::Object)
        .collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn assets_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let name = web::required_string(&body, "name")?;
    let code = web::string_field(&body, "asset_code")
        .or_else(|| web::string_field(&body, "feature_code"))
        .or_else(|| web::string_field(&body, "assetCode"))
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let geometry = body.get("geometry").cloned().unwrap_or_else(|| json!({"type":"Point","coordinates":[0,0]}));
    if !geometry.is_object() || !geometry.get("type").and_then(Value::as_str).is_some() || geometry.get("coordinates").and_then(Value::as_array).is_none() {
        return Err(ApiError::bad_request("geometry_must_be_geojson", "geometry_must_be_geojson"));
    }
    let mut asset = Map::new();
    asset.insert("id".into(), json!(web::string_field(&body, "id").unwrap_or_else(|| code.clone())));
    asset.insert("assetId".into(), json!(web::string_field(&body, "assetId").unwrap_or_else(|| code.clone())));
    asset.insert("asset_code".into(), json!(code));
    asset.insert("name".into(), json!(name));
    asset.insert("assetType".into(), json!(web::string_field(&body, "assetType").or_else(|| web::string_field(&body, "feature_type")).unwrap_or_else(|| "infrastructure".into())));
    asset.insert("feature_type".into(), json!(web::string_field(&body, "feature_type").or_else(|| web::string_field(&body, "assetType")).unwrap_or_else(|| "infrastructure".into())));
    asset.insert("feature_code".into(), json!(web::string_field(&body, "feature_code").unwrap_or_else(|| code.clone())));
    asset.insert("status".into(), json!(web::string_field(&body, "status").unwrap_or_else(|| "active".into())));
    asset.insert("geometry".into(), geometry.clone());
    asset.insert("location".into(), body.get("location").cloned().unwrap_or_else(|| json!({"geometry": geometry})));
    asset.insert("public_visible".into(), json!(web::bool_field(&body, "public_visible") != Some(false)));
    asset.insert("source".into(), json!("synapsecity"));
    asset.insert("sourceVersion".into(), json!("1.0.0"));
    for key in ["category", "condition", "lifecycle_stage", "municipality", "owner"] {
        if let Some(value) = body.get(key) {
            asset.insert(key.into(), value.clone());
        }
    }
    for key in ["specifications", "properties", "metadata"] {
        if let Some(value) = body.get(key).filter(|value| value.is_object()) {
            asset.insert(key.into(), value.clone());
        }
    }
    let opts = ctx.opts();
    let id = asset.get("id").and_then(Value::as_str).unwrap_or(&code).to_string();
    let created = tier2::create(ctx.client(), &opts, ASSETS, asset, Some(&id)).await?;
    Ok(web::created(Value::Object(asset_view(&created))))
}

async fn assets_get(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(asset) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    Ok(web::json_response(Value::Object(asset)))
}

async fn update_asset(ctx: &Ctx<'_>, id: &str, patch: Map<String, Value>) -> ApiResult<Map<String, Value>> {
    let opts = ctx.opts();
    let mut current = find_asset(ctx, id).await?.ok_or_else(|| ApiError::not_found("asset_not_found", "asset_not_found"))?;
    let record_id = current.get("id").and_then(Value::as_str).unwrap_or(id).to_string();
    for (key, value) in patch {
        current.insert(key, value);
    }
    current.insert("id".into(), json!(record_id));
    current.insert("source".into(), json!("synapsecity"));
    current.insert("updatedBy".into(), json!("domain-api"));
    current.insert("updated_at".into(), json!(crate::now_iso()));
    let row = tier2::update(ctx.client(), &opts, ASSETS, &record_id, current, None).await?;
    Ok(asset_view(&row))
}

async fn assets_patch(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    if let Some(name) = body.get("name").and_then(Value::as_str) {
        if name.trim().is_empty() {
            return Err(ApiError::bad_request("name_must_not_be_empty", "name_must_not_be_empty"));
        }
    }
    let updated = update_asset(ctx, id, body).await?;
    Ok(web::json_response(Value::Object(updated)))
}

async fn assets_delete(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let mut patch = Map::new();
    patch.insert("deleted_at".into(), json!(crate::now_iso()));
    patch.insert("status".into(), json!("decommissioned"));
    patch.insert("lifecycle_status".into(), json!("decommissioned"));
    patch.insert("public_visible".into(), json!(false));
    update_asset(ctx, id, patch).await?;
    Ok(web::no_content())
}

async fn assets_photos(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let values: Vec<Value> = body
        .get("photos")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| body.get("file_ids").and_then(Value::as_array).cloned())
        .or_else(|| body.get("file_id").cloned().map(|value| vec![value]))
        .or_else(|| body.get("file_url").cloned().map(|value| vec![value]))
        .unwrap_or_default();
    if values.is_empty() {
        return Err(ApiError::bad_request("photos_required", "photos_required"));
    }
    if values.len() > 20 {
        return Err(ApiError::too_large("too_many_photos", "too_many_photos"));
    }
    let resolved = resolve_photos(ctx, &values, false).await?;
    let Some(existing) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let mut photos: Vec<Value> = existing.get("photos").and_then(Value::as_array).cloned().unwrap_or_default();
    photos.extend(resolved.iter().map(|entry| json!(entry.get("url").and_then(Value::as_str).unwrap_or(""))));
    let mut attachments: Vec<Value> = existing.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
    attachments.extend(resolved.iter().filter_map(|entry| entry.get("attachment").cloned()));
    let mut patch = Map::new();
    patch.insert("photos".into(), Value::Array(photos));
    patch.insert("attachments".into(), Value::Array(attachments));
    let updated = update_asset(ctx, id, patch).await?;
    Ok(web::json_response(Value::Object(updated)))
}

async fn assets_attachments(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let attachment = attachment_from_body(ctx, &body, "attachment", false).await?;
    let Some(existing) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let mut current = existing.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
    current.push(Value::Object(attachment.clone()));
    let mut patch = Map::new();
    patch.insert("attachments".into(), Value::Array(current));
    let updated = update_asset(ctx, id, patch).await?;
    let _ = updated;
    Ok(web::created(Value::Object(attachment)))
}

async fn assets_attachment_delete(ctx: &Ctx<'_>, id: &str, url: &str) -> ApiResult<Response> {
    let target = percent_encoding::percent_decode_str(url).decode_utf8_lossy().to_string();
    let Some(existing) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let attachments: Vec<Value> = existing
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|attachment| {
            let file_url = attachment.get("file_url").and_then(Value::as_str).unwrap_or("");
            let file_name = attachment.get("file_name").and_then(Value::as_str).unwrap_or("");
            file_url != target && file_name != target
        })
        .collect();
    let photos: Vec<Value> = existing
        .get("photos")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|value| value.as_str() != Some(target.as_str()))
        .collect();
    let mut patch = Map::new();
    patch.insert("attachments".into(), Value::Array(attachments));
    patch.insert("photos".into(), Value::Array(photos));
    update_asset(ctx, id, patch).await?;
    Ok(web::no_content())
}

async fn assets_documents(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(existing) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    Ok(web::json_response(existing.get("attachments").cloned().unwrap_or_else(|| json!([]))))
}

async fn assets_document_add(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let attachment = attachment_from_body(ctx, &body, "document", false).await?;
    let Some(existing) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let mut current = existing.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
    current.push(Value::Object(attachment.clone()));
    let mut patch = Map::new();
    patch.insert("attachments".into(), Value::Array(current));
    update_asset(ctx, id, patch).await?;
    Ok(web::created(Value::Object(attachment)))
}

async fn assets_lifecycle(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let status = web::string_field(&body, "lifecycle_status").unwrap_or_default();
    let mapped = match status.as_str() {
        "operational" => "active",
        "under_repair" | "damaged" => "maintenance",
        "decommissioned" => "decommissioned",
        _ => return Err(ApiError::bad_request("invalid_lifecycle_status", "invalid_lifecycle_status")),
    };
    let Some(existing) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let mut lifecycle = existing.get("lifecycle").and_then(Value::as_object).cloned().unwrap_or_default();
    lifecycle.insert("lifecycle_status".into(), json!(status));
    let mut patch = Map::new();
    patch.insert("lifecycle".into(), Value::Object(lifecycle));
    patch.insert("lifecycle_stage".into(), json!(status));
    patch.insert("status".into(), json!(mapped));
    let updated = update_asset(ctx, id, patch).await?;
    Ok(web::json_response(Value::Object(updated)))
}

async fn assets_criticality(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let criticality = json!({
        "service_impact": web::number_field(&body, "service_impact").unwrap_or(3.0).clamp(1.0, 5.0),
        "population_served": web::number_field(&body, "population_served").unwrap_or(0.0).max(0.0),
        "redundancy": web::number_field(&body, "redundancy").unwrap_or(3.0).clamp(1.0, 5.0),
        "safety_impact": web::number_field(&body, "safety_impact").unwrap_or(3.0).clamp(1.0, 5.0),
    });
    let Some(existing) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let mut patch = Map::new();
    patch.insert("criticality".into(), criticality.clone());
    let updated = update_asset(ctx, id, patch).await?;
    let _ = existing;
    Ok(web::json_response(json!({ "asset": updated, "criticality": criticality })))
}

async fn asset_risk_result(ctx: &Ctx<'_>, asset_id: &str) -> ApiResult<Option<domain::risk::AssetRiskResult>> {
    let Some(asset) = find_asset(ctx, asset_id).await? else {
        return Ok(None);
    };
    let opts = ctx.opts();
    let incident_rows = tier2::list_all(ctx.client(), &opts, INCIDENTS, 5000).await?;
    let maintenance_rows = tier2::list_all(ctx.client(), &opts, MAINTENANCE, 5000).await?;
    let sensor_rows = tier2::list_all(ctx.client(), &opts, tier2::SENSORS, 5000).await?;
    let reading_rows = tier2::list_all(ctx.client(), &opts, tier2::SENSOR_DATA, 5000).await?;
    let key = asset.get("id").and_then(Value::as_str).unwrap_or(asset_id).to_string();
    let code = asset_code(&asset);
    let matches_asset = |row: &Map<String, Value>| {
        ["asset_id", "assetId", "asset_code"].iter().any(|field| {
            row.get(*field)
                .and_then(Value::as_str)
                .map(|value| value == key || value == code)
                .unwrap_or(false)
        })
    };
    let incidents: Vec<Map<String, Value>> = incident_rows.items.into_iter().filter(|row| matches_asset(row)).map(|row| incident_view(&row)).collect();
    let maintenance: Vec<Map<String, Value>> = maintenance_rows.items.into_iter().filter(|row| matches_asset(row)).collect();
    let sensor_ids: HashSet<String> = sensor_rows
        .items
        .iter()
        .filter(|row| matches_asset(row))
        .filter_map(|row| row.get("id").or_else(|| row.get("sensor_id")).and_then(Value::as_str).map(str::to_string))
        .collect();
    let sensors: Vec<domain::risk::RiskSensorReading> = reading_rows
        .items
        .into_iter()
        .filter(|row| sensor_ids.is_empty() || row.get("sensor_id").or_else(|| row.get("sensorId")).and_then(Value::as_str).map(|id| sensor_ids.contains(id)).unwrap_or(false))
        .map(|row| domain::risk::RiskSensorReading {
            metric: row.get("metric").and_then(Value::as_str).map(str::to_string),
            value: row.get("value").and_then(Value::as_f64),
            unit: row.get("unit").and_then(Value::as_str).map(str::to_string),
            min: row.get("min").and_then(Value::as_f64),
            max: row.get("max").and_then(Value::as_f64),
            observed_at: row.get("observed_at").or_else(|| row.get("timestamp")).and_then(Value::as_str).map(str::to_string),
        })
        .collect();
    let mut asset_for_risk = asset;
    asset_for_risk.insert("id".into(), json!(key));
    Ok(Some(domain::risk::score_asset_risk(domain::risk::ScoreAssetRiskInput {
        asset: asset_for_risk,
        incidents,
        maintenance,
        sensors,
        now: None,
        stale_after_minutes: None,
    })))
}

async fn assets_risk(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(result) = asset_risk_result(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    Ok(web::json_response(serde_json::to_value(result).unwrap_or(Value::Null)))
}

async fn risk_top(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let limit = ctx.query.get("limit").and_then(|value| value.parse::<usize>().ok()).unwrap_or(10).clamp(1, 100);
    let assets = all_assets(ctx).await?;
    let mut results = Vec::new();
    for asset in assets.iter().take(500) {
        if let Some(id) = asset.get("id").and_then(Value::as_str) {
            if let Ok(Some(result)) = asset_risk_result(ctx, id).await {
                results.push(result);
            }
        }
    }
    let total = results.len();
    let ranked = domain::risk::rank_assets_by_risk(results);
    Ok(web::json_response(json!({
        "items": ranked.into_iter().take(limit).map(|result| serde_json::to_value(result).unwrap_or(Value::Null)).collect::<Vec<_>>(),
        "total": total,
    })))
}

async fn assets_risk_work_order(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(risk) = asset_risk_result(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let body = web::private_input(ctx.body);
    let actor = ctx.principal().map(|principal| principal.username.clone()).unwrap_or_else(|| "city-user".into());
    let approval_id = web::string_field(&body, "approval_id").or_else(|| web::string_field(&body, "approvalId"));
    if ctx.config().hitl_required && approval_id.is_none() {
        let approval = create_approval(
            ctx,
            format!("Predictive maintenance for {}", risk.asset_id),
            "city.maintenance",
            "maintenance.approve",
            "asset",
            id,
            json!({ "risk_score": risk.score, "band": risk.band, "confidence": risk.confidence }),
            &actor,
        ).await?;
        return Ok(web::accepted(json!({ "approval": approval, "hitl_required": true, "risk": risk })));
    }
    let approved = approval_id.is_some();
    if let Some(approval_id) = &approval_id {
        assert_approved(ctx, approval_id, id, "maintenance.approve", &actor).await?;
    }
    let mut input = Map::new();
    input.insert("title".into(), json!(web::string_field(&body, "title").unwrap_or_else(|| format!("Predictive maintenance: {}", risk.asset_id))));
    input.insert("asset_id".into(), json!(id));
    input.insert("type".into(), json!("preventive"));
    input.insert("source".into(), json!("predictive-risk"));
    input.insert("priority".into(), json!(if risk.score >= 75.0 { "critical" } else if risk.score >= 55.0 { "high" } else { "medium" }));
    input.insert("status".into(), json!(if approved { "scheduled" } else { "recommended" }));
    input.insert("risk_score".into(), json!(risk.score));
    input.insert("risk_band".into(), json!(risk.band));
    input.insert("scheduled_date".into(), json!(crate::now_iso()));
    let opts = ctx.opts();
    let work_order = tier2::create(ctx.client(), &opts, MAINTENANCE, input, None).await?;
    Ok(web::created(json!({ "work_order": work_order, "risk": risk })))
}

async fn assets_health(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(asset) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let opts = ctx.opts();
    let incidents = tier2::list_all(ctx.client(), &opts, INCIDENTS, 5000).await?;
    let asset_id = asset.get("id").and_then(Value::as_str).unwrap_or(id);
    let open = incidents
        .items
        .iter()
        .filter(|incident| incident.get("asset_id").or_else(|| incident.get("assetId")).and_then(Value::as_str) == Some(asset_id))
        .filter(|incident| !["resolved", "closed"].contains(&incident.get("status").and_then(Value::as_str).unwrap_or("")))
        .count();
    let condition = asset.get("condition").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let condition_score = match condition.as_str() {
        "excellent" => 95.0,
        "good" => 85.0,
        "fair" => 70.0,
        "poor" => 45.0,
        "critical" => 20.0,
        _ => 75.0,
    };
    let status = asset.get("status").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let status_score = match status.as_str() {
        "active" | "operational" => 100.0,
        "maintenance" | "under_repair" => 60.0,
        "damaged" => 35.0,
        "inactive" => 25.0,
        "decommissioned" => 0.0,
        _ => 75.0,
    };
    let maintenance_score = 75.0;
    let incident_score = (100.0 - open as f64 * 15.0).max(0.0);
    let overall = (condition_score * 0.3 + status_score * 0.2 + maintenance_score * 0.25 + incident_score * 0.15 + 75.0 * 0.1).round();
    let health_status = if overall >= 80.0 { "excellent" } else if overall >= 60.0 { "good" } else if overall >= 40.0 { "fair" } else { "poor" };
    Ok(web::json_response(json!({
        "health_score": overall,
        "health_status": health_status,
        "breakdown": {
            "condition_score": condition_score,
            "status_score": status_score,
            "maintenance_score": maintenance_score,
            "incident_score": incident_score,
            "age_score": 75.0,
        },
    })))
}

async fn assets_report(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(asset) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let body = web::private_input(ctx.body);
    let report = create_report(ctx, body, Some(asset.get("id").and_then(Value::as_str).unwrap_or(id))).await?;
    Ok(web::created(json!({
        "report_id": report.get("id"),
        "report_url": report.get("download_url"),
        "row_count": report.get("row_count"),
        "format": report.get("format"),
    })))
}

async fn assets_preventive(ctx: &Ctx<'_>, id: &str, view: Option<&str>) -> ApiResult<Response> {
    let Some(asset) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    if view.is_none() {
        return Ok(web::json_response(asset.get("preventive_maintenance_plan").cloned().unwrap_or(Value::Null)));
    }
    let view = view.unwrap_or("tasks").to_ascii_lowercase();
    let view = match view.as_str() {
        "tasks" => domain::preventive::PreventiveView::Tasks,
        "upcoming" => domain::preventive::PreventiveView::Upcoming,
        "overdue" => domain::preventive::PreventiveView::Overdue,
        _ => return Err(ApiError::not_found("preventive_view_not_found", "preventive_view_not_found")),
    };
    let opts = ctx.opts();
    let orders = tier2::list_all(ctx.client(), &opts, MAINTENANCE, 5000).await?;
    let asset_ids: HashSet<String> = [asset.get("id"), asset.get("asset_code")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect();
    let work_orders: Vec<Map<String, Value>> = orders
        .items
        .into_iter()
        .filter(|order| {
            order.get("asset_id").or_else(|| order.get("assetId")).and_then(Value::as_str).map(|id| asset_ids.contains(id)).unwrap_or(false)
        })
        .collect();
    let plan = asset.get("preventive_maintenance_plan").and_then(Value::as_object);
    let tasks = domain::preventive::derive_preventive_tasks(plan, &work_orders, None);
    let tasks = domain::preventive::filter_preventive_tasks(&tasks, view);
    let values: Vec<Value> = tasks.into_iter().filter_map(|task| serde_json::to_value(task).ok()).collect();
    Ok(web::send_page(values, ctx.query, 100))
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

fn incident_internal_id(incident_id: &str) -> String {
    format!("internal-{incident_id}")
}

async fn find_incident_internal(ctx: &Ctx<'_>, incident_id: &str) -> ApiResult<Option<Map<String, Value>>> {
    let opts = ctx.opts();
    for id in [incident_internal_id(incident_id), incident_id.to_string()] {
        if let Ok(row) = tier2::get(ctx.client(), &opts, INCIDENT_INTERNAL, &id).await {
            return Ok(Some(row));
        }
    }
    Ok(None)
}

async fn write_incident_internal(ctx: &Ctx<'_>, incident_id: &str, record: &Map<String, Value>) -> ApiResult<()> {
    let Some(internal) = domain::incidents::to_internal_incident(record) else {
        return Ok(());
    };
    let opts = ctx.opts();
    let id = incident_internal_id(incident_id);
    let mut payload = internal;
    payload.insert("id".into(), json!(id));
    payload.insert("incident_id".into(), json!(incident_id));
    match tier2::update(ctx.client(), &opts, INCIDENT_INTERNAL, &id, payload.clone(), None).await {
        Ok(_) => Ok(()),
        Err(error) if error.status == StatusCode::NOT_FOUND => {
            tier2::create(ctx.client(), &opts, INCIDENT_INTERNAL, payload, Some(&id)).await?;
            Ok(())
        }
        Err(error) => Err(error),
    }
}

async fn find_incident(ctx: &Ctx<'_>, reference: &str) -> ApiResult<Option<Map<String, Value>>> {
    let Some(found) = find_record(ctx, INCIDENTS, reference, &["incident_number", "incident_code", "incidentId", "id"]).await? else {
        return Ok(None);
    };
    let internal = find_incident_internal(ctx, found.get("id").and_then(Value::as_str).unwrap_or(reference)).await?;
    Ok(Some(domain::incidents::merge_incident_internal(&found, internal.as_ref())))
}

async fn find_public_incident(ctx: &Ctx<'_>, reference: &str) -> ApiResult<Option<Map<String, Value>>> {
    find_record(ctx, INCIDENTS, reference, &["incident_number", "incident_code", "incidentId", "id"]).await
}

async fn update_incident(ctx: &Ctx<'_>, reference: &str, patch: Map<String, Value>) -> ApiResult<Map<String, Value>> {
    let Some(found) = find_incident(ctx, reference).await? else {
        return Err(ApiError::not_found("incident_not_found", "incident_not_found"));
    };
    let current = incident_view(&found);
    let id = current.get("id").and_then(Value::as_str).unwrap_or(reference).to_string();
    let mut merged = current.clone();
    for (key, value) in patch {
        merged.insert(key, value);
    }
    merged.insert("id".into(), json!(id));
    merged.insert("source".into(), json!("synapsecity"));
    merged.insert("updated_at".into(), json!(crate::now_iso()));
    let published = domain::incidents::to_published_incident(&merged);
    let opts = ctx.opts();
    let updated = tier2::update(ctx.client(), &opts, INCIDENTS, &id, published, None).await?;
    write_incident_internal(ctx, &id, &merged).await?;
    let internal = domain::incidents::to_internal_incident(&merged);
    Ok(incident_view(&domain::incidents::merge_incident_internal(&updated, internal.as_ref())))
}

async fn incidents_list(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, INCIDENTS, 5000).await?;
    let filters = query_filters(ctx.query);
    let values: Vec<Value> = rows
        .items
        .into_iter()
        .map(|row| incident_view(&row))
        .filter(|row| matches_filters(row, &filters))
        .map(Value::Object)
        .collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn incidents_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let incident_id = web::string_field(&body, "incidentId").unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let number = web::string_field(&body, "incident_number")
        .or_else(|| web::string_field(&body, "incident_code"))
        .unwrap_or_else(incident_number);
    let photos_values: Vec<Value> = body
        .get("photos")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| body.get("file_ids").and_then(Value::as_array).cloned())
        .or_else(|| body.get("file_id").cloned().map(|value| vec![value]))
        .unwrap_or_default();
    let photos: Vec<Value> = if photos_values.is_empty() {
        Vec::new()
    } else {
        resolve_photos(ctx, &photos_values, true).await?.into_iter().map(|entry| json!(entry.get("url").and_then(Value::as_str).unwrap_or(""))).collect()
    };
    let now = crate::now_iso();
    let mut incident = Map::new();
    incident.insert("incidentId".into(), json!(incident_id));
    incident.insert("incident_number".into(), json!(number));
    incident.insert("incident_code".into(), json!(number));
    incident.insert("title".into(), json!(web::required_string(&body, "title")?));
    incident.insert("description".into(), json!(web::string_field(&body, "description").unwrap_or_default()));
    incident.insert("category".into(), json!(web::required_string(&body, "category")?));
    incident.insert("severity".into(), json!(web::string_field(&body, "severity").unwrap_or_else(|| "medium".into())));
    incident.insert("status".into(), json!(web::string_field(&body, "status").unwrap_or_else(|| "open".into())));
    incident.insert("occurredAt".into(), json!(web::string_field(&body, "occurredAt").unwrap_or_else(|| now.clone())));
    incident.insert("reported_at".into(), json!(now));
    incident.insert("created_at".into(), json!(now));
    incident.insert("updated_at".into(), json!(now));
    incident.insert("upvotes".into(), json!(0));
    incident.insert("comments".into(), json!([]));
    incident.insert("public_visible".into(), json!(web::bool_field(&body, "public_visible") != Some(false)));
    incident.insert("source".into(), json!("synapsecity"));
    incident.insert("sourceVersion".into(), json!("1.0.0"));
    for key in ["location", "asset_id", "reported_by", "reporter_type", "contact_info"] {
        if let Some(value) = body.get(key) {
            incident.insert(key.into(), value.clone());
        }
    }
    if let Some(asset_id) = body.get("assetId") {
        incident.entry("asset_id".to_string()).or_insert_with(|| asset_id.clone());
    }
    if !photos.is_empty() {
        incident.insert("photos".into(), Value::Array(photos));
    }
    let published = domain::incidents::to_published_incident(&incident);
    let opts = ctx.opts();
    let created = tier2::create(
        ctx.client(),
        &opts,
        INCIDENTS,
        published.clone(),
        Some(&incident_id),
    ).await?;
    write_incident_internal(ctx, &incident_id, &incident).await?;
    let internal = domain::incidents::to_internal_incident(&incident);
    Ok(web::created(Value::Object(incident_view(&domain::incidents::merge_incident_internal(&created, internal.as_ref())))))
}

async fn incidents_get(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(incident) = find_incident(ctx, id).await? else {
        return Err(ApiError::not_found("incident_not_found", "incident_not_found"));
    };
    Ok(web::json_response(Value::Object(incident_view(&incident))))
}

async fn incidents_patch(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let updated = update_incident(ctx, id, body).await?;
    Ok(web::json_response(Value::Object(updated)))
}

async fn incidents_action(ctx: &Ctx<'_>, id: &str, action: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let Some(existing) = find_incident(ctx, id).await? else {
        return Err(ApiError::not_found("incident_not_found", "incident_not_found"));
    };
    let now = crate::now_iso();
    match action {
        "acknowledge" => {
            let updated = update_incident(ctx, id, {
                let mut patch = Map::new();
                patch.insert("status".into(), json!("acknowledged"));
                patch.insert("acknowledged_at".into(), json!(now));
                patch
            }).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "assign" => {
            let assigned = web::string_field(&body, "assigned_to")
                .or_else(|| ctx.query.get("assigned_to").cloned())
                .unwrap_or_default();
            if assigned.is_empty() {
                return Err(ApiError::bad_request("assigned_to_required", "assigned_to_required"));
            }
            let mut patch = Map::new();
            patch.insert("assigned_to".into(), json!(assigned));
            patch.insert("status".into(), json!("assigned"));
            patch.insert("assigned_at".into(), json!(now));
            let updated = update_incident(ctx, id, patch).await?;
            let _ = push_notification(ctx, json!({
                "user_id": assigned,
                "type": "incident_assigned",
                "title": format!("Incident {} assigned to you", updated.get("incident_number").and_then(Value::as_str).unwrap_or(id)),
                "message": updated.get("title").cloned().unwrap_or(Value::Null),
                "severity": if updated.get("severity").and_then(Value::as_str) == Some("critical") { "critical" } else { "warning" },
                "entity_type": "incident",
                "entity_id": updated.get("id"),
                "dedupe_key": format!("incident_assigned:{}:{}", id, assigned),
            })).await;
            Ok(web::json_response(Value::Object(updated)))
        }
        "resolve" => {
            let notes = web::string_field(&body, "resolution_notes").or_else(|| ctx.query.get("resolution_notes").cloned()).unwrap_or_default();
            let kind = web::string_field(&body, "resolution_type").or_else(|| ctx.query.get("resolution_type").cloned()).unwrap_or_else(|| "fixed".into());
            let mut patch = Map::new();
            patch.insert("status".into(), json!("resolved"));
            patch.insert("resolution_notes".into(), json!(notes));
            patch.insert("resolution_type".into(), json!(kind));
            patch.insert("resolved_at".into(), json!(now));
            let updated = update_incident(ctx, id, patch).await?;
            if let Some(assignee) = updated.get("assigned_to").and_then(Value::as_str) {
                let _ = push_notification(ctx, json!({
                    "user_id": assignee,
                    "type": "incident_resolved",
                    "title": format!("Incident {} resolved", updated.get("incident_number").and_then(Value::as_str).unwrap_or(id)),
                    "message": notes,
                    "severity": "info",
                    "entity_type": "incident",
                    "entity_id": updated.get("id"),
                    "dedupe_key": format!("incident_resolved:{}:{}", id, assignee),
                })).await;
            }
            Ok(web::json_response(Value::Object(updated)))
        }
        "comments" => {
            let text = web::string_field(&body, "comment").unwrap_or_default();
            if text.is_empty() {
                return Err(ApiError::bad_request("comment_required", "comment_required"));
            }
            let mut comments = existing.get("comments").and_then(Value::as_array).cloned().unwrap_or_default();
            let principal = ctx.principal();
            comments.push(json!({
                "id": uuid::Uuid::new_v4().to_string(),
                "comment": text,
                "user_id": principal.map(|value| value.sub.clone()),
                "user_name": principal.map(|value| value.full_name.clone()).unwrap_or_else(|| "anonymous".into()),
                "is_internal": web::bool_field(&body, "is_internal") == Some(true),
                "posted_at": now,
                "created_at": now,
            }));
            let mut patch = Map::new();
            patch.insert("comments".into(), Value::Array(comments));
            let updated = update_incident(ctx, id, patch).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "upvote" => {
            let mut patch = Map::new();
            patch.insert("upvotes".into(), json!(existing.get("upvotes").and_then(Value::as_i64).unwrap_or(0) + 1));
            let updated = update_incident(ctx, id, patch).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "create-maintenance" => {
            let maintenance_id = uuid::Uuid::new_v4().to_string();
            let mut order = Map::new();
            order.insert("id".into(), json!(maintenance_id));
            order.insert("asset_id".into(), existing.get("asset_id").cloned().unwrap_or(Value::Null));
            order.insert("incident_id".into(), existing.get("id").cloned().unwrap_or(Value::Null));
            order.insert("title".into(), json!(format!("Incident {}: {}", existing.get("incident_number").and_then(Value::as_str).unwrap_or(id), existing.get("title").and_then(Value::as_str).unwrap_or(""))));
            order.insert("description".into(), existing.get("description").cloned().unwrap_or_else(|| json!("")));
            order.insert("status".into(), json!("scheduled"));
            order.insert("priority".into(), existing.get("severity").cloned().unwrap_or_else(|| json!("medium")));
            order.insert("type".into(), json!("corrective"));
            order.insert("scheduled_date".into(), json!(now));
            order.insert("created_at".into(), json!(now));
            order.insert("source".into(), json!("synapsecity"));
            if let Some(tech) = web::string_field(&body, "technician_id").or_else(|| ctx.query.get("technician_id").cloned()) {
                order.insert("assigned_to".into(), json!(tech));
                order.insert("technician".into(), json!(tech));
            }
            let opts = ctx.opts();
            tier2::create(ctx.client(), &opts, MAINTENANCE, order, Some(&maintenance_id)).await?;
            let mut patch = Map::new();
            patch.insert("maintenance_record_id".into(), json!(maintenance_id));
            patch.insert("status".into(), json!("in_progress"));
            let updated = update_incident(ctx, id, patch).await?;
            let _ = updated;
            Ok(web::created(json!({
                "incident_id": existing.get("id"),
                "maintenance_id": maintenance_id,
                "message": "maintenance_created",
            })))
        }
        "close" => {
            let notes = web::string_field(&body, "notes").or_else(|| ctx.query.get("notes").cloned()).unwrap_or_default();
            let mut patch = Map::new();
            patch.insert("status".into(), json!("closed"));
            patch.insert("closed_at".into(), json!(now));
            if !notes.is_empty() {
                patch.insert("resolution_notes".into(), json!(notes));
            }
            let updated = update_incident(ctx, id, patch).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "reject" => {
            let reason = web::string_field(&body, "reason").or_else(|| ctx.query.get("reason").cloned()).unwrap_or_default();
            let mut patch = Map::new();
            patch.insert("status".into(), json!("closed"));
            patch.insert("resolution_type".into(), json!("not_an_issue"));
            patch.insert("resolution_notes".into(), json!(reason));
            patch.insert("resolved_at".into(), json!(now));
            let updated = update_incident(ctx, id, patch).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "cost-approval" => {
            let actor = ctx.principal().map(|value| value.username.clone()).unwrap_or_else(|| "city-user".into());
            let approval = create_approval(
                ctx,
                format!("Incident cost approval: {}", existing.get("title").and_then(Value::as_str).unwrap_or(id)),
                "city.incident",
                "city.cost.approve",
                "incident",
                id,
                json!({ "cost": existing.get("cost"), "estimated_cost": existing.get("estimated_cost"), "severity": existing.get("severity") }),
                &actor,
            ).await?;
            Ok(web::accepted(json!({ "approval": approval, "hitl_required": true })))
        }
        "approve-cost" => {
            let approval_id = web::string_field(&body, "approval_id").or_else(|| web::string_field(&body, "approvalId")).unwrap_or_default();
            let actor = ctx.principal().map(|value| value.username.clone()).unwrap_or_else(|| "city-user".into());
            if ctx.config().hitl_required || !approval_id.is_empty() {
                if approval_id.is_empty() {
                    return Err(ApiError::new(StatusCode::PRECONDITION_REQUIRED, "approval_required", "create a cost approval first"));
                }
                assert_approved(ctx, &approval_id, id, "city.cost.approve", &actor).await?;
            }
            let mut patch = Map::new();
            patch.insert("cost_status".into(), json!("approved"));
            patch.insert("cost_approved_at".into(), json!(now));
            if !approval_id.is_empty() {
                patch.insert("cost_approval_id".into(), json!(approval_id));
                patch.insert("cost_approved_by".into(), json!(actor));
            }
            let updated = update_incident(ctx, id, patch).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "verify" => {
            let mut patch = Map::new();
            patch.insert("ai_verification_status".into(), json!("verified"));
            patch.insert("ai_confidence_score".into(), json!(1));
            patch.insert("ai_verification_reason".into(), json!("verified_by_city_operator"));
            patch.insert("ai_verified_at".into(), json!(now));
            let updated = update_incident(ctx, id, patch).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "check-duplicates" | "merge-suggestions" => Ok(web::json_response(json!([]))),
        "merge" => {
            let duplicate_ids: Vec<String> = body.get("duplicate_ids").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(|value| value.as_str().map(str::to_string)).collect();
            if duplicate_ids.is_empty() {
                return Err(ApiError::bad_request("duplicate_ids_required", "duplicate_ids_required"));
            }
            for duplicate_id in &duplicate_ids {
                if find_incident(ctx, duplicate_id).await?.is_some() {
                    let mut patch = Map::new();
                    patch.insert("status".into(), json!("closed"));
                    patch.insert("resolution_type".into(), json!("duplicate"));
                    patch.insert("merged_into".into(), existing.get("id").cloned().unwrap_or(Value::Null));
                    patch.insert("resolution_notes".into(), json!(web::string_field(&body, "merge_notes").unwrap_or_else(|| format!("Merged into {}", existing.get("incident_number").and_then(Value::as_str).unwrap_or(id)))));
                    let _ = update_incident(ctx, duplicate_id, patch).await;
                }
            }
            let mut merged: Vec<String> = existing.get("merged_reporter_ids").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(|value| value.as_str().map(str::to_string)).collect();
            merged.extend(duplicate_ids);
            merged.sort();
            merged.dedup();
            let mut patch = Map::new();
            patch.insert("merged_reporter_ids".into(), json!(merged));
            let updated = update_incident(ctx, id, patch).await?;
            Ok(web::json_response(Value::Object(updated)))
        }
        "related" => {
            let opts = ctx.opts();
            let rows = tier2::list_all(ctx.client(), &opts, INCIDENTS, 5000).await?;
            let asset_id = existing.get("asset_id").and_then(Value::as_str).unwrap_or("");
            let merged: Vec<String> = existing.get("merged_reporter_ids").and_then(Value::as_array).cloned().unwrap_or_default().into_iter().filter_map(|value| value.as_str().map(str::to_string)).collect();
            let related: Vec<Value> = rows.items.into_iter().map(|row| incident_view(&row)).filter(|row| {
                row.get("id").and_then(Value::as_str) != existing.get("id").and_then(Value::as_str)
                    && ((!asset_id.is_empty() && row.get("asset_id").and_then(Value::as_str) == Some(asset_id))
                        || merged.iter().any(|id| row.get("id").and_then(Value::as_str) == Some(id)))
            }).take(20).map(Value::Object).collect();
            Ok(web::json_response(json!(related)))
        }
        _ => Err(ApiError::not_found("not_found", "not_found")),
    }
}

// ---------------------------------------------------------------------------
// Preventive maintenance
// ---------------------------------------------------------------------------

async fn preventive_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let asset_id = web::string_field(&body, "asset_id").unwrap_or_default();
    if asset_id.is_empty() {
        return Err(ApiError::bad_request("asset_id_required", "asset_id_required"));
    }
    let Some(existing) = find_asset(ctx, &asset_id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let cycle = web::number_field(&body, "cycle_days").unwrap_or(180.0);
    let now = Utc::now();
    let plan = json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "asset_id": existing.get("id").cloned().unwrap_or(json!(asset_id)),
        "cycle_days": cycle,
        "cycle_description": web::string_field(&body, "cycle_description").unwrap_or_else(|| format!("Every {cycle} days")),
        "warning_days": web::number_field(&body, "warning_days").unwrap_or(7.0),
        "responsible_team": web::string_field(&body, "responsible_team").unwrap_or_default(),
        "last_maintenance_date": existing.get("lifecycle").and_then(|value| value.get("last_maintenance_date")).cloned().unwrap_or_else(|| json!(now.to_rfc3339())),
        "next_maintenance_date": (now + chrono::Duration::days(cycle as i64)).to_rfc3339(),
        "created_at": now.to_rfc3339(),
        "updated_at": now.to_rfc3339(),
    });
    let mut patch = Map::new();
    patch.insert("preventive_maintenance_plan".into(), plan.clone());
    update_asset(ctx, &asset_id, patch).await?;
    Ok(web::created(plan))
}

async fn preventive_update(ctx: &Ctx<'_>, plan_id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let assets = all_assets(ctx).await?;
    let Some(asset) = assets.into_iter().find(|asset| {
        asset.get("preventive_maintenance_plan").and_then(|value| value.get("id")).and_then(Value::as_str) == Some(plan_id)
    }) else {
        return Err(ApiError::not_found("preventive_plan_not_found", "preventive_plan_not_found"));
    };
    let mut plan = asset.get("preventive_maintenance_plan").and_then(Value::as_object).cloned().unwrap_or_default();
    for (key, value) in body {
        plan.insert(key, value);
    }
    plan.insert("id".into(), json!(plan_id));
    plan.insert("asset_id".into(), asset.get("id").cloned().unwrap_or(Value::Null));
    plan.insert("updated_at".into(), json!(crate::now_iso()));
    let mut patch = Map::new();
    patch.insert("preventive_maintenance_plan".into(), Value::Object(plan.clone()));
    update_asset(ctx, asset.get("id").and_then(Value::as_str).unwrap_or(""), patch).await?;
    Ok(web::json_response(Value::Object(plan)))
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

fn maintenance_scope(ctx: &Ctx<'_>, rows: Vec<Map<String, Value>>) -> Vec<Map<String, Value>> {
    let Some(principal) = ctx.principal() else {
        return Vec::new();
    };
    if [auth::ROLE_ADMIN, auth::ROLE_MANAGER, auth::ROLE_VOLUNTEER].contains(&principal.role.as_str()) {
        return rows;
    }
    let identities: HashSet<String> = [principal.sub.to_ascii_lowercase(), principal.username.to_ascii_lowercase()].into_iter().collect();
    rows.into_iter()
        .filter(|row| {
            let assigned = row.get("assigned_to").or_else(|| row.get("technician")).and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
            identities.contains(&assigned)
        })
        .collect()
}

async fn maintenance_upcoming(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let days = ctx.query.get("days").and_then(|value| value.parse::<i64>().ok()).unwrap_or(7).clamp(0, 30);
    let horizon = Utc::now().timestamp_millis() + days * 86_400_000;
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, MAINTENANCE, 5000).await?;
    let rows = maintenance_scope(ctx, rows.items);
    let values: Vec<Value> = rows.into_iter().filter(|row| {
        let status = row.get("status").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
        if ["completed", "cancelled", "closed"].contains(&status.as_str()) {
            return false;
        }
        let scheduled = row.get("scheduled_date").or_else(|| row.get("scheduledDate")).and_then(Value::as_str).and_then(compare_timestamp);
        scheduled.map(|value| value <= horizon).unwrap_or(true)
    }).map(Value::Object).collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn maintenance_asset(ctx: &Ctx<'_>, asset_id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, MAINTENANCE, 5000).await?;
    let values: Vec<Value> = maintenance_scope(ctx, rows.items)
        .into_iter()
        .filter(|row| row.get("asset_id").or_else(|| row.get("assetId")).and_then(Value::as_str) == Some(asset_id))
        .map(Value::Object)
        .collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn maintenance_approval(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let work_order = tier2::get(ctx.client(), &opts, MAINTENANCE, id).await?;
    let actor = ctx.principal().map(|value| value.username.clone()).unwrap_or_else(|| "city-user".into());
    let approval = create_approval(
        ctx,
        format!("Maintenance approval: {}", work_order.get("title").and_then(Value::as_str).unwrap_or(id)),
        "city.maintenance",
        "maintenance.approve",
        "maintenance",
        id,
        json!({ "priority": work_order.get("priority"), "cost": work_order.get("cost"), "asset_id": work_order.get("asset_id") }),
        &actor,
    ).await?;
    Ok(web::accepted(json!({ "approval": approval, "hitl_required": true })))
}

async fn maintenance_action(ctx: &Ctx<'_>, id: &str, action: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let now = crate::now_iso();
    let mut patch = body;
    match action {
        "assign" => {}
        "start" => {
            patch.insert("status".into(), json!("in_progress"));
        }
        "complete" => {
            patch.insert("status".into(), json!("completed"));
            patch.insert("completed_at".into(), json!(now));
        }
        "cancel" => {
            patch.insert("status".into(), json!("cancelled"));
        }
        "approve" => {
            let approval_id = web::string_field(&patch, "approval_id").or_else(|| web::string_field(&patch, "approvalId")).unwrap_or_default();
            let actor = ctx.principal().map(|value| value.username.clone()).unwrap_or_else(|| "city-user".into());
            if ctx.config().hitl_required || !approval_id.is_empty() {
                if approval_id.is_empty() {
                    return Err(ApiError::new(StatusCode::PRECONDITION_REQUIRED, "approval_required", "create a maintenance approval first"));
                }
                assert_approved(ctx, &approval_id, id, "maintenance.approve", &actor).await?;
                patch.insert("approval_id".into(), json!(approval_id));
                patch.insert("approved_by".into(), json!(actor));
            }
            patch.insert("approval_status".into(), json!("approved"));
        }
        "reject" => {
            patch.insert("approval_status".into(), json!("rejected"));
        }
        _ => return Err(ApiError::not_found("not_found", "not_found")),
    }
    let opts = ctx.opts();
    let version = tier2::requested_version(ctx.headers, Some(ctx.body))?;
    let updated = tier2::update(ctx.client(), &opts, MAINTENANCE, id, patch, version).await?;
    Ok(web::json_response(Value::Object(updated)))
}

async fn maintenance_photos(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let values: Vec<Value> = body
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| body.get("photos").and_then(Value::as_array).cloned())
        .or_else(|| body.get("file_id").cloned().map(|value| vec![value]))
        .unwrap_or_default();
    if values.is_empty() {
        return Err(ApiError::bad_request("photos_required", "photos_required"));
    }
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, MAINTENANCE, id).await?;
    let mut attachments = current.get("attachments").and_then(Value::as_array).cloned().unwrap_or_default();
    for value in values {
        let entry = if value.is_string() { json!({ "file_url": value }) } else { value };
        let attachment = attachment_from_body(ctx, entry.as_object().unwrap_or(&Map::new()), "photo", true).await?;
        attachments.push(Value::Object(attachment));
    }
    let mut patch = Map::new();
    patch.insert("attachments".into(), Value::Array(attachments));
    let updated = tier2::update(ctx.client(), &opts, MAINTENANCE, id, patch, None).await?;
    Ok(web::json_response(Value::Object(updated)))
}

// ---------------------------------------------------------------------------
// IoT
// ---------------------------------------------------------------------------

fn reading_value(row: &Map<String, Value>, metric: Option<&str>) -> Option<f64> {
    if let Some(metric) = metric {
        let readings = row.get("readings").and_then(Value::as_object);
        let measurements = row.get("measurements").and_then(Value::as_object);
        return row.get(metric).and_then(Value::as_f64)
            .or_else(|| readings.and_then(|value| value.get(metric)).and_then(Value::as_f64))
            .or_else(|| measurements.and_then(|value| value.get(metric)).and_then(Value::as_f64));
    }
    for key in ["value", "reading", "measurement"] {
        if let Some(value) = row.get(key).and_then(Value::as_f64) {
            return Some(value);
        }
    }
    row.get("readings").and_then(Value::as_object).and_then(|readings| readings.values().find_map(Value::as_f64))
}

fn sensor_status(sensor: &Map<String, Value>, latest: Option<&Map<String, Value>>) -> String {
    let declared = sensor.get("status").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    if ["inactive", "decommissioned", "maintenance"].contains(&declared.as_str()) {
        return declared;
    }
    let last_seen = latest
        .and_then(|row| row.get("timestamp"))
        .and_then(Value::as_str)
        .or_else(|| sensor.get("last_seen").and_then(Value::as_str))
        .and_then(compare_timestamp);
    let Some(last_seen) = last_seen else {
        return "unknown".into();
    };
    let offline_after = std::env::var("IOT_OFFLINE_THRESHOLD_MINUTES")
        .ok()
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(15)
        .max(1);
    if Utc::now().timestamp_millis() - last_seen <= offline_after * 60_000 {
        "online".into()
    } else {
        "offline".into()
    }
}

async fn iot_sensor_delete(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let mut patch = Map::new();
    patch.insert("status".into(), json!("inactive"));
    patch.insert("deleted_at".into(), json!(crate::now_iso()));
    let opts = ctx.opts();
    tier2::update(ctx.client(), &opts, tier2::SENSORS, id, patch, None).await?;
    Ok(web::no_content())
}

async fn iot_readings(ctx: &Ctx<'_>, sensor_id: &str, alias: bool) -> ApiResult<Response> {
    let hours = ctx.query.get("hours").and_then(|value| value.parse::<i64>().ok()).unwrap_or(24).clamp(0, 24 * 365);
    let limit = ctx.query.get("limit").and_then(|value| value.parse::<i64>().ok()).unwrap_or(100).clamp(1, 500);
    let offset = ctx.query.get("offset").or_else(|| ctx.query.get("skip")).and_then(|value| value.parse::<i64>().ok()).unwrap_or(0).max(0);
    let since = (Utc::now() - chrono::Duration::hours(hours)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let opts = ctx.opts();
    let filter = json!({ "sensor_id": sensor_id, "timestamp": { "gte": since } });
    let (items, total) = tier2::query_records(ctx.client(), &opts, tier2::SENSOR_DATA, filter, limit, offset, Some("timestamp:desc".into())).await?;
    let values = values_from_rows(items);
    let mut response = if alias {
        web::json_response(json!({ "readings": values, "total": total, "sensor_id": sensor_id }))
    } else {
        web::json_response(Value::Array(values))
    };
    response.headers_mut().insert(
        "x-total-count",
        HeaderValue::from_str(&total.to_string()).unwrap_or(HeaderValue::from_static("0")),
    );
    Ok(response)
}

async fn iot_write(ctx: &Ctx<'_>, sensor_id: &str) -> ApiResult<Response> {
    let mut body = web::private_input(ctx.body);
    body.insert("sensor_id".into(), json!(sensor_id));
    let opts = ctx.opts();
    let row = tier2::create(ctx.client(), &opts, tier2::SENSOR_DATA, body, None).await?;
    Ok(web::created(Value::Object(row)))
}

async fn iot_batch(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let values: Vec<Value> = ctx.body.get("readings").and_then(Value::as_array).cloned().unwrap_or_default();
    let opts = ctx.opts();
    let mut created = Vec::new();
    for row in values {
        if let Some(map) = row.as_object() {
            created.push(Value::Object(tier2::create(ctx.client(), &opts, tier2::SENSOR_DATA, map.clone(), None).await?));
        }
    }
    Ok(web::created(Value::Array(created)))
}

async fn iot_status(ctx: &Ctx<'_>, sensor_id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let sensor = tier2::get(ctx.client(), &opts, tier2::SENSORS, sensor_id).await?;
    let (items, _) = tier2::query_records(ctx.client(), &opts, tier2::SENSOR_DATA, json!({ "sensor_id": sensor_id }), 1, 0, Some("timestamp:desc".into())).await?;
    let latest = items.first();
    let mut view = sensor;
    view.insert("status".into(), json!(sensor_status(&view, latest)));
    view.insert("last_reading_at".into(), latest.and_then(|row| row.get("timestamp")).cloned().unwrap_or(Value::Null));
    Ok(web::json_response(Value::Object(view)))
}

async fn iot_statistics(ctx: &Ctx<'_>, sensor_id: &str) -> ApiResult<Response> {
    let metric = ctx.query.get("metric").map(String::as_str);
    let hours = ctx.query.get("hours").and_then(|value| value.parse::<i64>().ok()).unwrap_or(24).clamp(0, 24 * 365);
    let since = (Utc::now() - chrono::Duration::hours(hours)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let opts = ctx.opts();
    let filter = json!({ "sensor_id": sensor_id, "timestamp": { "gte": since } });
    let (readings, _) = tier2::query_records(ctx.client(), &opts, tier2::SENSOR_DATA, filter, 1000, 0, Some("timestamp:desc".into())).await?;
    let values: Vec<f64> = readings.iter().filter_map(|row| reading_value(row, metric)).collect();
    let sensor = tier2::get(ctx.client(), &opts, tier2::SENSORS, sensor_id).await?;
    let sum: f64 = values.iter().sum();
    Ok(web::json_response(json!({
        "sensor_id": sensor_id,
        "metric": metric.unwrap_or("value"),
        "count": values.len(),
        "min": values.iter().copied().reduce(f64::min),
        "max": values.iter().copied().reduce(f64::max),
        "average": (!values.is_empty()).then(|| (sum / values.len() as f64 * 1000.0).round() / 1000.0),
        "latest": readings.first().map(|row| json!({
            "timestamp": row.get("timestamp").or_else(|| row.get("created_at")),
            "value": reading_value(row, metric),
        })),
        "unit": sensor.get("measurement_unit").or_else(|| sensor.get("unit")).and_then(Value::as_str).unwrap_or(""),
        "window_hours": hours,
    })))
}

async fn iot_asset(ctx: &Ctx<'_>, asset_id: &str) -> ApiResult<Response> {
    let hours = ctx.query.get("hours").and_then(|value| value.parse::<i64>().ok()).unwrap_or(24).clamp(0, 24 * 365);
    let opts = ctx.opts();
    let (sensors, _) = tier2::query_records(ctx.client(), &opts, tier2::SENSORS, json!({ "asset_id": asset_id }), 500, 0, None).await?;
    let sensor_ids: Vec<String> = sensors.iter().filter_map(|sensor| sensor.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let since = (Utc::now() - chrono::Duration::hours(hours)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut readings = Vec::new();
    let mut total_readings = 0;
    if !sensor_ids.is_empty() {
        let filter = json!({ "sensor_id": { "in": sensor_ids }, "timestamp": { "gte": since } });
        let (items, total) = tier2::query_records(ctx.client(), &opts, tier2::SENSOR_DATA, filter, 500, 0, Some("timestamp:desc".into())).await?;
        readings = items;
        total_readings = total;
    }
    let (alerts, _) = tier2::query_records(ctx.client(), &opts, tier2::ALERTS, json!({ "asset_id": asset_id }), 500, 0, None).await?;
    let active_alerts: Vec<Map<String, Value>> = alerts.into_iter().filter(|alert| {
        !["resolved", "dismissed", "closed"].contains(&alert.get("status").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase().as_str())
    }).collect();
    let active_alert_count = active_alerts.len();
    let sensors_view: Vec<Value> = sensors.iter().map(|sensor| {
        let latest = readings.iter().find(|reading| reading.get("sensor_id").and_then(Value::as_str) == sensor.get("id").and_then(Value::as_str));
        let mut view = sensor.clone();
        view.insert("status".into(), json!(sensor_status(sensor, latest)));
        Value::Object(view)
    }).collect();
    Ok(web::json_response(json!({
        "asset_id": asset_id,
        "asset": {
            "id": asset_id,
            "feature_type": sensors.first().and_then(|sensor| sensor.get("feature_type")).cloned().unwrap_or_else(|| json!("infrastructure")),
            "feature_code": sensors.first().and_then(|sensor| sensor.get("feature_code")).cloned().unwrap_or_else(|| json!(asset_id)),
        },
        "sensors": sensors_view,
        "readings": values_from_rows(readings),
        "alerts": values_from_rows(active_alerts),
        "summary": {
            "total_sensors": sensors.len(),
            "total_readings": total_readings,
            "active_alerts": active_alert_count,
            "offline_sensors": sensors_view.iter().filter(|sensor| sensor.get("status").and_then(Value::as_str) == Some("offline")).count(),
        },
        "window_hours": hours,
    })))
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

async fn alerts_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let body = web::private_input(ctx.body);
    let created = tier2::create(ctx.client(), &opts, tier2::ALERTS, body, None).await?;
    let severity = created.get("severity").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    if ["critical", "high"].contains(&severity.as_str()) {
        let _ = notify_operators(
            ctx,
            "alert_raised",
            format!("Alert: {}", created.get("title").and_then(Value::as_str).unwrap_or("")),
            created.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
            if severity == "critical" { "critical" } else { "warning" },
            "alert",
            created.get("id").and_then(Value::as_str).unwrap_or(""),
        ).await;
    }
    Ok(web::created(Value::Object(created)))
}

async fn alerts_ack(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, tier2::ALERTS, id).await?;
    let mut patch = Map::new();
    patch.insert("status".into(), json!("acknowledged"));
    patch.insert("acknowledged_at".into(), json!(crate::now_iso()));
    let mut updated = tier2::update(ctx.client(), &opts, tier2::ALERTS, id, patch, None).await?;
    let mut alert = current;
    for (key, value) in &updated {
        alert.insert(key.clone(), value.clone());
    }
    if domain::alerts::should_create_maintenance(&alert) {
        let maintenance_id = format!("alert-{}", id);
        let existing = tier2::list_all(ctx.client(), &opts, MAINTENANCE, 5000).await?
            .items
            .into_iter()
            .find(|row| row.get("source_alert_id").and_then(Value::as_str) == Some(id));
        if existing.is_none() {
            let order = domain::alerts::maintenance_from_alert(&alert, None);
            let _ = tier2::create(ctx.client(), &opts, MAINTENANCE, order, Some(&maintenance_id)).await;
        }
        let mut patch = Map::new();
        patch.insert("maintenance_id".into(), json!(maintenance_id));
        patch.insert("maintenance_created_at".into(), json!(crate::now_iso()));
        updated = tier2::update(ctx.client(), &opts, tier2::ALERTS, id, patch, None).await?;
    }
    Ok(web::json_response(Value::Object(updated)))
}

async fn alerts_action(ctx: &Ctx<'_>, id: &str, action: &str) -> ApiResult<Response> {
    if !["resolve", "dismiss"].contains(&action) {
        return Err(ApiError::not_found("not_found", "not_found"));
    }
    let opts = ctx.opts();
    let mut patch = web::private_input(ctx.body);
    patch.insert("status".into(), json!(if action == "resolve" { "resolved" } else { "dismissed" }));
    patch.insert(format!("{action}d_at"), json!(crate::now_iso()));
    let updated = tier2::update(ctx.client(), &opts, tier2::ALERTS, id, patch, None).await?;
    Ok(web::json_response(Value::Object(updated)))
}

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

async fn budget_action(ctx: &Ctx<'_>, id: &str, action: &str) -> ApiResult<Response> {
    if !["submit", "approve"].contains(&action) {
        return Err(ApiError::not_found("not_found", "not_found"));
    }
    let opts = ctx.opts();
    let mut patch = Map::new();
    patch.insert(
        "status".into(),
        json!(if action == "submit" { "submitted" } else { "approved" }),
    );
    let updated = tier2::update(ctx.client(), &opts, tier2::BUDGETS, id, patch, None).await?;
    Ok(web::json_response(Value::Object(updated)))
}

async fn budget_transactions(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, tier2::TRANSACTIONS, 5000).await?;
    let values: Vec<Value> = rows.items.into_iter()
        .filter(|row| row.get("budget_id").and_then(Value::as_str) == Some(id))
        .map(Value::Object)
        .collect();
    Ok(web::json_response(Value::Array(values)))
}

async fn budget_transaction_create(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let mut body = web::private_input(ctx.body);
    body.insert("budget_id".into(), json!(id));
    let opts = ctx.opts();
    let row = tier2::create(ctx.client(), &opts, tier2::TRANSACTIONS, body, None).await?;
    Ok(web::created(Value::Object(row)))
}

async fn budget_transaction_approval(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let transaction = tier2::get(ctx.client(), &opts, tier2::TRANSACTIONS, id).await?;
    let actor = ctx.principal().map(|value| value.username.clone()).unwrap_or_else(|| "city-user".into());
    let approval = create_approval(
        ctx,
        format!("Budget transaction approval: {}", transaction.get("description").and_then(Value::as_str).unwrap_or(id)),
        "city.budget",
        "budget.transaction.approve",
        "budget_transaction",
        id,
        json!({ "amount": transaction.get("amount"), "budget_id": transaction.get("budget_id") }),
        &actor,
    ).await?;
    Ok(web::accepted(json!({ "approval": approval, "hitl_required": true })))
}

async fn budget_transaction_approve(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let approval_id = web::string_field(&body, "approval_id").or_else(|| web::string_field(&body, "approvalId")).unwrap_or_default();
    let actor = ctx.principal().map(|value| value.username.clone()).unwrap_or_else(|| "city-user".into());
    let mut patch = Map::new();
    if ctx.config().hitl_required || !approval_id.is_empty() {
        if approval_id.is_empty() {
            return Err(ApiError::new(StatusCode::PRECONDITION_REQUIRED, "approval_required", "create a transaction approval first"));
        }
        let approval = assert_approved(ctx, &approval_id, id, "budget.transaction.approve", &actor).await?;
        patch.insert("approval_id".into(), json!(approval_id));
        patch.insert("approved_by".into(), json!(actor));
        patch.insert("approval_roles".into(), approval.get("approverRoles").cloned().unwrap_or(Value::Null));
    }
    patch.insert("status".into(), json!("approved"));
    patch.insert("approved_at".into(), json!(crate::now_iso()));
    let opts = ctx.opts();
    let updated = tier2::update(ctx.client(), &opts, tier2::TRANSACTIONS, id, patch, None).await?;
    Ok(web::json_response(Value::Object(updated)))
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

fn report_error(error: domain::reports::ReportError) -> ApiError {
    let status = error.status();
    ApiError::new(
        StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
        error.message(),
        error.message(),
    )
}

async fn load_report_context(ctx: &Ctx<'_>, asset_id: Option<&str>) -> ApiResult<(domain::reports::ReportContext, Option<Map<String, Value>>)> {
    let opts = ctx.opts();
    let assets = all_assets(ctx).await?;
    let incidents = tier2::list_all(ctx.client(), &opts, INCIDENTS, 5000).await?
        .items
        .into_iter()
        .map(|row| incident_view(&row))
        .collect();
    let maintenance = tier2::list_all(ctx.client(), &opts, MAINTENANCE, 5000).await?.items;
    let asset = asset_id.and_then(|id| {
        assets.iter().find(|asset| {
            asset.get("id").and_then(Value::as_str) == Some(id)
                || asset.get("asset_code").and_then(Value::as_str) == Some(id)
        }).cloned()
    });
    Ok((
        domain::reports::ReportContext {
            asset: asset.clone(),
            assets,
            incidents,
            maintenance,
        },
        asset,
    ))
}

async fn create_report(ctx: &Ctx<'_>, body: Map<String, Value>, asset_id: Option<&str>) -> ApiResult<Map<String, Value>> {
    let report_type = domain::reports::normalize_report_type(body.get("report_type").or_else(|| body.get("type"))).map_err(report_error)?;
    let format = domain::reports::normalize_report_format(body.get("format")).map_err(report_error)?;
    let mut filters = body.get("filters").and_then(Value::as_object).cloned().unwrap_or_default();
    if let Some(asset_id) = asset_id {
        filters.insert("asset_id".into(), json!(asset_id));
    }
    let (context, asset) = load_report_context(ctx, asset_id).await?;
    if asset_id.is_some() && asset.is_none() {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    }
    let artifact = domain::reports::generate_report(report_type, format, &context, &filters);
    let id = body.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let now = crate::now_iso();
    let mut record = Map::new();
    record.insert("id".into(), json!(id));
    record.insert("report_code".into(), json!(body.get("report_code").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("RPT-{}", &id[..id.len().min(8)].to_ascii_uppercase()))));
    if let Some(asset) = &asset {
        record.insert("asset_id".into(), asset.get("id").cloned().unwrap_or(Value::Null));
        record.insert("asset_code".into(), asset.get("asset_code").cloned().unwrap_or(Value::Null));
    }
    record.insert("report_type".into(), json!(report_type.as_str()));
    record.insert("type".into(), json!(report_type.as_str()));
    record.insert("format".into(), json!(format.as_str()));
    record.insert("filters".into(), Value::Object(filters.clone()));
    record.insert("parameters".into(), Value::Object(filters));
    record.insert("status".into(), json!("completed"));
    record.insert("generated_at".into(), json!(now));
    record.insert("created_at".into(), json!(now));
    record.insert("completed_at".into(), json!(now));
    record.insert("content_type".into(), json!(artifact.content_type));
    record.insert("content_sha256".into(), json!(artifact.sha256));
    record.insert("row_count".into(), json!(artifact.row_count));
    record.insert("content".into(), json!(artifact.content));
    let url = format!("{}/v1/reports/{}/download", ctx.config().public_url, id);
    record.insert("download_url".into(), json!(url));
    record.insert("file_url".into(), json!(url));
    record.insert("source".into(), json!("synapsecity"));
    let opts = ctx.opts();
    let created = match tier2::create(ctx.client(), &opts, REPORTS, record.clone(), Some(&id)).await {
        Ok(row) => row,
        Err(error) if error.status == StatusCode::CONFLICT || error.status == StatusCode::BAD_REQUEST => {
            tier2::update(ctx.client(), &opts, REPORTS, &id, record, None).await?
        }
        Err(error) => return Err(error),
    };
    if let Some(principal) = ctx.principal() {
        let _ = push_notification(ctx, json!({
            "user_id": principal.sub,
            "type": "report_ready",
            "title": format!("Report {} is ready", created.get("report_code").and_then(Value::as_str).unwrap_or("")),
            "message": format!("{} row(s) in {} format", artifact.row_count, format.as_str().to_ascii_uppercase()),
            "severity": "info",
            "link": "/admin/reports",
            "entity_type": "report",
            "entity_id": id,
            "dedupe_key": format!("report_ready:{}:{}", id, principal.sub),
        })).await;
    }
    Ok(created)
}

async fn reports_list(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, REPORTS, 5000).await?;
    let filters = query_filters(ctx.query);
    let values: Vec<Value> = rows.items.into_iter()
        .filter(|row| matches_filters(row, &filters))
        .map(|mut row| {
            row.remove("content");
            Value::Object(row)
        })
        .collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn reports_create(ctx: &Ctx<'_>, asset_id: Option<&str>) -> ApiResult<Response> {
    let report = create_report(ctx, web::private_input(ctx.body), asset_id).await?;
    Ok(web::created(Value::Object(report)))
}

async fn reports_get(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let mut row = tier2::get(ctx.client(), &opts, REPORTS, id).await?;
    let content = row.remove("content");
    let _ = content;
    Ok(web::json_response(Value::Object(row)))
}

async fn reports_generate(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, REPORTS, id).await?;
    let mut body = Map::new();
    body.insert("report_type".into(), current.get("report_type").cloned().unwrap_or(Value::Null));
    body.insert("format".into(), current.get("format").cloned().unwrap_or(Value::Null));
    body.insert("filters".into(), current.get("filters").cloned().unwrap_or_else(|| json!({})));
    body.insert("id".into(), json!(id));
    body.insert("report_code".into(), current.get("report_code").cloned().unwrap_or(Value::Null));
    body.insert("asset_id".into(), current.get("asset_id").cloned().unwrap_or(Value::Null));
    let report = create_report(ctx, body, current.get("asset_id").and_then(Value::as_str)).await?;
    Ok(web::json_response(Value::Object(report)))
}

async fn reports_download(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let report = tier2::get(ctx.client(), &opts, REPORTS, id).await?;
    if report.get("status").and_then(Value::as_str) != Some("completed") || report.get("content").and_then(Value::as_str).is_none() {
        return Err(ApiError::conflict("report_not_generated", "POST /v1/reports/:id/generate first."));
    }
    let format = report.get("format").and_then(Value::as_str).unwrap_or("csv");
    let filename = format!(
        "{}.{}",
        report.get("report_code").and_then(Value::as_str).unwrap_or(id).replace(|ch: char| !ch.is_ascii_alphanumeric() && !matches!(ch, '.' | '_' | '-'), "_"),
        if format == "json" { "json" } else { "csv" }
    );
    let content = report.get("content").and_then(Value::as_str).unwrap_or("").to_string();
    let mut response = web::text_response(
        report.get("content_type").and_then(Value::as_str).unwrap_or(if format == "json" { "application/json; charset=utf-8" } else { "text/csv; charset=utf-8" }),
        content,
    );
    if let Ok(value) = HeaderValue::from_str(&format!("attachment; filename=\"{filename}\"")) {
        response.headers_mut().insert("content-disposition", value);
    }
    if let Some(checksum) = report.get("content_sha256").and_then(Value::as_str) {
        if let Ok(value) = HeaderValue::from_str(checksum) {
            response.headers_mut().insert("x-content-sha256", value);
        }
    }
    Ok(response)
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

fn notification_type(value: &str) -> domain::notifications::NotificationType {
    serde_json::from_value(json!(value)).unwrap_or(domain::notifications::NotificationType::System)
}

fn notification_severity(value: Option<&str>) -> domain::notifications::NotificationSeverity {
    match value.unwrap_or("info") {
        "warning" => domain::notifications::NotificationSeverity::Warning,
        "critical" => domain::notifications::NotificationSeverity::Critical,
        _ => domain::notifications::NotificationSeverity::Info,
    }
}

async fn push_notification(ctx: &Ctx<'_>, input: Value) -> ApiResult<Option<Map<String, Value>>> {
    let object = input.as_object().cloned().unwrap_or_default();
    let dedupe = object.get("dedupe_key").and_then(Value::as_str).map(str::to_string);
    let opts = ctx.opts();
    if let Some(dedupe) = &dedupe {
        let rows = tier2::list_all(ctx.client(), &opts, NOTIFICATIONS, 2000).await?;
        if rows.items.iter().any(|row| row.get("dedupe_key").and_then(Value::as_str) == Some(dedupe)) {
            return Ok(None);
        }
    }
    let notification_input = domain::notifications::NotificationInput {
        user_id: object.get("user_id").and_then(Value::as_str).unwrap_or("").to_string(),
        notification_type: notification_type(object.get("type").and_then(Value::as_str).unwrap_or("system")),
        title: object.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
        message: object.get("message").and_then(Value::as_str).unwrap_or("").to_string(),
        severity: Some(notification_severity(object.get("severity").and_then(Value::as_str))),
        link: object.get("link").and_then(Value::as_str).map(str::to_string),
        entity_type: object.get("entity_type").and_then(Value::as_str).map(str::to_string),
        entity_id: object.get("entity_id").and_then(Value::as_str).map(str::to_string),
        dedupe_key: dedupe.clone(),
        metadata: object.get("metadata").and_then(Value::as_object).cloned(),
        recipient: None,
    };
    let record = domain::notifications::build_notification(&notification_input, None, None)
        .map_err(|error| ApiError::bad_request(error.code(), error.code()))?;
    let id = record.get("id").and_then(Value::as_str).unwrap_or("").to_string();
    let created = tier2::create(ctx.client(), &opts, NOTIFICATIONS, record, Some(&id)).await?;
    Ok(Some(created))
}

async fn notify_operators(
    ctx: &Ctx<'_>,
    notification_type_value: &str,
    title: String,
    message: String,
    severity: &str,
    entity_type: &str,
    entity_id: &str,
) -> ApiResult<()> {
    let opts = ctx.opts();
    let users = tier2::list_all(ctx.client(), &opts, USERS, 1000).await?;
    for user in users.items {
        if !["admin", "manager"].contains(&user.get("role").and_then(Value::as_str).unwrap_or("")) {
            continue;
        }
        let user_id = user.get("id").or_else(|| user.get("username")).and_then(Value::as_str).unwrap_or("");
        if user_id.is_empty() {
            continue;
        }
        let _ = push_notification(ctx, json!({
            "user_id": user_id,
            "type": notification_type_value,
            "title": title,
            "message": message,
            "severity": severity,
            "link": format!("/admin/alerts/{entity_id}"),
            "entity_type": entity_type,
            "entity_id": entity_id,
            "dedupe_key": format!("{notification_type_value}:{entity_id}:{user_id}"),
        })).await;
    }
    Ok(())
}

fn is_own_notification(row: &Map<String, Value>, principal: &SessionPrincipal) -> bool {
    let identities = [principal.sub.to_ascii_lowercase(), principal.username.to_ascii_lowercase()];
    row.get("user_id")
        .and_then(Value::as_str)
        .map(|value| identities.contains(&value.to_ascii_lowercase()))
        .unwrap_or(false)
}

async fn notifications_list(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let all = ctx.query.get("all").map(|value| value == "true").unwrap_or(false) && principal.role == auth::ROLE_ADMIN;
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, NOTIFICATIONS, 5000).await?;
    let mut values: Vec<Value> = rows.items.into_iter()
        .filter(|row| all || is_own_notification(row, principal))
        .filter(|row| ctx.query.get("unread_only").map(|value| value != "true").unwrap_or(true) || (row.get("read").and_then(Value::as_bool) != Some(true) && row.get("read_at").is_none()))
        .collect::<Vec<_>>()
        .into_iter()
        .map(Value::Object)
        .collect();
    values.sort_by(|left, right| {
        let left = left.get("created_at").and_then(Value::as_str).unwrap_or("");
        let right = right.get("created_at").and_then(Value::as_str).unwrap_or("");
        right.cmp(left)
    });
    Ok(web::send_page(values, ctx.query, 100))
}

async fn notifications_unread(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let all = ctx.query.get("all").map(|value| value == "true").unwrap_or(false) && principal.role == auth::ROLE_ADMIN;
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, NOTIFICATIONS, 5000).await?;
    let unread = rows.items.iter()
        .filter(|row| all || is_own_notification(row, principal))
        .filter(|row| row.get("read").and_then(Value::as_bool) != Some(true) && row.get("read_at").is_none())
        .count();
    Ok(web::json_response(json!({ "unread_count": unread })))
}

async fn notifications_preferences_get(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let recipient = domain::notifications::preference_recipient(&principal.sub);
    let opts = ctx.opts();
    let preference = ctx.client().notifications().get_preference(&recipient, &opts).await.map_err(ApiError::from)?;
    let mut value = preference;
    if let Some(object) = value.as_object_mut() {
        object.insert("recipient".into(), json!(recipient));
    }
    Ok(web::json_response(value))
}

async fn notifications_preferences_put(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let recipient = domain::notifications::preference_recipient(&principal.sub);
    let body = web::private_input(ctx.body);
    let channels: Option<Vec<String>> = body.get("channels").and_then(Value::as_array).map(|values| {
        values.iter().filter_map(Value::as_str)
            .filter(|value| ["email", "sms", "push", "webhook", "log"].contains(value))
            .map(str::to_string).collect()
    });
    let unsubscribed = web::bool_field(&body, "unsubscribed");
    let opts = ctx.opts();
    let preference = ctx.client().notifications().set_preference(&recipient, channels, unsubscribed, &opts).await.map_err(ApiError::from)?;
    let mut value = preference;
    if let Some(object) = value.as_object_mut() {
        object.insert("recipient".into(), json!(recipient));
    }
    Ok(web::json_response(value))
}

async fn notifications_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let created = push_notification(ctx, Value::Object(body)).await?;
    match created {
        Some(created) => Ok(web::created(Value::Object(created))),
        None => Err(ApiError::conflict("notification_duplicate", "A notification with this dedupe_key already exists.")),
    }
}

async fn notifications_delivery(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, NOTIFICATIONS, id).await?;
    if !is_own_notification(&current, principal) && principal.role != auth::ROLE_ADMIN {
        return Err(ApiError::not_found("notification_not_found", "notification_not_found"));
    }
    let delivery = current.get("delivery").cloned().unwrap_or_else(|| json!({}));
    let mut channels = delivery.as_object().cloned().unwrap_or_default();
    for (channel, receipt) in channels.clone() {
        if let Some(notification_id) = receipt.get("notification_id").and_then(Value::as_str) {
            if let Ok(status) = ctx.client().notifications().get(notification_id, &opts).await {
                let mut merged = receipt;
                for key in ["status", "attempts", "error", "deadReason"] {
                    if let Some(value) = status.get(key) {
                        merged[key] = value.clone();
                    }
                }
                channels.insert(channel, merged);
            }
        }
    }
    Ok(web::json_response(json!({ "notification_id": id, "delivery": channels })))
}

async fn notifications_read(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, NOTIFICATIONS, id).await?;
    if !is_own_notification(&current, principal) && principal.role != auth::ROLE_ADMIN {
        return Err(ApiError::not_found("notification_not_found", "notification_not_found"));
    }
    let mut patch = Map::new();
    patch.insert("read".into(), json!(true));
    patch.insert("read_at".into(), json!(crate::now_iso()));
    let updated = tier2::update(ctx.client(), &opts, NOTIFICATIONS, id, patch, None).await?;
    Ok(web::json_response(Value::Object(updated)))
}

async fn notifications_mark_all(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let all = ctx.query.get("all").map(|value| value == "true").unwrap_or(false) && principal.role == auth::ROLE_ADMIN;
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, NOTIFICATIONS, 5000).await?;
    let mut updated = 0;
    for row in rows.items {
        if !(all || is_own_notification(&row, principal)) {
            continue;
        }
        if row.get("read").and_then(Value::as_bool) == Some(true) || row.get("read_at").is_some() {
            continue;
        }
        let id = row.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let mut patch = Map::new();
        patch.insert("read".into(), json!(true));
        patch.insert("read_at".into(), json!(crate::now_iso()));
        let _ = tier2::update(ctx.client(), &opts, NOTIFICATIONS, &id, patch, None).await;
        updated += 1;
    }
    Ok(web::json_response(json!({ "message": "all_notifications_marked_read", "updated": updated })))
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

async fn users_me(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let opts = ctx.opts();
    let profile = tier2::get(ctx.client(), &opts, USERS, &principal.sub).await.ok();
    let mut view = auth::user_json(&auth::user_from_principal(principal));
    if let Some(profile) = profile {
        if let Some(object) = view.as_object_mut() {
            for (key, value) in auth::sanitize_user(&profile) {
                object.insert(key, value);
            }
            object.insert("id".into(), json!(principal.sub));
            object.insert("role".into(), json!(principal.role));
            object.insert("permissions".into(), json!(principal.permissions));
        }
    }
    Ok(web::json_response(view))
}

async fn users_me_update(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let Some(principal) = ctx.principal() else {
        return Err(ApiError::unauthorized("authentication_required"));
    };
    let body = web::private_input(ctx.body);
    if auth::contains_password(&body) {
        return Err(ApiError::bad_request("password_is_managed_by_auth_shell", "password_is_managed_by_auth_shell"));
    }
    let mut patch = Map::new();
    patch.insert("id".into(), json!(principal.sub));
    patch.insert("username".into(), json!(principal.username));
    patch.insert("email".into(), json!(web::string_field(&body, "email").unwrap_or_else(|| principal.email.clone())));
    patch.insert("full_name".into(), json!(web::string_field(&body, "full_name").unwrap_or_else(|| principal.full_name.clone())));
    if let Some(phone) = web::string_field(&body, "phone") {
        patch.insert("phone".into(), json!(phone));
    }
    patch.insert("role".into(), json!(principal.role));
    patch.insert("status".into(), json!("active"));
    patch.insert("updated_at".into(), json!(crate::now_iso()));
    let opts = ctx.opts();
    let updated = match tier2::create(ctx.client(), &opts, USERS, patch.clone(), Some(&principal.sub)).await {
        Ok(row) => row,
        Err(error) if error.status == StatusCode::CONFLICT || error.status == StatusCode::BAD_REQUEST => {
            tier2::update(ctx.client(), &opts, USERS, &principal.sub, patch, None).await?
        }
        Err(error) => return Err(error),
    };
    let mut view = auth::user_json(&auth::user_from_principal(principal));
    if let Some(object) = view.as_object_mut() {
        for (key, value) in auth::sanitize_user(&updated) {
            object.insert(key, value);
        }
        object.insert("id".into(), json!(principal.sub));
        object.insert("role".into(), json!(principal.role));
        object.insert("permissions".into(), json!(principal.permissions));
    }
    Ok(web::json_response(view))
}

async fn users_by_role(ctx: &Ctx<'_>, role: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, USERS, 5000).await?;
    let values: Vec<Value> = rows.items.into_iter()
        .filter(|row| row.get("role").and_then(Value::as_str) == Some(role))
        .map(|row| Value::Object(auth::sanitize_user(&row)))
        .collect();
    Ok(web::json_response(Value::Array(values)))
}

async fn users_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    if auth::contains_password(&body) {
        return Err(ApiError::bad_request("password_is_managed_by_auth_shell", "password_is_managed_by_auth_shell"));
    }
    let opts = ctx.opts();
    let row = tier2::create(ctx.client(), &opts, USERS, body, None).await?;
    Ok(web::created(Value::Object(auth::sanitize_user(&row))))
}

async fn users_get(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let row = tier2::get(ctx.client(), &opts, USERS, id).await?;
    Ok(web::json_response(Value::Object(auth::sanitize_user(&row))))
}

async fn users_update(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    if auth::contains_password(&body) {
        return Err(ApiError::bad_request("password_is_managed_by_auth_shell", "password_is_managed_by_auth_shell"));
    }
    let opts = ctx.opts();
    let updated = tier2::update(ctx.client(), &opts, USERS, id, body, None).await?;
    Ok(web::json_response(Value::Object(auth::sanitize_user(&updated))))
}

async fn users_delete(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let current = tier2::get(ctx.client(), &opts, USERS, id).await?;
    let mut patch = current;
    patch.insert("status".into(), json!("inactive"));
    patch.insert("deleted_at".into(), json!(crate::now_iso()));
    tier2::update(ctx.client(), &opts, USERS, id, patch, None).await?;
    Ok(web::no_content())
}

// ---------------------------------------------------------------------------
// Geofences and geo
// ---------------------------------------------------------------------------

async fn geofence_test(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let opts = ctx.opts();
    let fence = tier2::get(ctx.client(), &opts, tier2::GEOFENCES, id).await?;
    let polygon = domain::geo::polygon_coordinates(
        fence.get("polygon").or_else(|| fence.get("geometry")).or_else(|| fence.get("coordinates")).unwrap_or(&Value::Null),
    );
    let center = domain::geo::parse_point(&json!({
        "longitude": fence.get("center").and_then(|value| value.get("longitude")).cloned().unwrap_or_else(|| fence.get("center_longitude").cloned().unwrap_or(Value::Null)),
        "latitude": fence.get("center").and_then(|value| value.get("latitude")).cloned().unwrap_or_else(|| fence.get("center_latitude").cloned().unwrap_or(Value::Null)),
    }).as_object().cloned().unwrap_or_default());
    let radius = fence.get("radius_meters").and_then(Value::as_f64).unwrap_or(0.0);
    let in_fence = |point: Option<domain::geo::Point>| -> bool {
        let Some(point) = point else { return false; };
        if let Some(polygon) = &polygon {
            return domain::geo::point_in_polygon(point, polygon);
        }
        if let Some(center) = center {
            return radius > 0.0 && domain::geo::haversine(point, center) <= radius;
        }
        false
    };
    let assets = all_assets(ctx).await?;
    let matched_assets: Vec<String> = assets.iter().filter(|asset| in_fence(point_of(asset))).filter_map(|asset| asset.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let sensors = tier2::list_all(ctx.client(), &opts, tier2::SENSORS, 5000).await?;
    let matched_sensors: Vec<String> = sensors.items.iter().filter(|sensor| in_fence(point_of(sensor))).filter_map(|sensor| sensor.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    Ok(web::json_response(json!({
        "geofence_id": fence.get("id"),
        "matched_assets": matched_assets.len(),
        "matched_sensors": matched_sensors.len(),
        "asset_ids": matched_assets,
        "sensor_ids": matched_sensors,
        "geometry_type": if polygon.is_some() { "polygon" } else if center.is_some() { "circle" } else { "unconfigured" },
    })))
}

async fn geo_nearby(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let query = json!({
        "lng": ctx.query.get("lng").cloned().unwrap_or_default(),
        "lat": ctx.query.get("lat").cloned().unwrap_or_default(),
        "longitude": ctx.query.get("longitude").cloned().unwrap_or_default(),
        "latitude": ctx.query.get("latitude").cloned().unwrap_or_default(),
    });
    let center = domain::geo::parse_point(query.as_object().unwrap_or(&Map::new())).ok_or_else(|| {
        ApiError::bad_request("coordinates_required", "Send lng and lat.")
    })?;
    let radius = ctx.query.get("radius_meters").and_then(|value| value.parse::<f64>().ok()).unwrap_or(1000.0).clamp(0.0, 50_000.0);
    let feature_type = ctx.query.get("feature_type").map(|value| value.to_ascii_lowercase());
    let mut rows: Vec<Value> = all_assets(ctx).await?
        .into_iter()
        .filter_map(|asset| {
            let point = point_of(&asset)?;
            let distance = domain::geo::haversine(point, center);
            if distance > radius {
                return None;
            }
            if let Some(feature_type) = &feature_type {
                if asset.get("feature_type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase() != *feature_type {
                    return None;
                }
            }
            let mut value = Value::Object(asset);
            value["distance_meters"] = json!((distance * 10.0).round() / 10.0);
            Some(value)
        })
        .collect();
    rows.sort_by(|left, right| {
        let left = left.get("distance_meters").and_then(Value::as_f64).unwrap_or(0.0);
        let right = right.get("distance_meters").and_then(Value::as_f64).unwrap_or(0.0);
        left.partial_cmp(&right).unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(web::send_page(rows, ctx.query, 100))
}

async fn geo_bounds(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let min_lng = ctx.query.get("min_lng").and_then(|value| value.parse::<f64>().ok());
    let min_lat = ctx.query.get("min_lat").and_then(|value| value.parse::<f64>().ok());
    let max_lng = ctx.query.get("max_lng").and_then(|value| value.parse::<f64>().ok());
    let max_lat = ctx.query.get("max_lat").and_then(|value| value.parse::<f64>().ok());
    let (Some(min_lng), Some(min_lat), Some(max_lng), Some(max_lat)) = (min_lng, min_lat, max_lng, max_lat) else {
        return Err(ApiError::bad_request("bounds_required", "Send min_lng, min_lat, max_lng, max_lat."));
    };
    let bbox = domain::geo::BoundingBox { min_lng, min_lat, max_lng, max_lat };
    let feature_type = ctx.query.get("feature_type").map(|value| value.to_ascii_lowercase());
    let rows: Vec<Value> = all_assets(ctx).await?
        .into_iter()
        .filter(|asset| point_of(asset).map(|point| domain::geo::point_in_bounding_box(point, bbox)).unwrap_or(false))
        .filter(|asset| feature_type.as_ref().map(|value| asset.get("feature_type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase() == *value).unwrap_or(true))
        .map(Value::Object)
        .collect();
    Ok(web::send_page(rows, ctx.query, 100))
}

async fn geo_polygon(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let value = body.get("polygon").or_else(|| body.get("coordinates")).or_else(|| body.get("geometry")).cloned().unwrap_or(Value::Null);
    let Some(polygon) = domain::geo::polygon_coordinates(&value) else {
        return Err(ApiError::bad_request("polygon_required", "Send a GeoJSON Polygon or a coordinate ring."));
    };
    let feature_type = body.get("feature_type").and_then(Value::as_str).map(|value| value.to_ascii_lowercase());
    let rows: Vec<Value> = all_assets(ctx).await?
        .into_iter()
        .filter(|asset| point_of(asset).map(|point| domain::geo::point_in_polygon(point, &polygon)).unwrap_or(false))
        .filter(|asset| feature_type.as_ref().map(|value| asset.get("feature_type").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase() == *value).unwrap_or(true))
        .map(Value::Object)
        .collect();
    Ok(web::send_page(rows, ctx.query, 100))
}

async fn geo_search(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let query = ctx.query.get("q").cloned().unwrap_or_default();
    if query.trim().len() < 2 {
        return Ok(web::json_response(json!([])));
    }
    let opts = ctx.opts();
    let items = ctx.client().geo().autocomplete(&query, Some(5), None, &opts).await.map_err(ApiError::from)?;
    let values: Vec<Value> = items.into_iter().filter_map(|item| {
        let lat = item.get("lat").and_then(Value::as_f64)?;
        let lon = item.get("lon").and_then(Value::as_f64)?;
        Some(json!({
            "address": item.get("address").or_else(|| item.get("label")).and_then(Value::as_str).unwrap_or(&query),
            "coordinates": { "latitude": lat, "longitude": lon },
            "city": item.get("raw").and_then(|value| value.get("city")).and_then(Value::as_str).unwrap_or(""),
            "country": item.get("raw").and_then(|value| value.get("country")).and_then(Value::as_str).unwrap_or("Vietnam"),
            "ref_id": item.get("id"),
            "provider": "synapsedx",
        }))
    }).collect();
    Ok(web::json_response(Value::Array(values)))
}

async fn geo_geocode(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let address = web::string_field(&web::private_input(ctx.body), "address").unwrap_or_default();
    if address.is_empty() {
        return Err(ApiError::bad_request("address_required", "address_required"));
    }
    let opts = ctx.opts();
    let items = ctx.client().geo().geocode(&address, &opts).await.map_err(ApiError::from)?;
    let hit = items.into_iter().find(|item| item.get("lat").and_then(Value::as_f64).is_some() && item.get("lon").and_then(Value::as_f64).is_some());
    let Some(hit) = hit else {
        return Err(ApiError::not_found("address_not_found", "address_not_found"));
    };
    let lat = hit.get("lat").and_then(Value::as_f64).unwrap_or(0.0);
    let lon = hit.get("lon").and_then(Value::as_f64).unwrap_or(0.0);
    Ok(web::json_response(json!({
        "coordinates": { "latitude": lat, "longitude": lon },
        "geojson": { "type": "Point", "coordinates": [lon, lat] },
        "display_name": hit.get("address").or_else(|| hit.get("label")).and_then(Value::as_str).unwrap_or(&address),
        "provider": "synapsedx",
    })))
}

async fn geo_reverse(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let latitude = web::number_field(&body, "latitude");
    let longitude = web::number_field(&body, "longitude");
    let (Some(latitude), Some(longitude)) = (latitude, longitude) else {
        return Err(ApiError::bad_request("coordinates_required", "coordinates_required"));
    };
    let opts = ctx.opts();
    let items = ctx.client().geo().reverse(latitude, longitude, &opts).await.map_err(ApiError::from)?;
    let hit = items.into_iter().find(|item| item.get("address").or_else(|| item.get("label")).and_then(Value::as_str).map(|value| !value.is_empty()).unwrap_or(false));
    let Some(hit) = hit else {
        return Err(ApiError::not_found("address_not_found", "address_not_found"));
    };
    Ok(web::json_response(json!({
        "address": hit.get("address").or_else(|| hit.get("label")).and_then(Value::as_str).unwrap_or(""),
        "city": hit.get("raw").and_then(|value| value.get("city")).and_then(Value::as_str).unwrap_or(""),
        "country": hit.get("raw").and_then(|value| value.get("country")).and_then(Value::as_str).unwrap_or("Vietnam"),
        "provider": "synapsedx",
    })))
}

async fn geo_distance(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let target = domain::geo::parse_point(&json!({
        "lng": ctx.query.get("lng").cloned().unwrap_or_default(),
        "lat": ctx.query.get("lat").cloned().unwrap_or_default(),
        "longitude": ctx.query.get("longitude").cloned().unwrap_or_default(),
        "latitude": ctx.query.get("latitude").cloned().unwrap_or_default(),
    }).as_object().cloned().unwrap_or_default()).ok_or_else(|| ApiError::bad_request("coordinates_required", "coordinates_required"))?;
    let Some(asset) = find_asset(ctx, id).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    let Some(origin) = point_of(&asset) else {
        return Err(ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "asset_has_no_coordinates", "asset_has_no_coordinates"));
    };
    let distance = (domain::geo::haversine(origin, target) * 10.0).round() / 10.0;
    Ok(web::json_response(json!({
        "asset_id": asset.get("id"),
        "distance_meters": distance,
        "duration_seconds": domain::geo::estimated_duration_seconds(distance, Some(30.0)),
        "mode": "straight_line_estimate",
        "speed_kmh": 30,
    })))
}

async fn geo_coverage(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let areas = body.get("areas").and_then(Value::as_array).cloned().unwrap_or_default();
    if areas.is_empty() {
        return Err(ApiError::bad_request("areas_required", "Send { areas: [...] }."));
    }
    let assets: Vec<domain::analytics::CoverageAsset> = all_assets(ctx).await?.into_iter().map(|asset| domain::analytics::CoverageAsset {
        id: asset.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
        feature_type: asset.get("feature_type").and_then(Value::as_str).unwrap_or("infrastructure").to_string(),
        point: point_of(&asset),
    }).collect();
    let incidents: Vec<domain::analytics::CoverageIncident> = tier2::list_all(ctx.client(), &ctx.opts(), INCIDENTS, 5000).await?
        .items
        .into_iter()
        .map(|incident| domain::analytics::CoverageIncident {
            id: incident.get("id").and_then(Value::as_str).unwrap_or("").to_string(),
            status: incident.get("status").and_then(Value::as_str).unwrap_or("").to_string(),
            point: point_of(&incident).or_else(|| incident.get("location").and_then(Value::as_object).and_then(|location| domain::geo::parse_point(location))),
            reported_at: incident.get("reported_at").and_then(Value::as_str).map(str::to_string),
        })
        .collect();
    let input = domain::analytics::CoverageInput {
        areas: serde_json::from_value(Value::Array(areas)).unwrap_or_default(),
        assets,
        incidents,
        service_radius_meters: body.get("service_radius_meters").and_then(Value::as_f64),
        target_population_per_asset: body.get("target_population_per_asset").and_then(Value::as_f64),
        now: None,
    };
    let report = domain::analytics::analyse_coverage(input);
    Ok(web::json_response(serde_json::to_value(report).unwrap_or(Value::Null)))
}

// ---------------------------------------------------------------------------
// CSV ingest
// ---------------------------------------------------------------------------

async fn ingest_csv(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let filename = web::string_field(&body, "filename").unwrap_or_else(|| "upload.csv".into());
    let content = web::string_field(&body, "content").unwrap_or_default();
    if content.trim().is_empty() {
        return Err(ApiError::bad_request("content_required", "Send { filename, content }."));
    }
    let parsed = domain::csv::parse_csv(&content);
    let missing = domain::csv::missing_asset_columns(&parsed.headers);
    if !missing.is_empty() {
        return Err(ApiError::bad_request("missing_columns", "CSV is missing required columns.")
            .with_details(json!({ "missing": missing })));
    }
    let opts = ctx.opts();
    let existing = tier2::list_all(ctx.client(), &opts, ASSETS, 5000).await?;
    let existing_ids: HashSet<String> = existing.items.into_iter().filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let mut created = 0usize;
    let mut skipped = 0usize;
    let mut errors = Vec::new();
    for (index, row) in parsed.rows.iter().enumerate() {
        let latitude = row.get("latitude").and_then(Value::as_str).and_then(|value| value.parse::<f64>().ok());
        let longitude = row.get("longitude").and_then(Value::as_str).and_then(|value| value.parse::<f64>().ok());
        let (Some(latitude), Some(longitude)) = (latitude, longitude) else {
            errors.push(json!({ "row": index + 2, "message": "latitude_and_longitude_must_be_numeric" }));
            continue;
        };
        let Some(asset_code) = row.get("asset_code").and_then(Value::as_str).filter(|value| !value.is_empty()) else {
            errors.push(json!({ "row": index + 2, "message": "required_value_missing" }));
            continue;
        };
        let name = row.get("name").and_then(Value::as_str).unwrap_or("").to_string();
        let feature_type = row.get("feature_type").and_then(Value::as_str).unwrap_or("").to_string();
        let feature_code = row.get("feature_code").and_then(Value::as_str).unwrap_or("").to_string();
        if name.is_empty() || feature_type.is_empty() || feature_code.is_empty() {
            errors.push(json!({ "row": index + 2, "message": "required_value_missing" }));
            continue;
        }
        if existing_ids.contains(asset_code) {
            skipped += 1;
            continue;
        }
        let geometry = row.get("geometry").and_then(Value::as_str).and_then(|value| serde_json::from_str::<Value>(value).ok()).filter(|value| value.get("type").and_then(Value::as_str).is_some()).unwrap_or_else(|| json!({"type":"Point","coordinates":[longitude, latitude]}));
        let properties = row.get("properties").and_then(Value::as_str).and_then(|value| serde_json::from_str::<Value>(value).ok()).filter(|value| value.is_object()).unwrap_or_else(|| json!({}));
        let now = crate::now_iso();
        let mut asset = Map::new();
        asset.insert("assetId".into(), json!(asset_code));
        asset.insert("asset_code".into(), json!(asset_code));
        asset.insert("name".into(), json!(name));
        asset.insert("feature_type".into(), json!(feature_type));
        asset.insert("feature_code".into(), json!(feature_code));
        asset.insert("category".into(), row.get("category").and_then(Value::as_str).map(|value| json!(value)).unwrap_or_else(|| json!(feature_type)));
        asset.insert("status".into(), json!(row.get("status").and_then(Value::as_str).map(|value| json!(value)).unwrap_or_else(|| json!("active"))));
        asset.insert("geometry".into(), geometry);
        asset.insert("location".into(), json!({
            "address": row.get("address").and_then(Value::as_str).map(|value| json!(value)).unwrap_or(Value::Null),
            "coordinates": { "longitude": longitude, "latitude": latitude },
        }));
        asset.insert("properties".into(), properties);
        asset.insert("source".into(), json!("synapsecity-ingest"));
        asset.insert("sourceVersion".into(), json!("1.0.0"));
        asset.insert("created_at".into(), json!(now));
        asset.insert("updated_at".into(), json!(now));
        match tier2::create(ctx.client(), &opts, ASSETS, asset, Some(asset_code)).await {
            Ok(_) => created += 1,
            Err(error) => {
                if error.status == StatusCode::CONFLICT || error.status == StatusCode::BAD_REQUEST {
                    skipped += 1;
                } else {
                    errors.push(json!({ "row": index + 2, "message": error.message }));
                }
            }
        }
    }
    let mut job = Map::new();
    job.insert("filename".into(), json!(filename));
    job.insert("status".into(), json!("completed"));
    job.insert("accepted".into(), json!(parsed.rows.len()));
    job.insert("created".into(), json!(created));
    job.insert("skipped".into(), json!(skipped));
    job.insert("failed".into(), json!(errors.len()));
    job.insert("errors".into(), json!(errors.iter().take(50).collect::<Vec<_>>()));
    job.insert("completed_at".into(), json!(crate::now_iso()));
    let stored = tier2::create(ctx.client(), &opts, tier2::INGEST, job, None).await?;
    let all_failed = created == 0 && skipped == 0 && !errors.is_empty();
    Ok(web::status_json(
        if all_failed { StatusCode::BAD_GATEWAY } else { StatusCode::ACCEPTED },
        json!({
            "message": format!("Ingested {created} of {} asset rows ({skipped} already present)", parsed.rows.len()),
            "job_id": stored.get("id"),
            "accepted": parsed.rows.len(),
            "created": created,
            "skipped": skipped,
            "errors": errors,
        }),
    ))
}

// ---------------------------------------------------------------------------
// Public projections
// ---------------------------------------------------------------------------

fn asset_is_public(asset: &Map<String, Value>, include_inactive: bool) -> bool {
    if asset.get("deleted_at").is_some() || asset.get("public_visible").and_then(Value::as_bool) == Some(false) {
        return false;
    }
    if include_inactive {
        return true;
    }
    let status = asset.get("status").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    let lifecycle = asset.get("lifecycle_stage").and_then(Value::as_str).unwrap_or("").to_ascii_lowercase();
    !["decommissioned", "deleted", "purged", "retired"].contains(&status.as_str())
        && !["decommissioned", "deleted", "retired"].contains(&lifecycle.as_str())
}

fn public_asset_view(ctx: &Ctx<'_>, asset: &Map<String, Value>) -> Value {
    let code = asset_code(asset);
    let url = format!("{}/asset/{}", ctx.config().public_url, percent_encoding::utf8_percent_encode(&code, percent_encoding::NON_ALPHANUMERIC));
    let coordinates = coordinates_of(asset);
    json!({
        "id": asset.get("id"),
        "asset_code": code,
        "name": asset.get("name"),
        "feature_type": asset.get("feature_type"),
        "feature_code": asset.get("feature_code"),
        "category": asset.get("category").cloned().unwrap_or_else(|| asset.get("feature_type").cloned().unwrap_or_else(|| json!("infrastructure"))),
        "status": asset.get("status"),
        "location": {
            "address": asset.get("location").and_then(|value| value.get("address")).and_then(Value::as_str).unwrap_or(""),
            "coordinates": coordinates.map(|(longitude, latitude)| json!({"longitude": longitude, "latitude": latitude})),
            "geometry": asset.get("geometry"),
        },
        "geometry": asset.get("geometry"),
        "qr_code": url,
        "public_url": url,
    })
}

async fn public_assets(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let include_inactive = ctx.query.get("include_inactive").map(|value| value == "true" || value == "1").unwrap_or(false);
    let values: Vec<Value> = all_assets(ctx).await?
        .into_iter()
        .filter(|asset| asset_is_public(asset, include_inactive))
        .map(|asset| public_asset_view(ctx, &asset))
        .collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn public_asset(ctx: &Ctx<'_>, code: &str) -> ApiResult<Response> {
    let Some(asset) = find_asset(ctx, code).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    if !asset_is_public(&asset, true) {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    }
    Ok(web::json_response(public_asset_view(ctx, &asset)))
}

async fn public_asset_aux(ctx: &Ctx<'_>, code: &str, kind: &str) -> ApiResult<Response> {
    let Some(asset) = find_asset(ctx, code).await? else {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    };
    if !asset_is_public(&asset, true) {
        return Err(ApiError::not_found("asset_not_found", "asset_not_found"));
    }
    if kind == "qr" {
        let view = public_asset_view(ctx, &asset);
        return Ok(web::json_response(json!({
            "asset_code": view.get("asset_code"),
            "qr_code": view.get("qr_code"),
            "url": view.get("public_url"),
        })));
    }
    let opts = ctx.opts();
    let orders = tier2::list_all(ctx.client(), &opts, MAINTENANCE, 5000).await?;
    let asset_ids: HashSet<String> = [asset.get("id"), asset.get("asset_code")].into_iter().flatten().filter_map(Value::as_str).map(str::to_string).collect();
    let orders: Vec<Map<String, Value>> = orders.items.into_iter().filter(|order| {
        order.get("asset_id").or_else(|| order.get("assetId")).and_then(Value::as_str).map(|id| asset_ids.contains(id)).unwrap_or(false)
    }).collect();
    let completed: Vec<&Map<String, Value>> = orders.iter().filter(|order| order.get("status").and_then(Value::as_str).map(|status| status.eq_ignore_ascii_case("completed")).unwrap_or(false)).collect();
    Ok(web::json_response(json!({
        "asset_code": asset.get("asset_code").or_else(|| asset.get("id")),
        "work_order_count": orders.len(),
        "completed_count": completed.len(),
        "last_completed_at": completed.first().and_then(|order| order.get("completed_at").or_else(|| order.get("scheduled_date"))),
        "last_maintenance_type": completed.first().and_then(|order| order.get("type").or_else(|| order.get("maintenance_type"))),
    })))
}

async fn public_incidents(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let rows = tier2::list_all(ctx.client(), &opts, INCIDENTS, 5000).await?;
    let values: Vec<Value> = rows.items.into_iter()
        .filter(|row| domain::incidents::incident_is_publicly_visible(row))
        .map(|row| Value::Object(domain::incidents::to_public_incident_view(&row)))
        .collect();
    Ok(web::send_page(values, ctx.query, 100))
}

async fn public_incident(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let Some(incident) = find_public_incident(ctx, id).await? else {
        return Err(ApiError::not_found("incident_not_found", "incident_not_found"));
    };
    if !domain::incidents::incident_is_publicly_visible(&incident) {
        return Err(ApiError::not_found("incident_not_found", "incident_not_found"));
    }
    Ok(web::json_response(Value::Object(domain::incidents::to_public_incident_view(&incident))))
}

fn enforce_turnstile(ctx: &Ctx<'_>) -> Result<(), ApiError> {
    if !ctx.config().require_turnstile {
        return Ok(());
    }
    let token = ctx
        .headers
        .get("cf-turnstile-response")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| ctx.body.get("turnstile_token").and_then(Value::as_str));
    if token.is_some() {
        Ok(())
    } else {
        Err(ApiError::forbidden("turnstile_failed", "turnstile_failed"))
    }
}

async fn public_incident_create(ctx: &Ctx<'_>) -> ApiResult<Response> {
    enforce_turnstile(ctx)?;
    let body = web::private_input(ctx.body);
    let incident_id = uuid::Uuid::new_v4().to_string();
    let number = incident_number();
    let photo_values: Vec<Value> = body.get("photos").and_then(Value::as_array).cloned()
        .or_else(|| body.get("file_ids").and_then(Value::as_array).cloned())
        .or_else(|| body.get("file_id").cloned().map(|value| vec![value]))
        .unwrap_or_default();
    if photo_values.len() > 10 {
        return Err(ApiError::too_large("too_many_photos", "too_many_photos"));
    }
    let photos: Vec<Value> = if photo_values.is_empty() {
        Vec::new()
    } else {
        resolve_photos(ctx, &photo_values, true).await?.into_iter().map(|entry| json!(entry.get("url").and_then(Value::as_str).unwrap_or(""))).collect()
    };
    let now = crate::now_iso();
    let mut incident = Map::new();
    incident.insert("incidentId".into(), json!(incident_id));
    incident.insert("incident_number".into(), json!(number));
    incident.insert("incident_code".into(), json!(number));
    incident.insert("title".into(), json!(web::required_string(&body, "title")?));
    incident.insert("description".into(), json!(web::required_string(&body, "description")?));
    incident.insert("category".into(), json!(web::string_field(&body, "category").unwrap_or_else(|| "other".into())));
    incident.insert("severity".into(), json!(web::string_field(&body, "severity").unwrap_or_else(|| "medium".into())));
    incident.insert("status".into(), json!("reported"));
    incident.insert("reporter_type".into(), json!("citizen"));
    incident.insert("reported_by".into(), json!("anonymous"));
    incident.insert("reported_via".into(), json!("web"));
    incident.insert("public_visible".into(), json!(true));
    incident.insert("reported_at".into(), json!(now));
    incident.insert("occurredAt".into(), json!(web::string_field(&body, "occurredAt").unwrap_or_else(|| now.clone())));
    incident.insert("created_at".into(), json!(now));
    incident.insert("updated_at".into(), json!(now));
    incident.insert("upvotes".into(), json!(0));
    incident.insert("comments".into(), json!([]));
    incident.insert("source".into(), json!("synapsecity-public"));
    incident.insert("sourceVersion".into(), json!("1.0.0"));
    if let Some(value) = body.get("asset_id") {
        incident.insert("asset_id".into(), value.clone());
    }
    if let Some(value) = body.get("location") {
        incident.insert("location".into(), value.clone());
    }
    if !photos.is_empty() {
        incident.insert("photos".into(), Value::Array(photos));
    }
    if let Some(contact) = body.get("contact_info").and_then(Value::as_object) {
        incident.insert("contact_info".into(), json!({
            "name": contact.get("name").and_then(Value::as_str).unwrap_or(""),
            "phone_number": contact.get("phone_number").and_then(Value::as_str).unwrap_or(""),
            "id_card_verified": contact.get("id_card_number").map(|value| !value.is_null()).unwrap_or(false),
        }));
    }
    let published = domain::incidents::to_published_incident(&incident);
    let opts = ctx.opts();
    tier2::create(ctx.client(), &opts, INCIDENTS, published, Some(&incident_id)).await?;
    write_incident_internal(ctx, &incident_id, &incident).await?;
    let _ = notify_operators(
        ctx,
        "incident_reported",
        format!("New citizen report: {}", incident.get("title").and_then(Value::as_str).unwrap_or(&incident_id)),
        incident.get("description").and_then(Value::as_str).unwrap_or("").to_string(),
        if incident.get("severity").and_then(Value::as_str) == Some("critical") { "critical" } else { "info" },
        "incident",
        &incident_id,
    ).await;
    let mut view = incident.clone();
    view.insert("id".into(), json!(incident_id));
    Ok(web::created(Value::Object(domain::incidents::to_public_incident_view(&view))))
}

async fn public_incident_photos(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let values: Vec<Value> = body.get("photos").and_then(Value::as_array).cloned()
        .or_else(|| body.get("file_ids").and_then(Value::as_array).cloned())
        .or_else(|| body.get("file_id").cloned().map(|value| vec![value]))
        .unwrap_or_default();
    if values.is_empty() {
        return Err(ApiError::bad_request("photos_required", "photos_required"));
    }
    let photos: Vec<Value> = resolve_photos(ctx, &values, true).await?.into_iter().map(|entry| json!(entry.get("url").and_then(Value::as_str).unwrap_or(""))).collect();
    let Some(existing) = find_public_incident(ctx, id).await? else {
        return Err(ApiError::not_found("incident_not_found", "incident_not_found"));
    };
    if !domain::incidents::incident_is_publicly_visible(&existing) {
        return Err(ApiError::not_found("incident_not_found", "incident_not_found"));
    }
    let mut current = existing.get("photos").and_then(Value::as_array).cloned().unwrap_or_default();
    current.extend(photos);
    let mut patch = Map::new();
    patch.insert("photos".into(), Value::Array(current));
    let updated = update_incident(ctx, id, patch).await?;
    Ok(web::json_response(Value::Object(domain::incidents::to_public_incident_view(&updated))))
}

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

async fn attachment_from_body(
    ctx: &Ctx<'_>,
    body: &Map<String, Value>,
    fallback_name: &str,
    photo: bool,
) -> ApiResult<Map<String, Value>> {
    if body.get("content_base64").is_some() || body.get("file_content").is_some() || body.get("content").and_then(Value::as_str).map(|value| value.len() > 256).unwrap_or(false) {
        return Err(ApiError::unsupported(
            "raw_upload_not_accepted",
            "Upload bytes with POST /v1/files/upload and send the returned file id.",
        ));
    }
    let allowlist: &[&str] = if photo { &domain::files::IMAGE_MIME_TYPES } else { &domain::files::DOCUMENT_MIME_TYPES };
    let reference = body
        .get("file_id")
        .or_else(|| body.get("fileId"))
        .or_else(|| body.get("file_url"))
        .or_else(|| body.get("url"))
        .or_else(|| body.get("photo"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::bad_request("file_reference_required", "file_reference_required"))?;
    if domain::files::is_data_url(reference) {
        return Err(ApiError::unsupported("data_url_not_supported", "data_url_not_supported"));
    }
    let is_file_id = body.get("file_id").is_some() || body.get("fileId").is_some() || domain::files::looks_like_file_id(reference);
    let principal = ctx.principal();
    if is_file_id {
        let file_id = body.get("file_id").or_else(|| body.get("fileId")).and_then(Value::as_str).unwrap_or(reference);
        let Some(record) = file_metadata(ctx, file_id).await? else {
            return Err(ApiError::not_found("file_not_found", "file_not_found"));
        };
        if !requester_can_use_file(principal, &record) {
            return Err(ApiError::not_found("file_not_found", "file_not_found"));
        }
        let content_type = record.get("contentType").or_else(|| record.get("content_type")).and_then(Value::as_str).unwrap_or("");
        if !allowlist.contains(&content_type) {
            return Err(ApiError::unsupported("unsupported_file_type", "unsupported_file_type"));
        }
        return Ok(json!({
            "file_id": record.get("id"),
            "file_name": body.get("file_name").or_else(|| body.get("name")).and_then(Value::as_str).or_else(|| record.get("filename").and_then(Value::as_str)).unwrap_or(fallback_name),
            "file_url": file_url(ctx.config(), record.get("id").and_then(Value::as_str).unwrap_or(file_id), record.get("public").and_then(Value::as_bool).unwrap_or(false)),
            "file_type": content_type,
            "size": record.get("size"),
            "checksum_sha256": record.get("checksumSha256").or_else(|| record.get("checksum_sha256")),
            "uploaded_by": principal.map(|value| value.sub.clone()).or_else(|| record.get("owner").and_then(Value::as_str).map(str::to_string)),
            "uploaded_at": body.get("uploaded_at").and_then(Value::as_str).map(str::to_string).unwrap_or_else(crate::now_iso),
        }).as_object().cloned().unwrap_or_default());
    }
    let file_url = domain::files::assert_stored_file_reference(
        Some(&json!(reference)),
        Some("file_url"),
        ctx.config().allow_local_dependencies,
    ).map_err(file_error)?;
    let file_type = domain::files::assert_mime_type(
        body.get("file_type").or_else(|| body.get("type")),
        allowlist,
    ).map_err(file_error)?;
    Ok(json!({
        "file_name": body.get("file_name").or_else(|| body.get("name")).and_then(Value::as_str).unwrap_or(fallback_name),
        "file_url": file_url,
        "file_type": file_type,
        "uploaded_by": principal.map(|value| value.sub.clone()).unwrap_or_else(|| "system".into()),
        "uploaded_at": body.get("uploaded_at").and_then(Value::as_str).map(str::to_string).unwrap_or_else(crate::now_iso),
    }).as_object().cloned().unwrap_or_default())
}

async fn resolve_photos(ctx: &Ctx<'_>, values: &[Value], public_url: bool) -> ApiResult<Vec<Map<String, Value>>> {
    let mut resolved = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let body = if value.is_string() {
            json!({ "file_url": value }).as_object().cloned().unwrap_or_default()
        } else {
            value.as_object().cloned().unwrap_or_default()
        };
        let attachment = attachment_from_body(ctx, &body, &format!("photo-{}", index + 1), true).await?;
        let url = attachment.get("file_url").and_then(Value::as_str).unwrap_or("").to_string();
        let _ = public_url;
        let mut entry = Map::new();
        entry.insert("url".into(), json!(url));
        entry.insert("attachment".into(), Value::Object(attachment));
        resolved.push(entry);
    }
    Ok(resolved)
}

// ---------------------------------------------------------------------------
// HITL approvals
// ---------------------------------------------------------------------------

fn approver_roles(ctx: &Ctx<'_>, action: &str) -> Vec<String> {
    match action {
        "eop.approve" => ctx.config().eop_approver_roles.clone(),
        "maintenance.approve" => ctx.config().maintenance_approver_roles.clone(),
        _ => ctx.config().dispatch_approver_roles.clone(),
    }
}

async fn create_approval(
    ctx: &Ctx<'_>,
    title: String,
    module: &str,
    action: &str,
    entity_type: &str,
    entity_id: &str,
    payload: Value,
    requester: &str,
) -> ApiResult<Value> {
    let body = json!({
        "title": title,
        "module": module,
        "action": action,
        "entityType": entity_type,
        "entityId": entity_id,
        "payload": payload,
        "requester": requester,
        "approverRoles": approver_roles(ctx, action),
        "requiredApprovals": ctx.config().required_approvals,
        "dueAt": (Utc::now() + chrono::Duration::minutes(ctx.config().approval_sla_minutes as i64)).to_rfc3339_opts(SecondsFormat::Millis, true),
    });
    let opts = ctx.opts();
    let response = ctx.client().post("/v1/capabilities/approvals", body, &opts).await.map_err(ApiError::from)?;
    Ok(response.get("approval").cloned().unwrap_or(response))
}

async fn get_approval(ctx: &Ctx<'_>, id: &str) -> ApiResult<Value> {
    let opts = ctx.opts();
    let response = ctx.client().get(format!("/v1/capabilities/approvals/{id}"), &opts).await.map_err(ApiError::from)?;
    Ok(response.get("approval").cloned().unwrap_or(response))
}

async fn assert_approved(ctx: &Ctx<'_>, approval_id: &str, entity_id: &str, action: &str, actor: &str) -> ApiResult<Value> {
    let approval = get_approval(ctx, approval_id).await?;
    if approval.get("status").and_then(Value::as_str) != Some("approved") {
        return Err(ApiError::conflict("approval_not_approved", "approval_not_approved"));
    }
    if approval.get("entityId").and_then(Value::as_str) != Some(entity_id) {
        return Err(ApiError::conflict("approval_entity_mismatch", "approval_entity_mismatch"));
    }
    if approval.get("action").and_then(Value::as_str) != Some(action) {
        return Err(ApiError::conflict("approval_action_mismatch", "approval_action_mismatch"));
    }
    if approval.get("requester").and_then(Value::as_str) == Some(actor) {
        return Err(ApiError::forbidden("self_approval_forbidden", "self_approval_forbidden"));
    }
    Ok(approval)
}

async fn list_pending_approvals(ctx: &Ctx<'_>, module: Option<&str>) -> ApiResult<Vec<Value>> {
    let mut path = "/v1/capabilities/approvals?status=pending".to_string();
    if let Some(module) = module {
        path.push_str("&module=");
        path.push_str(&url::form_urlencoded::byte_serialize(module.as_bytes()).collect::<String>());
    }
    let opts = ctx.opts();
    let response = ctx.client().get(path, &opts).await.map_err(ApiError::from)?;
    Ok(response.get("items").and_then(Value::as_array).cloned().unwrap_or_default())
}

async fn hitl_list(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let items = list_pending_approvals(ctx, ctx.query.get("module").map(String::as_str)).await?;
    let now = Utc::now().timestamp_millis();
    let values: Vec<Value> = items.into_iter().map(|mut item| {
        let escalated = item.get("dueAt").and_then(Value::as_str).and_then(compare_timestamp).map(|due| due < now).unwrap_or(false);
        item["escalated"] = json!(escalated);
        item
    }).collect();
    let total = values.len();
    Ok(web::json_response(json!({ "items": values, "total": total })))
}

async fn hitl_decide(ctx: &Ctx<'_>, id: &str) -> ApiResult<Response> {
    let decision = web::string_field(ctx.body, "decision").unwrap_or_default().to_ascii_lowercase();
    if !["approve", "reject"].contains(&decision.as_str()) {
        return Err(ApiError::bad_request("invalid_decision", "invalid_decision"));
    }
    let mut body = json!({ "decision": decision });
    if let Some(note) = web::string_field(ctx.body, "note") {
        body["note"] = json!(note);
    }
    let opts = ctx.opts();
    let response = ctx.client().post(format!("/v1/capabilities/approvals/{id}/decide"), body, &opts).await.map_err(ApiError::from)?;
    Ok(web::json_response(json!({ "approval": response.get("approval").cloned().unwrap_or(response) })))
}

// ---------------------------------------------------------------------------
// Map and AI
// ---------------------------------------------------------------------------

async fn map_tile(ctx: &Ctx<'_>, z: &str, x: &str, y: &str) -> ApiResult<Response> {
    let Some(api_key) = ctx.config().tier2_api_key.clone().or_else(|| ctx.config().tier2_token.clone()) else {
        return Ok(web::status_json(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "map_tiles_unavailable", "dependency": "synapsedx" })));
    };
    let y = y.strip_suffix(".png").unwrap_or(y);
    let url = format!("{}/v1/capabilities/geo/tiles/{}/{}/{}.png", ctx.config().tier2_url, z, x, y);
    let client = reqwest::Client::new();
    let mut request = client.get(url).header("accept", "*/*");
    request = if ctx.config().tier2_api_key.is_some() {
        request.header("x-api-key", api_key)
    } else {
        request.header("authorization", format!("Bearer {api_key}"))
    };
    match request.send().await {
        Ok(response) if response.status().is_success() => {
            let content_type = response.headers().get("content-type").and_then(|value| value.to_str().ok()).unwrap_or("image/png").to_string();
            let bytes = response.bytes().await.map_err(ApiError::internal)?;
            let mut output = Response::new(axum::body::Body::from(bytes));
            output.headers_mut().insert("content-type", HeaderValue::from_str(&content_type).unwrap_or(HeaderValue::from_static("image/png")));
            output.headers_mut().insert("cache-control", HeaderValue::from_static("public, max-age=86400, immutable"));
            Ok(output)
        }
        Ok(response) => Ok(web::status_json(
            if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS { StatusCode::TOO_MANY_REQUESTS } else { StatusCode::SERVICE_UNAVAILABLE },
            json!({ "error": "map_tiles_unavailable", "dependency": "synapsedx", "upstreamStatus": response.status().as_u16() }),
        )),
        Err(_) => Ok(web::status_json(StatusCode::SERVICE_UNAVAILABLE, json!({ "error": "map_tiles_unavailable", "dependency": "synapsedx" }))),
    }
}

async fn ai_status(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let opts = ctx.opts();
    let status = ai::ai_status(ctx.state, &opts).await;
    Ok(web::status_json(
        if status.get("status").and_then(Value::as_str) == Some("unavailable") { StatusCode::SERVICE_UNAVAILABLE } else { StatusCode::OK },
        status,
    ))
}

async fn ai_chat(ctx: &Ctx<'_>) -> ApiResult<Response> {
    let body = web::private_input(ctx.body);
    let message = web::string_field(&body, "message").unwrap_or_default();
    if message.is_empty() {
        return Err(ApiError::bad_request("message_required", "message_required"));
    }
    let context = body.get("context").cloned();
    let opts = ctx.opts();
    let result = ai::ai_chat(ctx.state, &opts, &message, context).await?;
    Ok(web::json_response(result))
}

#[cfg(test)]
mod route_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{HeaderMap, Method, Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use synapsedx::{Client, Credentials};
    use tower::ServiceExt;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn state(uri: &str) -> AppState {
        let config = Config::for_test(uri);
        let client = Client::new(uri, Credentials::none()).unwrap();
        AppState::new(config, client)
    }

    fn app(state: AppState) -> Router {
        Router::new().fallback(dispatch).with_state(state)
    }

    fn admin_token(config: &Config) -> String {
        let principal = auth::principal_from_input(
            config,
            "qa",
            Some("qa@example.com"),
            Some("QA"),
            None,
            auth::ROLE_ADMIN,
        );
        auth::issue_session(config, principal, false).access_token
    }

    async fn call(
        app: Router,
        method: Method,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, HeaderMap, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(serde_json::to_vec(&value).unwrap())
            }
            None => Body::empty(),
        };
        let response = app.oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, headers, value)
    }

    async fn mount_dataset(
        server: &MockServer,
        id: &str,
        name: &str,
        entity_type: &str,
        description: &str,
        public: bool,
    ) {
        Mock::given(method("GET"))
            .and(path(format!("/v1/capabilities/datasets/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": id,
                "slug": id,
                "name": name,
                "entityType": entity_type,
                "license": "PDDL-1.0",
                "public": public,
                "status": "published",
                "description": description,
                "schemaVersion": "1.0.0",
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z"
            })))
            .mount(server)
            .await;
    }

    #[tokio::test]
    async fn auth_entry_points_are_permanently_410_for_all_methods() {
        let app = app(state("http://127.0.0.1:1"));
        for method in [Method::POST, Method::GET] {
            for route in ["login", "register", "refresh"] {
                let (status, _, body) = call(
                    app.clone(),
                    method.clone(),
                    &format!("/v1/auth/{route}"),
                    None,
                    Some(json!({})),
                )
                .await;
                assert_eq!(status, StatusCode::GONE, "{method} {route}");
                assert_eq!(body["error"], "workspace_moved");
                assert_eq!(body["workspace_url"], "https://synapsedx.sbs/workspace");
            }
        }
    }

    #[tokio::test]
    async fn operator_routes_require_a_valid_session() {
        let app = app(state("http://127.0.0.1:1"));
        let (status, _, _) = call(app.clone(), Method::GET, "/v1/assets", None, None).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _, _) = call(
            app,
            Method::GET,
            "/v1/assets",
            Some("not-a-token"),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn foreign_sos_namespace_is_rejected_locally() {
        let app = app(state("http://127.0.0.1:1"));
        let (status, _, body) = call(app, Method::GET, "/v1/emergency", None, None).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["product"], "synapsecity");
    }

    #[tokio::test]
    async fn asset_and_incident_validation_happens_before_tier2() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let app = app(AppState::new(
            config,
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        ));
        let (status, _, body) = call(
            app.clone(),
            Method::POST,
            "/v1/assets",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "field_required:name");
        let (status, _, body) = call(
            app,
            Method::POST,
            "/v1/incidents",
            Some(&token),
            Some(json!({ "title": "Pothole" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "field_required:category");
    }

    #[tokio::test]
    async fn public_map_config_and_status_stay_anonymous() {
        let app = app(state("http://127.0.0.1:1"));
        let (status, _, body) = call(
            app.clone(),
            Method::GET,
            "/v1/map/config",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["provider"], "synapsedx");
        let (status, _, body) = call(app, Method::GET, "/v1/map/status", None, None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["service"], "synapsecity");
    }

    #[tokio::test]
    async fn public_assets_are_projected_without_a_session() {
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "city-assets",
            "SynapseCity infrastructure assets",
            "CityAsset",
            "Public projection of city infrastructure assets",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/city-assets/records"))
            .and(query_param("limit", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{
                    "id": "a1",
                    "version": 1,
                    "createdAt": "2026-11-01T00:00:00.000Z",
                    "updatedAt": "2026-11-01T00:00:00.000Z",
                    "data": {
                        "id": "a1",
                        "asset_code": "A1",
                        "name": "Pump station",
                        "feature_type": "utility",
                        "feature_code": "pump",
                        "status": "active",
                        "public_visible": true,
                        "geometry": {"type": "Point", "coordinates": [105.8, 21.0]}
                    }
                }],
                "total": 1,
                "limit": 500,
                "offset": 0,
                "nextCursor": null
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (status, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/public/assets?limit=1",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body[0]["asset_code"], "A1");
        assert_eq!(body[0]["name"], "Pump station");
    }

    #[tokio::test]
    async fn generic_record_get_sets_etag_and_stale_update_is_rejected() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "city-maintenance",
            "SynapseCity maintenance work orders",
            "MaintenanceWorkOrder",
            "Infrastructure maintenance lifecycle records",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/city-maintenance/records/m1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "m1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "title": "Pump repair", "status": "scheduled" }
            })))
            .expect(2)
            .mount(&server)
            .await;

        let state = AppState::new(config, Client::new(&server.uri(), Credentials::none()).unwrap());
        let app = app(state);
        let (status, headers, value) = call(
            app.clone(),
            Method::GET,
            "/v1/maintenance/m1",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get("etag").unwrap(), "\"3\"");
        assert_eq!(value["record_version"], 3);

        let (status, _, body) = call(
            app,
            Method::PUT,
            "/v1/maintenance/m1",
            Some(&token),
            Some(json!({ "if_version": 4, "status": "completed" })),
        )
        .await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["code"], "record_version_conflict");
    }

    #[tokio::test]
    async fn matching_if_version_writes_and_returns_new_etag() {
        let config = Config::for_test("http://127.0.0.1:1");
        let token = admin_token(&config);
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "city-maintenance",
            "SynapseCity maintenance work orders",
            "MaintenanceWorkOrder",
            "Infrastructure maintenance lifecycle records",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/city-maintenance/records/m1"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "m1",
                "version": 3,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": { "title": "Pump repair", "status": "scheduled" }
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("PATCH"))
            .and(path("/v1/capabilities/datasets/city-maintenance/records/m1"))
            .and(header("if-match", "\"3\""))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "m1",
                "version": 4,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:01.000Z",
                "data": { "title": "Pump repair", "status": "completed" }
            })))
            .expect(1)
            .mount(&server)
            .await;

        let state = AppState::new(config, Client::new(&server.uri(), Credentials::none()).unwrap());
        let (status, headers, value) = call(
            app(state),
            Method::PUT,
            "/v1/maintenance/m1",
            Some(&token),
            Some(json!({ "if_version": 3, "status": "completed" })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(headers.get("etag").unwrap(), "\"4\"");
        assert_eq!(value["record_version"], 4);
    }

    #[tokio::test]
    async fn public_incident_intake_writes_public_and_private_sidecar() {
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "city-incidents",
            "SynapseCity infrastructure incidents",
            "CityIncident",
            "Public projection of generalized infrastructure incidents",
            true,
        )
        .await;
        mount_dataset(
            &server,
            "city-incident-internal",
            "SynapseCity incident internal records",
            "CityIncidentInternal",
            "Private reporter identity and internal incident notes",
            false,
        )
        .await;
        mount_dataset(
            &server,
            "city-users",
            "SynapseCity users",
            "CityUser",
            "Domain operator profiles",
            false,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/city-users/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [], "total": 0, "limit": 500, "offset": 0, "nextCursor": null
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/capabilities/datasets/city-incidents/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "inc-1",
                "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {"title": "Broken pump"}
            })))
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/city-incident-internal/records/internal-inc-1"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": {"code": "not_found"}})))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/v1/capabilities/datasets/city-incident-internal/records"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": "internal-inc-1",
                "version": 1,
                "createdAt": "2026-11-01T00:00:00.000Z",
                "updatedAt": "2026-11-01T00:00:00.000Z",
                "data": {"reported_by": "anonymous"}
            })))
            .expect(1)
            .mount(&server)
            .await;

        let (status, _, body) = call(
            app(state(&server.uri())),
            Method::POST,
            "/v1/public/incidents",
            None,
            Some(json!({
                "title": "Broken pump",
                "description": "Pump is leaking",
                "category": "utility",
                "contact_info": {"name": "Citizen", "phone_number": "0900"}
            })),
        )
        .await;
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(body["title"], "Broken pump");
        assert_eq!(body["reporter_type"], "citizen");
    }
    #[tokio::test]
    async fn public_asset_lookup_by_code_works_anonymously() {
        let server = MockServer::start().await;
        mount_dataset(
            &server,
            "city-assets",
            "SynapseCity infrastructure assets",
            "CityAsset",
            "Public projection of city infrastructure assets",
            true,
        )
        .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/city-assets/records/A1"))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({"error": {"code": "not_found"}})))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/v1/capabilities/datasets/city-assets/records"))
            .and(query_param("limit", "500"))
            .and(query_param("offset", "0"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "items": [{
                    "id": "a1",
                    "version": 1,
                    "createdAt": "2026-11-01T00:00:00.000Z",
                    "updatedAt": "2026-11-01T00:00:00.000Z",
                    "data": {
                        "id": "a1",
                        "asset_code": "A1",
                        "name": "Pump station",
                        "feature_type": "utility",
                        "feature_code": "pump",
                        "status": "active",
                        "public_visible": true,
                        "geometry": {"type": "Point", "coordinates": [105.8, 21.0]}
                    }
                }],
                "total": 1,
                "limit": 500,
                "offset": 0,
                "nextCursor": null
            })))
            .mount(&server)
            .await;

        let (status, _, body) = call(
            app(state(&server.uri())),
            Method::GET,
            "/v1/public/assets/A1",
            None,
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["asset_code"], "A1");
        assert_eq!(body["qr_code"], "http://localhost/asset/A1");
    }

    #[tokio::test]
    async fn anonymous_public_file_upload_reaches_validation_instead_of_auth() {
        let response = app(state("http://127.0.0.1:1"))
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/v1/public/files")
                    .header("content-type", "image/png")
                    .body(Body::from(vec![1u8, 2, 3]))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        assert_eq!(body["code"], "x_file_name_required");
    }

}

#[cfg(test)]
mod route_family_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Method, Request, StatusCode};
    use axum::Router;
    use http_body_util::BodyExt;
    use serde_json::{json, Value};
    use synapsedx::{Client, Credentials};
    use tower::ServiceExt;

    fn app() -> Router {
        let config = Config::for_test("http://127.0.0.1:1");
        let client = Client::new("http://127.0.0.1:1", Credentials::none()).unwrap();
        Router::new()
            .fallback(dispatch)
            .with_state(AppState::new(config, client))
    }

    fn token() -> String {
        let config = Config::for_test("http://127.0.0.1:1");
        let principal = auth::principal_from_input(
            &config,
            "qa",
            Some("qa@example.com"),
            Some("QA"),
            None,
            auth::ROLE_ADMIN,
        );
        auth::issue_session(&config, principal, false).access_token
    }

    async fn call(method: Method, uri: &str, token: Option<&str>, body: Option<Value>) -> (StatusCode, Value) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(token) = token {
            builder = builder.header("authorization", format!("Bearer {token}"));
        }
        let body = match body {
            Some(value) => {
                builder = builder.header("content-type", "application/json");
                Body::from(serde_json::to_vec(&value).unwrap())
            }
            None => Body::empty(),
        };
        let response = app().oneshot(builder.body(body).unwrap()).await.unwrap();
        let status = response.status();
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, value)
    }

    #[tokio::test]
    async fn remaining_family_validation_and_static_surfaces() {
        let token = token();
        let (status, body) = call(
            Method::GET,
            "/v1/notifications/capabilities",
            Some(&token),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert!(body.get("in_app").is_some());

        let (status, body) = call(
            Method::POST,
            "/v1/geo/coverage",
            Some(&token),
            Some(json!({})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "areas_required");

        let (status, body) = call(
            Method::POST,
            "/v1/ingest/csv",
            Some(&token),
            Some(json!({"filename": "assets.csv", "content": ""})),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["code"], "content_required");
    }

}
