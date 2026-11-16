// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Rust backend for the SynapseCity contribution portal.

#![forbid(unsafe_code)]
// Thin wrappers intentionally mirror the HTTP API's argument lists and keep the
// full platform error body on the error type for callers to inspect.
#![allow(clippy::too_many_arguments)]
#![allow(clippy::result_large_err)]

pub mod auth;
pub mod config;
pub mod error;
pub mod models;
pub mod ratelimit;
pub mod routes;
pub mod state;
pub mod storage;
pub mod util;
