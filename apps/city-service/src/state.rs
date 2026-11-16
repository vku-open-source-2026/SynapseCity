// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared City process state, metrics and rate limiting.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use synapsedx::Client;

use crate::config::Config;

pub struct Metrics {
    started: Instant,
    requests: AtomicU64,
    errors: AtomicU64,
    rate_limited: AtomicU64,
    routes: Mutex<HashMap<String, u64>>,
    durations_ms: Mutex<f64>,
}

impl Metrics {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            requests: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            rate_limited: AtomicU64::new(0),
            routes: Mutex::new(HashMap::new()),
            durations_ms: Mutex::new(0.0),
        }
    }

    pub fn observe(&self, route: &str, duration_ms: f64, status: u16) {
        self.requests.fetch_add(1, Ordering::Relaxed);
        if status >= 500 {
            self.errors.fetch_add(1, Ordering::Relaxed);
        }
        if status == 429 {
            self.rate_limited.fetch_add(1, Ordering::Relaxed);
        }
        let mut routes = self.routes.lock().unwrap_or_else(|poison| poison.into_inner());
        *routes.entry(route.to_string()).or_insert(0) += 1;
        let mut total = self.durations_ms.lock().unwrap_or_else(|poison| poison.into_inner());
        *total += duration_ms;
    }

    pub fn render(&self) -> String {
        let routes = self.routes.lock().unwrap_or_else(|poison| poison.into_inner());
        let total = *self.durations_ms.lock().unwrap_or_else(|poison| poison.into_inner());
        let mut lines = vec![
            "# HELP synapsecity_http_requests_total Total HTTP requests handled by the City service.".into(),
            "# TYPE synapsecity_http_requests_total counter".into(),
            format!("synapsecity_http_requests_total {}", self.requests.load(Ordering::Relaxed)),
            "# HELP synapsecity_http_errors_total Total 5xx responses.".into(),
            "# TYPE synapsecity_http_errors_total counter".into(),
            format!("synapsecity_http_errors_total {}", self.errors.load(Ordering::Relaxed)),
            "# HELP synapsecity_rate_limited_total Total requests rejected by a rate limiter.".into(),
            "# TYPE synapsecity_rate_limited_total counter".into(),
            format!("synapsecity_rate_limited_total {}", self.rate_limited.load(Ordering::Relaxed)),
            "# HELP synapsecity_http_request_duration_ms_sum Sum of request durations in milliseconds.".into(),
            "# TYPE synapsecity_http_request_duration_ms_sum counter".into(),
            format!("synapsecity_http_request_duration_ms_sum {total:.0}"),
        ];
        for (route, count) in routes.iter() {
            let label: String = route
                .chars()
                .map(|ch| if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | '{' | '}' | '-') { ch } else { '_' })
                .collect();
            lines.push(format!(
                "synapsecity_http_route_requests_total{{route=\"{label}\"}} {count}"
            ));
        }
        lines.push("# HELP synapsecity_uptime_seconds Process uptime.".into());
        lines.push("# TYPE synapsecity_uptime_seconds gauge".into());
        lines.push(format!("synapsecity_uptime_seconds {}", self.started.elapsed().as_secs()));
        lines.join("\n") + "\n"
    }
}

pub struct RateLimiter {
    buckets: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn check(&self, name: &str, headers: &HeaderMap, window: Duration, max: u32) -> Option<u64> {
        let key = format!("{name}:{}", client_key(headers));
        let now = Instant::now();
        let mut buckets = self.buckets.lock().unwrap_or_else(|poison| poison.into_inner());
        match buckets.get_mut(&key) {
            Some((count, reset_at)) if *reset_at > now => {
                *count += 1;
                if *count > max {
                    let retry = reset_at.saturating_duration_since(now).as_secs().max(1);
                    return Some(retry);
                }
            }
            _ => {
                buckets.insert(key, (1, now + window));
            }
        }
        if buckets.len() > 10_000 {
            buckets.retain(|_, (_, reset_at)| *reset_at > now);
        }
        None
    }
}

pub fn client_key(headers: &HeaderMap) -> String {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.rsplit(',').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());
    forwarded.unwrap_or_else(|| "unknown".into())
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub tier2: Arc<Client>,
    pub metrics: Arc<Metrics>,
    pub limiter: Arc<RateLimiter>,
    pub ai_status_cache: Arc<Mutex<Option<(Instant, serde_json::Value)>>>,
}

impl AppState {
    pub fn new(config: Config, tier2: Client) -> Self {
        Self {
            config: Arc::new(config),
            tier2: Arc::new(tier2),
            metrics: Arc::new(Metrics::new()),
            limiter: Arc::new(RateLimiter::new()),
            ai_status_cache: Arc::new(Mutex::new(None)),
        }
    }
}
