// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Persistence facade. Production uses SynapseBase; `json` is an explicit
//! development-only fallback.

mod base;
mod json;

pub use base::BaseStorage;
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
    Synapse(#[from] synapseone::Error),
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type StorageResult<T> = std::result::Result<T, StorageError>;

#[async_trait]
pub trait Storage: Send + Sync {
    async fn get_features(&self) -> StorageResult<Vec<Value>>;
    async fn add_feature(&self, feature: Value) -> StorageResult<()>;
    async fn delete_feature(&self, feature_id: &str) -> StorageResult<bool>;
    async fn add_contribution(&self, contribution: Value) -> StorageResult<()>;
    async fn get_pending_contributions(&self) -> StorageResult<Vec<Value>>;
    async fn approve_contribution(&self, contribution_id: &str) -> StorageResult<bool>;
    async fn reject_contribution(&self, contribution_id: &str) -> StorageResult<bool>;
    async fn get_leaderboard(&self) -> StorageResult<Value>;
    async fn add_sos_report(&self, report: Value) -> StorageResult<()>;
    async fn get_sos_reports(&self, status: Option<&str>) -> StorageResult<Vec<Value>>;
    async fn update_sos_status(&self, report_id: &str, next_status: &str) -> StorageResult<bool>;
    async fn mark_synced(&self, limit: i64) -> StorageResult<i64>;
}

pub async fn from_config(config: &Config) -> StorageResult<Arc<dyn Storage>> {
    match config.storage_backend {
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
