// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Rust backend for the SynapseCity contribution portal.

use axum::extract::{Request, State};
use axum::http::header::{
    HeaderValue, STRICT_TRANSPORT_SECURITY, X_CONTENT_TYPE_OPTIONS, X_FRAME_OPTIONS,
    X_XSS_PROTECTION,
};
use axum::http::{HeaderName, Method};
use axum::middleware::{self, Next};
use axum::response::Response;
use contribution_backend::{auth, config::Config, ratelimit, routes, state, storage};
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    if std::env::args().any(|arg| arg == "--healthcheck") {
        std::process::exit(if healthcheck() { 0 } else { 1 });
    }

    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("info,contribution_backend=info")),
        )
        .init();

    if let Err(error) = run().await {
        tracing::error!(error = %error, "startup failed");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    tracing::info!(
        bind = %config.bind,
        environment = %config.environment,
        storage = ?config.storage_backend,
        "starting contribution backend"
    );

    let storage = storage::from_config(&config).await?;
    let jwt = auth::JwtKeys::new(
        &config.jwt_secret,
        config.access_token_expire_minutes,
        config.refresh_token_expire_days,
    );
    let http = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .build()?;

    let state: state::SharedState = Arc::new(state::AppState {
        config: Arc::new(config.clone()),
        storage,
        jwt,
        limiter: ratelimit::RateLimiter::new(),
        http,
    });

    let cors = build_cors(&config)?;
    let app = routes::router(state.clone())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers,
        ))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(RequestBodyLimitLayer::new(config.body_limit_bytes))
        .layer(TimeoutLayer::with_status_code(
            axum::http::StatusCode::REQUEST_TIMEOUT,
            config.request_timeout,
        ));

    let listener = TcpListener::bind(&config.bind).await?;
    tracing::info!(bind = %config.bind, "listening");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    Ok(())
}

fn build_cors(config: &Config) -> Result<CorsLayer, Box<dyn std::error::Error>> {
    let origins = config
        .cors_origins
        .iter()
        .map(|origin| HeaderValue::from_str(origin))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CorsLayer::new()
        .allow_origin(AllowOrigin::list(origins))
        .allow_credentials(config.cors_allow_credentials())
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            HeaderName::from_static("x-requested-with"),
        ]))
}

async fn security_headers(
    State(state): State<state::SharedState>,
    request: Request,
    next: Next,
) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    headers.insert(X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(X_XSS_PROTECTION, HeaderValue::from_static("1; mode=block"));
    if state.config.production() {
        headers.insert(
            STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }
    response
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received");
}

/// Container healthcheck: GET /health over loopback without pulling in curl.
fn healthcheck() -> bool {
    use std::io::{Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};

    let bind = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8000".to_string());
    let port = bind.rsplit(':').next().unwrap_or("8000");
    let address = format!("127.0.0.1:{port}");
    let Ok(mut addresses) = address.to_socket_addrs() else {
        return false;
    };
    let Some(address) = addresses.next() else {
        return false;
    };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut buffer = [0u8; 64];
    let Ok(read) = stream.read(&mut buffer) else {
        return false;
    };
    String::from_utf8_lossy(&buffer[..read]).starts_with("HTTP/1.1 200")
}
