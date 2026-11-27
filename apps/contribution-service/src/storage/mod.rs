// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Persistence facade. Production uses Tier-2 (SynapseDX) datasets/records;
//! `base` (direct Tier-1) is a legacy fallback kept for migration/rollback,
//! and `json` is an explicit development-only fallback.

mod base;
mod dx;
mod json;

pub use base::BaseStorage;
pub use dx::{DxStorage, FEATURES_DATASET, SOS_DATASET, SUBMISSIONS_DATASET};
pub use json::JsonStorage;

use crate::config::{Config, StorageBackend};
use crate::error::ApiError;
use async_trait::async_trait;
use serde_json::Value;
use std::sync::Arc;

pub const FEATURES: &str = "contribution_features";
pub const SUBMISSIONS: &str = "contribution_submissions";
pub const SOS_REPORTS: &str = "contribution_sos_reports";

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("SynapseBase error: {0}")]
    Synapse(Box<synapseone::Error>),
    #[error("Tier-2 error: {0}")]
    Tier2(Box<synapsedx::Error>),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}

impl From<synapseone::Error> for StorageError {
    fn from(error: synapseone::Error) -> Self {
        Self::Synapse(Box::new(error))
    }
}

impl From<synapsedx::Error> for StorageError {
    fn from(error: synapsedx::Error) -> Self {
        Self::Tier2(Box::new(error))
    }
}

impl StorageError {
    /// Whether retrying the same logical operation may succeed. A network error
    /// is ambiguous: callers must check for a committed record before retrying.
    pub fn is_retryable(&self) -> bool {
        match self {
            Self::Tier2(error) => match error.as_ref() {
                synapsedx::Error::Network { .. } => true,
                synapsedx::Error::Api { status, .. } => {
                    matches!(status, 429 | 500 | 502 | 503 | 504)
                }
                _ => false,
            },
            // Compatibility for older storage adapters that stringify transport
            // failures. New Tier-2 code preserves the typed error above.
            Self::Invalid(message) => {
                let message = message.to_ascii_lowercase();
                [
                    "timeout",
                    "timed out",
                    "unavailable",
                    "network",
                    " 503",
                    " 502",
                    " 500",
                    " 429",
                ]
                .iter()
                .any(|needle| message.contains(needle))
            }
            _ => false,
        }
    }

    pub fn is_conflict(&self) -> bool {
        match self {
            Self::Tier2(error) => error.is_conflict(),
            Self::Synapse(error) => error.is_conflict(),
            Self::Invalid(message) => {
                let message = message.to_ascii_lowercase();
                message.contains("already exists") || message.contains("conflict")
            }
            _ => false,
        }
    }
}

pub type StorageResult<T> = std::result::Result<T, StorageError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApproveOutcome {
    /// A new feature was materialised and the submission is now approved.
    Approved,
    /// The submission was already approved; no second feature was created.
    AlreadyApproved,
    /// The submission does not exist or is not pending.
    NotFound,
}

#[async_trait]
pub trait Storage: Send + Sync {
    async fn get_features(&self) -> StorageResult<Vec<Value>>;
    async fn add_feature(&self, feature: Value) -> StorageResult<()>;
    async fn delete_feature(&self, feature_id: &str) -> StorageResult<bool>;
    async fn add_contribution(&self, contribution: Value) -> StorageResult<()>;
    async fn get_pending_contributions(&self) -> StorageResult<Vec<Value>>;
    async fn get_all_contributions(&self) -> StorageResult<Vec<Value>>;
    async fn approve_contribution(&self, contribution_id: &str) -> StorageResult<ApproveOutcome>;
    async fn reject_contribution(&self, contribution_id: &str) -> StorageResult<bool>;
    async fn get_leaderboard(&self) -> StorageResult<Value>;
    async fn add_sos_report(&self, report: Value) -> StorageResult<()>;
    async fn get_sos_reports(&self, status: Option<&str>) -> StorageResult<Vec<Value>>;
    async fn update_sos_status(&self, report_id: &str, next_status: &str) -> StorageResult<bool>;
    async fn mark_synced(&self, limit: i64) -> StorageResult<i64>;
}

pub async fn from_config(config: &Config) -> StorageResult<Arc<dyn Storage>> {
    match config.storage_backend {
        StorageBackend::Dx => {
            let storage = DxStorage::new(
                &config.synapsedx_base_url,
                &config.synapsedx_api_key,
                &config.synapsedx_token,
                config.tier2_timeout_secs,
            )
            .await?;
            Ok(Arc::new(storage))
        }
        StorageBackend::Base => {
            let storage =
                BaseStorage::new(&config.synapseone_base_url, &config.synapseone_api_key).await?;
            Ok(Arc::new(storage))
        }
        StorageBackend::Json => {
            let storage = JsonStorage::new(&config.json_storage_dir).await?;
            Ok(Arc::new(storage))
        }
    }
}

impl From<StorageError> for ApiError {
    fn from(error: StorageError) -> Self {
        tracing::error!(error = %error, "storage operation failed");
        ApiError::internal("Storage backend request failed")
    }
}

pub(crate) fn normalise_item(item: &Value) -> Value {
    let mut data = item
        .get("data")
        .cloned()
        .unwrap_or_else(|| Value::Object(Default::default()));
    let id = item
        .get("id")
        .and_then(Value::as_str)
        .or_else(|| data.get("id").and_then(Value::as_str))
        .unwrap_or("")
        .to_string();
    if !id.is_empty() {
        if let Some(object) = data.as_object_mut() {
            object.insert("id".to_string(), Value::String(id.clone()));
            object.insert("_id".to_string(), Value::String(id));
        }
    }
    data
}

pub(crate) fn feature_code_from_properties(data: &mut Value) {
    if data
        .get("feature_code")
        .and_then(Value::as_str)
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        return;
    }
    if let Some(feature_type) = data
        .get("properties")
        .and_then(|properties| properties.get("feature_type"))
        .and_then(Value::as_str)
    {
        if !feature_type.is_empty() {
            let code = feature_type.to_lowercase().replace(' ', "_");
            if let Some(object) = data.as_object_mut() {
                object.insert("feature_code".to_string(), Value::String(code));
            }
        }
    }
}

pub(crate) fn cap_limit(limit: i64) -> i64 {
    if limit <= 0 {
        500
    } else {
        limit.clamp(1, 1_000)
    }
}

pub(crate) fn sort_by_created_desc(items: &mut [Value]) {
    items.sort_by(|left, right| {
        let left = left.get("created_at").and_then(Value::as_str).unwrap_or("");
        let right = right
            .get("created_at")
            .and_then(Value::as_str)
            .unwrap_or("");
        right.cmp(left)
    });
}
