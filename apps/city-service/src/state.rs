// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared City process state, metrics and rate limiting.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use std::net::SocketAddr;

use axum::extract::ConnectInfo;
use serde_json::Value;
use sha2::{Digest, Sha256};
use synapsedx::Client;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::config::Config;

pub(crate) const OTHER_ROUTE_LABEL: &str = "/__other__";
const MAX_ROUTE_LABELS: usize = 256;

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
        let mut routes = self
            .routes
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let count = if let Some(count) = routes.get_mut(route) {
            count
        } else if routes.len() < MAX_ROUTE_LABELS - 1 {
            routes.entry(route.to_string()).or_insert(0)
        } else {
            // Reserve the final slot for every unknown/overflow route so a
            // request flood cannot grow the HashMap or metrics output forever.
            routes.entry(OTHER_ROUTE_LABEL.to_string()).or_insert(0)
        };
        *count += 1;
        let mut total = self
            .durations_ms
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        *total += duration_ms;
    }

    pub fn render(&self) -> String {
        let routes = self
            .routes
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        let total = *self
            .durations_ms
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
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
                .map(|ch| {
                    if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | '{' | '}' | '-')
                    {
                        ch
                    } else {
                        '_'
                    }
                })
                .collect();
            lines.push(format!(
                "synapsecity_http_route_requests_total{{route=\"{label}\"}} {count}"
            ));
        }
        lines.push("# HELP synapsecity_uptime_seconds Process uptime.".into());
        lines.push("# TYPE synapsecity_uptime_seconds gauge".into());
        lines.push(format!(
            "synapsecity_uptime_seconds {}",
            self.started.elapsed().as_secs()
        ));
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

    pub fn check(
        &self,
        name: &str,
        headers: &HeaderMap,
        peer: Option<SocketAddr>,
        window: Duration,
        max: u32,
    ) -> Option<u64> {
        let key = format!("{name}:{}", client_key(headers, peer));
        let now = Instant::now();
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
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

/// Per-caller key for rate limiting. The public edge (gateway + nginx) appends
/// the TCP peer to `x-forwarded-for`, so the LAST entry is the trusted one.
/// When the header is absent (direct service calls, tests) fall back to the
/// socket peer address instead of lumping every caller into "unknown".
pub fn client_key(headers: &HeaderMap, peer: Option<SocketAddr>) -> String {
    let forwarded = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.rsplit(',').next().unwrap_or(value).trim().to_string())
        .filter(|value| !value.is_empty());
    if let Some(address) = forwarded {
        return address;
    }
    if let Some(peer) = peer {
        return peer.ip().to_string();
    }
    // Last resort for in-process tests without a peer; never a production path
    // because axum always provides the socket address.
    if let Some(real) = headers
        .get("x-real-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return real.to_string();
    }
    "unknown".into()
}

/// Extract the TCP peer address injected by `into_make_service_with_connect_info`.
pub fn peer_addr(req: &axum::extract::Request) -> Option<SocketAddr> {
    req.extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0)
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub tier2: Arc<Client>,
    pub metrics: Arc<Metrics>,
    pub limiter: Arc<RateLimiter>,
    pub ai_status_cache: Arc<Mutex<Option<(Instant, serde_json::Value)>>>,
    pub idempotency: Arc<Mutex<IdempotencyCache>>,
}

pub type IdempotencyCache = HashMap<String, (Instant, Arc<AsyncMutex<IdempotencyEntry>>)>;

