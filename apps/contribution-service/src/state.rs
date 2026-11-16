// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Shared application state.

use crate::auth::JwtKeys;
use crate::config::Config;
use crate::ratelimit::RateLimiter;
use crate::storage::Storage;
use std::sync::Arc;

pub struct AppState {
    pub config: Arc<Config>,
    pub storage: Arc<dyn Storage>,
    pub jwt: JwtKeys,
    pub limiter: RateLimiter,
    pub http: reqwest::Client,
}

pub type SharedState = Arc<AppState>;
