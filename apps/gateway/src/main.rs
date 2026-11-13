// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseCity public gateway in Rust.
//!
//! Enforces product boundary rules, proxies API traffic to city-service
//! and SPA traffic to the console.

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::header::HeaderValue;
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use regex::Regex;
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use url::Url;
use uuid::Uuid;

const BOUNDARY_PRODUCT: &str = "synapsecity";

const OWNED_V1_PREFIXES: &[&str] = &[
    "/v1/city",
    "/v1/auth",
    "/v1/assets",
    "/v1/incidents",
    "/v1/maintenance",
    "/v1/preventive-maintenance",
    "/v1/iot",
    "/v1/alerts",
    "/v1/budgets",
    "/v1/reports",
    "/v1/notifications",
    "/v1/files",
    "/v1/users",
    "/v1/geofences",
    "/v1/geo",
    "/v1/ingest",
    "/v1/map",
    "/v1/ai",
    "/v1/public/assets",
    "/v1/public/incidents",
    "/v1/public/files",
];

const PUBLIC_V1_PREFIXES: &[&str] = &[
    "/v1/auth",
    "/v1/city",
    "/v1/map",
    "/v1/public/assets",
    "/v1/public/incidents",
    "/v1/public/files",
];

const PUBLIC_AI_PATHS: &[&str] = &["/v1/ai/status", "/v1/ai/chat"];

const FORWARDED_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "x-correlation-id",
    "x-file-name",
    "x-filename",
    "x-checksum-sha256",
    "x-file-visibility",
    "x-entity-type",
    "x-entity-id",
    "x-request-id",
];

const FORWARDED_RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "cache-control",
    "x-total-count",
    "etag",
    "x-dataset-version",
    "content-disposition",
];

#[derive(Clone)]
pub struct AppState {
    pub city_service_url: String,
    pub console_url: String,
    pub cors_origin: String,
    pub upload_limit: usize,
    pub client: reqwest::Client,
    pub correlation_regex: Arc<Regex>,
}

#[derive(Clone, Debug)]
pub struct CorrelationId(pub String);

fn decoded_path(value: &str) -> Option<String> {
    let mut current = value.to_string();
    for _ in 0..3 {
        let decoded = match percent_encoding::percent_decode_str(&current).decode_utf8() {
            Ok(cow) => cow.into_owned(),
            Err(_) => return None,
        };
        if decoded == current {
            return Some(current);
        }
        current = decoded;
    }
    Some(current)
}

pub fn canonical_v1_path(raw: &str) -> Option<String> {
    let without_query = raw.split('?').next().unwrap_or("/").split('#').next().unwrap_or("/");
    let decoded = decoded_path(without_query)?;
    let mut segments = Vec::new();
    let sanitized = decoded.replace('\\', "/");
    for segment in sanitized.split('/') {
        if segment.is_empty() || segment == "." {
            continue;
        }
        if segment == ".." {
            segments.pop();
            continue;
        }
        segments.push(segment);
    }
    Some(format!("/{}", segments.join("/")))
}

pub fn normalize_v1_path(raw: &str) -> String {
    match canonical_v1_path(raw) {
        None => "/__invalid_path__".to_string(),
        Some(canonical) => {
            let lower_segments: Vec<String> = canonical
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_ascii_lowercase())
                .collect();
            format!("/{}", lower_segments.join("/"))
        }
    }
}

fn within(path: &str, prefix: &str) -> bool {
    path == prefix || path.starts_with(&format!("{prefix}/"))
}

pub fn is_owned_v1_path(raw: &str) -> bool {
    let path = normalize_v1_path(raw);
    OWNED_V1_PREFIXES.iter().any(|prefix| within(&path, prefix))
}

pub fn is_public_v1_path(raw: &str) -> bool {
    let path = normalize_v1_path(raw);
    PUBLIC_AI_PATHS.contains(&path.as_str())
        || PUBLIC_V1_PREFIXES.iter().any(|prefix| within(&path, prefix))
}

fn assert_upstream(value: &str, var_name: &str, allow_local: bool) -> Result<String, String> {
    let url = Url::parse(value).map_err(|e| format!("{var_name} is not an absolute URL: {value} ({e})"))?;
    let host = url.host_str().unwrap_or("");
    if (host.eq_ignore_ascii_case("localhost") || host == "127.0.0.1" || host == "::1") && !allow_local {
        return Err(format!("{var_name} may not point to localhost"));
    }
    Ok(value.trim_end_matches('/').to_string())
}

fn not_found_response() -> Response {
    (
        StatusCode::NOT_FOUND,
        [("content-type", "application/json")],
        json!({
            "error": "not_found",
            "product": BOUNDARY_PRODUCT
        })
        .to_string(),
    )
        .into_response()
}