impl AppState {
    pub fn new(config: Config, tier2: Client) -> Self {
        Self {
            config: Arc::new(config),
            tier2: Arc::new(tier2),
            metrics: Arc::new(Metrics::new()),
            limiter: Arc::new(RateLimiter::new()),
            ai_status_cache: Arc::new(Mutex::new(None)),
            idempotency: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

/// Process-local Idempotency-Key cache (24h TTL) for Tier-3 writes. Tier-2 has
/// no native upsert, so retries of incidents/maintenance/budget/iot-batch creates
/// would otherwise duplicate records. Entries are scoped to a caller, method and
/// route, fingerprint the request body, and hold a per-scope singleflight lock.
/// This is a process-local safety net, not a replacement database; follow-up is
/// a Tier-2 idempotent create/upsert (see README "Abuse controls").
pub const IDEMPOTENCY_TTL: Duration = Duration::from_secs(24 * 3600);
const IDEMPOTENCY_MAX_ENTRIES: usize = 10_000;

#[derive(Debug)]
pub struct IdempotencyEntry {
    pub body_hash: String,
    pub value: Option<Value>,
    pub expires: Instant,
}

impl IdempotencyEntry {
    pub fn remember(&mut self, value: Value) {
        self.value = Some(value);
        self.expires = Instant::now() + IDEMPOTENCY_TTL;
    }
}

pub type IdempotencyGuard = OwnedMutexGuard<IdempotencyEntry>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IdempotencyBodyMismatch;

pub fn idempotency_key(headers: &HeaderMap) -> Option<String> {
    headers
        .get("idempotency-key")
        .or_else(|| headers.get("x-idempotency-key"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 256)
        .map(str::to_string)
}

/// Length-prefix each component before hashing so ambiguous separators cannot
/// make two different caller/route scopes collide. The raw key is never logged.
pub fn idempotency_scope(key: &str, subject: &str, method: &str, route: &str) -> String {
    let mut hasher = Sha256::new();
    for component in [key, subject, method, route] {
        hasher.update((component.len() as u64).to_be_bytes());
        hasher.update(component.as_bytes());
    }
    hex::encode(hasher.finalize())
}

pub fn idempotency_body_hash(body: &Value) -> String {
    let bytes = serde_json::to_vec(body).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

/// Acquire the singleflight lock for a scoped key. Concurrent identical retries
/// wait here; after the first request stores its response they replay it. A
/// retry with a different body in the same caller/method/route scope is rejected
/// instead of silently creating a second record.
pub async fn idempotency_begin(
    state: &AppState,
    scope: String,
    body_hash: String,
) -> Result<(IdempotencyGuard, Option<Value>), IdempotencyBodyMismatch> {
    let now = Instant::now();
    let entry = {
        let mut cache = state
            .idempotency
            .lock()
            .unwrap_or_else(|poison| poison.into_inner());
        cache.retain(|_, (expires, _)| *expires > now);
        if cache.len() >= IDEMPOTENCY_MAX_ENTRIES && !cache.contains_key(&scope) {
            if let Some(oldest) = cache
                .iter()
                .min_by_key(|(_, (expires, _))| *expires)
                .map(|(key, _)| key.clone())
            {
                cache.remove(&oldest);
            }
        }
        cache
            .entry(scope)
            .or_insert_with(|| {
                (
                    now + IDEMPOTENCY_TTL,
                    Arc::new(AsyncMutex::new(IdempotencyEntry {
                        body_hash: body_hash.clone(),
                        value: None,
                        expires: now + IDEMPOTENCY_TTL,
                    })),
                )
            })
            .1
            .clone()
    };
    let mut guard = entry.lock_owned().await;
    if guard.expires <= now {
        guard.body_hash = body_hash.clone();
        guard.value = None;
        guard.expires = now + IDEMPOTENCY_TTL;
    }
    if guard.body_hash != body_hash {
        return Err(IdempotencyBodyMismatch);
    }
    let replay = guard.value.clone();
    Ok((guard, replay))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Config;
    use serde_json::json;
    use synapsedx::{Client, Credentials};

    #[tokio::test]
    async fn identical_concurrent_retries_share_one_singleflight_result() {
        let state = AppState::new(
            Config::for_test("http://127.0.0.1:1"),
            Client::new("http://127.0.0.1:1", Credentials::none()).unwrap(),
        );
        let scope = idempotency_scope("key", "user-1", "POST", "/v1/maintenance");
        let body_hash = idempotency_body_hash(&json!({ "title": "Repair" }));
        let (mut first, replay) = idempotency_begin(&state, scope.clone(), body_hash.clone())
            .await
            .unwrap();
        assert!(replay.is_none());
        let retry_state = state.clone();
        let retry =
            tokio::spawn(async move { idempotency_begin(&retry_state, scope, body_hash).await });
        tokio::task::yield_now().await;
        assert!(!retry.is_finished(), "retry must wait for the first write");
        first.remember(json!({ "id": "m1" }));
        drop(first);
        let (_, replay) = retry.await.unwrap().unwrap();
        assert_eq!(replay, Some(json!({ "id": "m1" })));
    }

    fn route_series_count(rendered: &str) -> usize {
        rendered
            .lines()
            .filter(|line| line.starts_with("synapsecity_http_route_requests_total{"))
            .count()
    }

    #[test]
    fn unique_record_ids_share_one_bounded_metric_label() {
        let metrics = Metrics::new();
        for id in 0..5_000 {
            let path = format!("/v1/assets/random-{id}?ignored={id}");
            let route = crate::routes::route_label(&path);
            assert_eq!(route, "/v1/assets/{id}");
            metrics.observe(&route, 1.0, 401);
        }
        let rendered = metrics.render();
        assert_eq!(route_series_count(&rendered), 1);
        assert!(rendered
            .contains("synapsecity_http_route_requests_total{route=\"/v1/assets/{id}\"} 5000"));
        assert_eq!(
            crate::routes::route_label("/v1/auth/arbitrary-path"),
            "/v1/auth/{path}"
        );
        assert_eq!(
            crate::routes::route_label("/v1/notifications/unread-count"),
            "/v1/notifications/unread-count"
        );
    }

    #[test]
    fn unknown_route_labels_overflow_into_one_capped_series() {
        let metrics = Metrics::new();
        for id in 0..(MAX_ROUTE_LABELS + 100) {
            metrics.observe(&format!("/untrusted/{id}"), 1.0, 404);
        }
        let rendered = metrics.render();
        assert_eq!(route_series_count(&rendered), MAX_ROUTE_LABELS);
        assert!(rendered.contains(&format!(
            "synapsecity_http_route_requests_total{{route=\"{OTHER_ROUTE_LABEL}\"}} 101"
        )));
    }

    #[test]
    fn forwarded_clients_have_independent_rate_limit_buckets() {
        let limiter = RateLimiter::new();
        let mut first = HeaderMap::new();
        first.insert(
            "x-forwarded-for",
            axum::http::HeaderValue::from_static("198.51.100.10"),
        );
        let mut second = HeaderMap::new();
        second.insert(
            "x-forwarded-for",
            axum::http::HeaderValue::from_static("198.51.100.11"),
        );
        let window = Duration::from_secs(60);

        assert_eq!(
            limiter.check("public-report", &first, None, window, 1),
            None
        );
        assert_eq!(
            limiter.check("public-report", &second, None, window, 1),
            None
        );
        assert!(limiter
            .check("public-report", &first, None, window, 1)
            .is_some());
    }
}
