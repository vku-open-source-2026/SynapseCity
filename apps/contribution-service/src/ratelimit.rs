// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Small fixed-window rate limiter keyed by client IP and route scope.
//!
//! This mirrors `slowapi`'s default fixed-window behaviour and avoids a
//! dependency on a shared Redis for a single-instance portal.

use crate::error::ApiError;
use crate::state::SharedState;
use axum::extract::{ConnectInfo, FromRequestParts};
use axum::http::header::HeaderName;
use axum::http::request::Parts;
use dashmap::DashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

const FORWARDED_FOR: HeaderName = HeaderName::from_static("x-forwarded-for");

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    scope: &'static str,
    ip: String,
}

#[derive(Debug, Clone, Copy)]
struct Window {
    started: Instant,
    count: u32,
}

#[derive(Default)]
pub struct RateLimiter {
    windows: DashMap<Key, Window>,
}

impl RateLimiter {
    pub fn new() -> Self {
        Self::default()
    }

    /// Return `true` when the request is allowed.
    pub fn check(&self, scope: &'static str, ip: &str, limit: u32, window: Duration) -> bool {
        self.check_at(scope, ip, limit, window, Instant::now())
    }

    /// Testable variant with an explicit clock.
    pub fn check_at(
        &self,
        scope: &'static str,
        ip: &str,
        limit: u32,
        window: Duration,
        now: Instant,
    ) -> bool {
        if self.windows.len() > 4_096 {
            self.windows
                .retain(|_, entry| now.duration_since(entry.started) < window * 2);
        }

        let key = Key {
            scope,
            ip: ip.to_string(),
        };
        let mut entry = self.windows.entry(key).or_insert(Window {
            started: now,
            count: 0,
        });
        if now.duration_since(entry.started) >= window {
            entry.started = now;
            entry.count = 0;
        }
        if entry.count >= limit {
            return false;
        }
        entry.count += 1;
        true
    }
}

/// Enforce a 60-second fixed window for a route scope.
pub fn enforce(
    state: &SharedState,
    scope: &'static str,
    ip: &str,
    limit: u32,
) -> Result<(), ApiError> {
    if state
        .limiter
        .check(scope, ip, limit, Duration::from_secs(60))
    {
        Ok(())
    } else {
        Err(ApiError::too_many_requests("Rate limit exceeded"))
    }
}

/// Client IP, preferring `X-Forwarded-For` when the service is behind the
/// trusted TLS edge.
#[derive(Debug, Clone)]
pub struct ClientIp(pub String);

impl FromRequestParts<SharedState> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &SharedState,
    ) -> Result<Self, Self::Rejection> {
        if state.config.trust_proxy_headers {
            if let Some(value) = parts
                .headers
                .get(&FORWARDED_FOR)
                .and_then(|value| value.to_str().ok())
            {
                if let Some(first) = value.split(',').next() {
                    let first = first.trim();
                    if !first.is_empty() {
                        return Ok(ClientIp(first.to_string()));
                    }
                }
            }
        }

        if let Some(connect) = parts.extensions.get::<ConnectInfo<SocketAddr>>() {
            return Ok(ClientIp(connect.0.ip().to_string()));
        }
        Ok(ClientIp("unknown".to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_window_allows_then_blocks() {
        let limiter = RateLimiter::new();
        let now = Instant::now();
        for _ in 0..5 {
            assert!(limiter.check_at("login", "1.2.3.4", 5, Duration::from_secs(60), now));
        }
        assert!(!limiter.check_at("login", "1.2.3.4", 5, Duration::from_secs(60), now));
        assert!(limiter.check_at(
            "login",
            "1.2.3.4",
            5,
            Duration::from_secs(60),
            now + Duration::from_secs(61)
        ));
    }

    #[test]
    fn scopes_are_independent() {
        let limiter = RateLimiter::new();
        let now = Instant::now();
        assert!(limiter.check_at("login", "1.2.3.4", 1, Duration::from_secs(60), now));
        assert!(!limiter.check_at("login", "1.2.3.4", 1, Duration::from_secs(60), now));
        assert!(limiter.check_at("refresh", "1.2.3.4", 1, Duration::from_secs(60), now));
    }
}