pub fn create_app(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health_handler))
        .route("/ready", get(ready_handler))
        .fallback(gateway_dispatcher)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            cors_and_headers_middleware,
        ))
        .with_state(state)
}

async fn cors_and_headers_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let incoming_corr = req
        .headers()
        .get("x-correlation-id")
        .and_then(|v| v.to_str().ok());

    let corr_id = match incoming_corr {
        Some(val) if state.correlation_regex.is_match(val) => val.to_string(),
        _ => Uuid::new_v4().to_string(),
    };

    req.extensions_mut().insert(CorrelationId(corr_id.clone()));

    if req.method() == Method::OPTIONS {
        let mut res = StatusCode::NO_CONTENT.into_response();
        let headers = res.headers_mut();
        if let Ok(v) = HeaderValue::from_str(&state.cors_origin) {
            headers.insert("access-control-allow-origin", v);
        }
        headers.insert(
            "access-control-allow-headers",
            HeaderValue::from_static("authorization,content-type,x-api-key,x-correlation-id"),
        );
        headers.insert(
            "access-control-allow-methods",
            HeaderValue::from_static("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"),
        );
        headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
        headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
        headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
        headers.insert(
            "strict-transport-security",
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
        if let Ok(v) = HeaderValue::from_str(&corr_id) {
            headers.insert("x-correlation-id", v);
        }
        return res;
    }

    let mut res = next.run(req).await;
    let headers = res.headers_mut();
    if let Ok(v) = HeaderValue::from_str(&state.cors_origin) {
        headers.insert("access-control-allow-origin", v);
    }
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("authorization,content-type,x-api-key,x-correlation-id"),
    );
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert(
        "strict-transport-security",
        HeaderValue::from_static("max-age=31536000; includeSubDomains"),
    );
    if let Ok(v) = HeaderValue::from_str(&corr_id) {
        headers.insert("x-correlation-id", v);
    }

    res
}

async fn health_handler(State(state): State<AppState>) -> Response {
    let url = format!("{}/health", state.city_service_url);
    match state.client.get(&url).timeout(Duration::from_secs(10)).send().await {
        Ok(res) => {
            let is_ok = res.status().is_success();
            let text = res.text().await.unwrap_or_default();
            let upstream_body: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|_| json!({ "raw": text }));

            let body = json!({
                "status": if is_ok { "ok" } else { "degraded" },
                "service": "synapsecity-gateway",
                "upstream": upstream_body
            });
            let code = if is_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
            (code, [("content-type", "application/json")], body.to_string()).into_response()
        }
        Err(err) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "application/json")],
            json!({
                "status": "degraded",
                "service": "synapsecity-gateway",
                "error": err.to_string()
            })
            .to_string(),
        )
            .into_response(),
    }
}

async fn ready_handler(State(state): State<AppState>) -> Response {
    let url = format!("{}/ready", state.city_service_url);
    match state.client.get(&url).timeout(Duration::from_secs(10)).send().await {
        Ok(res) => {
            let is_ok = res.status().is_success();
            let text = res.text().await.unwrap_or_default();
            let upstream_body: serde_json::Value = serde_json::from_str(&text)
                .unwrap_or_else(|_| json!({ "raw": text }));

            let body = json!({
                "status": if is_ok { "ready" } else { "degraded" },
                "service": "synapsecity-gateway",
                "upstream": upstream_body
            });
            let code = if is_ok { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };
            (code, [("content-type", "application/json")], body.to_string()).into_response()
        }
        Err(err) => (
            StatusCode::SERVICE_UNAVAILABLE,
            [("content-type", "application/json")],
            json!({
                "status": "degraded",
                "service": "synapsecity-gateway",
                "error": err.to_string()
            })
            .to_string(),
        )
            .into_response(),
    }
}

