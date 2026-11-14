// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseCity Tier-3 infrastructure domain service (Rust/Axum).

mod ai;
mod auth;
mod config;
mod domain;
mod error;
mod routes;
mod state;
mod tier2;
mod web;

use std::net::SocketAddr;
use std::time::Duration;

use axum::extract::{Request, State};
use axum::http::header::{HeaderValue, CONTENT_TYPE};
use axum::http::{Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::Router;
use chrono::Utc;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

use crate::config::Config;
use crate::state::AppState;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

fn check_health(port: u16) -> bool {
    use std::io::{Read, Write};
    let Ok(mut stream) = std::net::TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buffer = String::new();
    if stream.read_to_string(&mut buffer).is_err() {
        return false;
    }
    buffer.starts_with("HTTP/1.1 200") || buffer.starts_with("HTTP/1.0 200")
}

#[tokio::main]
async fn main() {
    if std::env::args().any(|argument| argument == "--healthcheck") {
        let port = std::env::var("PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(8083);
        std::process::exit(if check_health(port) { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,synapsecity_city_service=info")),
        )
        .init();

    if let Err(error) = run().await {
        tracing::error!(error = %error, "startup failed");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    let client = config.tier2_client()?;
    let state = AppState::new(config.clone(), client);
    tracing::info!(
        port = config.port,
        tier2 = %config.tier2_url,
        auth_mode = %config.auth_mode,
        "starting SynapseCity Rust service"
    );
    let app = Router::new()
        .fallback(routes::dispatch)
        .layer(middleware::from_fn_with_state(
            state.clone(),
            headers_middleware,
        ))
        .with_state(state);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", config.port)).await?;
    tracing::info!("[synapsecity] Tier-3 API listening on :{}", config.port);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>()).await?;
    Ok(())
}

async fn headers_middleware(
    State(state): State<AppState>,
    mut req: Request,
    next: Next,
) -> Response {
    let started = std::time::Instant::now();
    let path = routes::route_label(req.uri().path());
    let correlation = req
        .headers()
        .get("x-correlation-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    if req.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        add_security_headers(response.headers_mut(), &state, &correlation);
        return response;
    }

    let is_stream = req.uri().path().contains("/download")
        || req.uri().path().contains("/content");
    let mut response = next.run(req).await;
    if !is_stream {
        response.headers_mut().insert(
            CONTENT_TYPE,
            HeaderValue::from_static("application/json; charset=utf-8"),
        );
    }
    add_security_headers(response.headers_mut(), &state, &correlation);
    let duration = started.elapsed().as_secs_f64() * 1000.0;
    state
        .metrics
        .observe(&path, duration, response.status().as_u16());
    response
}

fn add_security_headers(
    headers: &mut axum::http::HeaderMap,
    state: &AppState,
    correlation: &str,
) {
    if let Ok(value) = HeaderValue::from_str(&state.config.cors_origin) {
        headers.insert("access-control-allow-origin", value);
    }
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("authorization,content-type,x-api-key,x-correlation-id,x-file-name,x-filename,x-checksum-sha256,x-file-visibility,x-entity-type,x-entity-id"),
    );
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"),
    );
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    if let Ok(value) = HeaderValue::from_str(correlation) {
        headers.insert("x-correlation-id", value);
    }
}