async fn gateway_dispatcher(State(state): State<AppState>, req: Request) -> Response {
    let corr_id = req
        .extensions()
        .get::<CorrelationId>()
        .map(|c| c.0.clone())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    let raw_uri = req.uri().to_string();
    let norm = normalize_v1_path(&raw_uri);

    if norm == "/__invalid_path__" {
        return not_found_response();
    }

    if norm == "/v1" || norm.starts_with("/v1/") {
        if !is_owned_v1_path(&raw_uri) {
            return not_found_response();
        }

        let raw_path = raw_uri.split('?').next().unwrap_or("/");
        let raw_starts_v1 = raw_path.to_ascii_lowercase().starts_with("/v1/")
            || raw_path.eq_ignore_ascii_case("/v1");
        let norm_starts_v1 = norm.starts_with("/v1/") || norm == "/v1";
        if !raw_starts_v1 && norm_starts_v1 {
            return not_found_response();
        }

        let has_auth = req.headers().contains_key("authorization");
        if !is_public_v1_path(&raw_uri) && !has_auth {
            return (
                StatusCode::UNAUTHORIZED,
                [("content-type", "application/json")],
                json!({
                    "error": "unauthorized",
                    "detail": "authentication_required",
                    "product": BOUNDARY_PRODUCT
                })
                .to_string(),
            )
                .into_response();
        }

        // Canonicalize path for upstream proxy
        let canonical = canonical_v1_path(&raw_uri).unwrap_or_else(|| norm.clone());
        let query = match raw_uri.find('?') {
            Some(idx) => &raw_uri[idx..],
            None => "",
        };
        let upstream_path = format!("{}{}", canonical, query);

        return proxy_to_city(state, req, &upstream_path, &corr_id).await;
    }

    // Non-/v1 surface: only GET and HEAD to console
    if req.method() != Method::GET && req.method() != Method::HEAD {
        return not_found_response();
    }

    if let Some(decoded) = canonical_v1_path(&raw_uri) {
        if decoded.to_ascii_lowercase().starts_with("/v1/") || decoded.eq_ignore_ascii_case("/v1") {
            return not_found_response();
        }
    }

    proxy_to_console(state, req, &raw_uri).await
}

async fn proxy_to_city(
    state: AppState,
    req: Request,
    upstream_path: &str,
    corr_id: &str,
) -> Response {
    let method = req.method().clone();
    let target_url = format!("{}{}", state.city_service_url, upstream_path);

    let mut upstream_req = state.client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &target_url,
    );

    // Forward request headers
    for &h_name in FORWARDED_REQUEST_HEADERS {
        if let Some(h_val) = req.headers().get(h_name) {
            upstream_req = upstream_req.header(h_name, h_val);
        }
    }
    upstream_req = upstream_req.header("x-correlation-id", corr_id);

    if let Some(fwd) = req.headers().get("x-forwarded-for") {
        upstream_req = upstream_req.header("x-forwarded-for", fwd);
    }

    let is_body_method = method != Method::GET && method != Method::HEAD;
    let req_content_type = req
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if is_body_method {
        let body_bytes = match axum::body::to_bytes(req.into_body(), state.upload_limit).await {
            Ok(b) => b,
            Err(e) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    [("content-type", "application/json")],
                    json!({
                        "error": "payload_too_large",
                        "message": e.to_string()
                    })
                    .to_string(),
                )
                    .into_response();
            }
        };

        if let Some(ct) = req_content_type {
            upstream_req = upstream_req.header("content-type", ct);
        } else if !body_bytes.is_empty() {
            upstream_req = upstream_req.header("content-type", "application/octet-stream");
        } else {
            upstream_req = upstream_req.header("content-type", "application/json");
        }

        if !body_bytes.is_empty() {
            upstream_req = upstream_req.body(body_bytes);
        } else {
            upstream_req = upstream_req.body("{}");
        }
    }

    match upstream_req.send().await {
        Ok(res) => {
            let upstream_status = res.status();
            let mut response_builder = Response::builder().status(
                StatusCode::from_u16(upstream_status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            );

            let res_headers = response_builder.headers_mut().unwrap();
            for (name, value) in res.headers() {
                let name_lower = name.as_str().to_ascii_lowercase();
                if FORWARDED_RESPONSE_HEADERS.contains(&name_lower.as_str()) {
                    res_headers.insert(name.clone(), value.clone());
                }
            }

            if upstream_status == reqwest::StatusCode::NO_CONTENT
                || upstream_status == reqwest::StatusCode::NOT_MODIFIED
            {
                return response_builder.body(Body::empty()).unwrap();
            }

            let body_bytes = res.bytes().await.unwrap_or_else(|_| Bytes::new());
            res_headers.insert("content-length", HeaderValue::from(body_bytes.len()));
            response_builder.body(Body::from(body_bytes)).unwrap()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            [("content-type", "application/json")],
            json!({
                "error": "city_upstream_unavailable",
                "message": err.to_string()
            })
            .to_string(),
        )
            .into_response(),
    }
}

async fn proxy_to_console(state: AppState, req: Request, raw_uri: &str) -> Response {
    let method = req.method().clone();
    let target_url = format!("{}{}", state.console_url, raw_uri);

    let accept = req
        .headers()
        .get("accept")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("text/html");

    let upstream_req = state
        .client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            &target_url,
        )
        .header("accept", accept);

    match upstream_req.send().await {
        Ok(res) => {
            let upstream_status = res.status();
            let mut response_builder = Response::builder().status(
                StatusCode::from_u16(upstream_status.as_u16()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
            );

            let res_headers = response_builder.headers_mut().unwrap();
            if let Some(ct) = res.headers().get("content-type") {
                res_headers.insert("content-type", ct.clone());
            }

            if method == Method::HEAD {
                return response_builder.body(Body::empty()).unwrap();
            }

            let body_bytes = res.bytes().await.unwrap_or_else(|_| Bytes::new());
            response_builder.body(Body::from(body_bytes)).unwrap()
        }
        Err(err) => (
            StatusCode::BAD_GATEWAY,
            [("content-type", "application/json")],
            json!({
                "error": "city_upstream_unavailable",
                "message": err.to_string()
            })
            .to_string(),
        )
            .into_response(),
    }
}

async fn check_health_cli(port: u16) -> bool {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap();
    let url = format!("http://127.0.0.1:{port}/health");
    match client.get(&url).send().await {
        Ok(res) => res.status().is_success(),
        Err(_) => false,
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let port = std::env::var("PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);

    if std::env::args().any(|arg| arg == "--healthcheck") {
        let ok = check_health_cli(port).await;
        std::process::exit(if ok { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info,synapsecity_gateway=info")),
        )
        .init();

    let allow_local = std::env::var("ALLOW_LOCAL_DEPENDENCIES")
        .map(|v| v == "true")
        .unwrap_or(false);

    let city_service_url = assert_upstream(
        &std::env::var("CITY_SERVICE_URL").unwrap_or_else(|_| "http://city-service:8083".to_string()),
        "CITY_SERVICE_URL",
        allow_local,
    )?;

    let console_url = assert_upstream(
        &std::env::var("CONSOLE_URL").unwrap_or_else(|_| "http://console:80".to_string()),
        "CONSOLE_URL",
        allow_local,
    )?;

    let cors_origin = std::env::var("CORS_ORIGIN").unwrap_or_else(|_| "https://synapsecity.sbs".to_string());
    let upload_limit = std::env::var("GATEWAY_UPLOAD_LIMIT_BYTES")
        .ok()
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(26 * 1024 * 1024);

    let correlation_regex = Arc::new(Regex::new(r"^[A-Za-z0-9_.:-]{1,128}$")?);

    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;

    let state = AppState {
        city_service_url: city_service_url.clone(),
        console_url: console_url.clone(),
        cors_origin,
        upload_limit,
        client,
        correlation_regex,
    };

    let app = create_app(state);

    let addr = SocketAddr::from(([0, 0, 0, 0], port));
    tracing::info!(
        "[synapsecity-gateway] listening on :{}; upstream={}; console={}",
        port,
        city_service_url,
        console_url
    );
    let listener = TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_path_normalization_and_ownership() {
        assert_eq!(normalize_v1_path("/v1/EMERGENCY/"), "/v1/emergency");
        assert_eq!(normalize_v1_path("/v1//assets///1"), "/v1/assets/1");
        assert_eq!(normalize_v1_path("/v1/assets/../emergency"), "/v1/emergency");
        assert_eq!(normalize_v1_path("/v1/%61ssets/1"), "/v1/assets/1");
        assert_eq!(canonical_v1_path("/%76%31/Assets/AbC-1"), Some("/v1/Assets/AbC-1".to_string()));

        for owned in &[
            "/v1/city",
            "/v1/auth/login",
            "/v1/assets",
            "/v1/assets/1",
            "/v1/preventive-maintenance",
            "/v1/public/assets",
            "/v1/public/incidents",
            "/v1/ai",
            "/v1/ASSETS/",
        ] {
            assert!(is_owned_v1_path(owned), "{owned} must be owned by SynapseCity");
        }

        for foreign in &[
            "/v1/emergency",
            "/v1/hazards/recent",
            "/v1/sos",
            "/v1/unknown",
            "/v1/public/unknown",
        ] {
            assert!(!is_owned_v1_path(foreign), "{foreign} must not be owned by SynapseCity");
        }

        for anonymous in &[
            "/v1/public/assets",
            "/v1/public/incidents/1",
            "/v1/auth/login",
            "/v1/city",
            "/v1/map/config",
            "/v1/map/tiles/1/2/3.png",
            "/v1/ai/status",
            "/v1/ai/chat",
        ] {
            assert!(is_public_v1_path(anonymous), "{anonymous} must stay anonymous");
        }

        for operator in &[
            "/v1/assets",
            "/v1/users",
            "/v1/reports/1/download",
            "/v1/ai/decision",
        ] {
            assert!(!is_public_v1_path(operator), "{operator} must require a session");
        }
    }
}

