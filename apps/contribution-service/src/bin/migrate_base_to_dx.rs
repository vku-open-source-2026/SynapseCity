// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! One-off migration from legacy `contribution_*` Tier-1 collections to
//! `city-contribution-*` Tier-2 datasets.
//!
//! Feature IDs are deterministic and `legacy_id` is retained. After an
//! ambiguous transport failure the migration checks for the committed record
//! before retrying, so a lost response cannot create a duplicate.

use contribution_backend::config::validate_dependency_url;
use contribution_backend::storage::{BaseStorage, DxStorage, Storage, StorageResult};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::future::Future;

const FEATURE_MIGRATION_PREFIX: &str = "contribution-feature-";

fn deterministic_feature_id(legacy_id: &str) -> String {
    let digest = Sha256::digest(format!("contribution_features:{legacy_id}").as_bytes());
    let suffix = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("{FEATURE_MIGRATION_PREFIX}{suffix}")
}

fn feature_payload(feature: &Value) -> Result<Value, String> {
    let legacy_id = feature
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .ok_or_else(|| "cannot migrate a feature without a legacy id".to_string())?;
    let mut object = feature
        .as_object()
        .cloned()
        .ok_or_else(|| "legacy feature must be a JSON object".to_string())?;
    object.remove("id");
    object.remove("_id");
    object.insert(
        "id".to_string(),
        Value::String(deterministic_feature_id(legacy_id)),
    );
    object.insert(
        "legacy_id".to_string(),
        Value::String(legacy_id.to_string()),
    );
    object.insert(
        "legacy_source".to_string(),
        Value::String("contribution_features".to_string()),
    );
    Ok(Value::Object(object))
}

async fn retry_add<F, Fut, E, EFut>(
    mut op: F,
    mut exists: E,
    id: &str,
    kind: &str,
) -> Result<bool, String>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = StorageResult<()>>,
    E: FnMut() -> EFut,
    EFut: Future<Output = StorageResult<bool>>,
{
    let mut attempt = 0;
    loop {
        attempt += 1;
        match op().await {
            Ok(()) => return Ok(true),
            Err(error) if error.is_conflict() => return Ok(false),
            Err(error) if error.is_retryable() => {
                // A timeout can occur after Tier-2 committed the write. Never
                // retry blindly; first reconcile by the stable migration key.
                if exists().await.map_err(|error| error.to_string())? {
                    return Ok(false);
                }
                if attempt < 6 {
                    let backoff = std::cmp::min(2u64.pow(attempt), 16);
                    eprintln!("retry {kind} {id} attempt {attempt}: {error} (sleep {backoff}s)");
                    tokio::time::sleep(std::time::Duration::from_secs(backoff)).await;
                    continue;
                }
                return Err(format!("{kind} {id}: {error}"));
            }
            Err(error) => return Err(format!("{kind} {id}: {error}")),
        }
    }
}

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("migration failed: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let production = std::env::var("ENVIRONMENT")
        .map(|value| value.eq_ignore_ascii_case("production"))
        .unwrap_or(false);
    let one_url = std::env::var("SYNAPSEONE_BASE_URL")
        .unwrap_or_else(|_| "https://api.synapseone.space".to_string());
    let one_url = one_url.trim().trim_end_matches('/').to_string();
    validate_dependency_url(&one_url, production).map_err(|error| error.to_string())?;
    let one_key = std::env::var("SYNAPSEONE_API_KEY")
        .map_err(|_| "SYNAPSEONE_API_KEY is required".to_string())?;
    let dx_url =
        std::env::var("SYNAPSEDX_BASE_URL").unwrap_or_else(|_| "https://synapsedx.sbs".to_string());
    let dx_url = dx_url.trim().trim_end_matches('/').to_string();
    validate_dependency_url(&dx_url, production).map_err(|error| error.to_string())?;
    let dx_key = std::env::var("SYNAPSEDX_API_KEY").unwrap_or_default();
    let dx_token = std::env::var("SYNAPSEDX_TOKEN").unwrap_or_default();
    if dx_key.trim().is_empty() && dx_token.trim().is_empty() {
        return Err("SYNAPSEDX_API_KEY or SYNAPSEDX_TOKEN is required".to_string());
    }

    let base = BaseStorage::new(&one_url, &one_key)
        .await
        .map_err(|error| error.to_string())?;
    let dx = DxStorage::new(&dx_url, &dx_key, &dx_token, 20)
        .await
        .map_err(|error| error.to_string())?;

    // Legacy feature IDs were also synced to City and can collide with global
    // Tier-2 record IDs. Derive a separate stable ID and retain the old ID as
    // `legacy_id` for traceability and reruns.
    let features = base
        .get_features()
        .await
        .map_err(|error| error.to_string())?;
    let existing_features = dx.get_features().await.map_err(|error| error.to_string())?;
    let mut existing_legacy: HashSet<String> = existing_features
        .iter()
        .filter_map(|value| {
            value
                .get("legacy_id")
                .and_then(Value::as_str)
                .or_else(|| value.get("id").and_then(Value::as_str))
                .map(str::to_string)
        })
        .collect();
    let mut copied = 0;
    let mut skipped = 0;
    for feature in &features {
        let payload = feature_payload(feature)?;
        let legacy_id = payload["legacy_id"]
            .as_str()
            .expect("feature_payload always sets legacy_id")
            .to_string();
        if existing_legacy.contains(&legacy_id) {
            skipped += 1;
            continue;
        }
        let label = legacy_id.clone();
        let create_payload = payload.clone();
        let lookup_id = legacy_id.clone();
        match retry_add(
            || async { dx.add_feature(create_payload.clone()).await },
            || async { dx.feature_exists_by_legacy_id(&lookup_id).await },
            &label,
            "feature",
        )
        .await
        {
            Ok(true) => {
                copied += 1;
                existing_legacy.insert(legacy_id);
            }
            Ok(false) => {
                skipped += 1;
                existing_legacy.insert(legacy_id);
            }
            Err(message) => return Err(message),
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
    println!(
        "features: {copied}/{len} copied, {skipped} skipped",
        len = features.len()
    );

    let submissions = base
        .get_all_contributions()
        .await
        .map_err(|error| error.to_string())?;
    let existing_submissions = dx
        .get_all_contributions()
        .await
        .map_err(|error| error.to_string())?;
    let mut existing_sub_ids: HashSet<String> = existing_submissions
        .iter()
        .filter_map(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut copied_submissions = 0;
    let mut skipped_submissions = 0;
    for submission in &submissions {
        let id = submission
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "cannot migrate a submission without an id".to_string())?;
        if existing_sub_ids.contains(id) {
            skipped_submissions += 1;
            continue;
        }
        let payload = submission.clone();
        let lookup_id = id.to_string();
        match retry_add(
            || async { dx.add_contribution(payload.clone()).await },
            || async { dx.contribution_exists(&lookup_id).await },
            id,
            "submission",
        )
        .await
        {
            Ok(true) => {
                copied_submissions += 1;
                existing_sub_ids.insert(id.to_string());
            }
            Ok(false) => {
                skipped_submissions += 1;
                existing_sub_ids.insert(id.to_string());
            }
            Err(message) => return Err(message),
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
    println!(
        "submissions: {copied_submissions}/{len} copied, {skipped_submissions} skipped",
        len = submissions.len()
    );

    let sos_reports = base
        .get_sos_reports(None)
        .await
        .map_err(|error| error.to_string())?;
    let existing_sos = dx
        .get_sos_reports(None)
        .await
        .map_err(|error| error.to_string())?;
    let mut existing_sos_ids: HashSet<String> = existing_sos
        .iter()
        .filter_map(|value| value.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();
    let mut copied_sos = 0;
    let mut skipped_sos = 0;
    for report in &sos_reports {
        let id = report
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .ok_or_else(|| "cannot migrate an SOS report without an id".to_string())?;
        if existing_sos_ids.contains(id) {
            skipped_sos += 1;
            continue;
        }
        let payload = report.clone();
        let lookup_id = id.to_string();
        match retry_add(
            || async { dx.add_sos_report(payload.clone()).await },
            || async { dx.sos_report_exists(&lookup_id).await },
            id,
            "sos_report",
        )
        .await
        {
            Ok(true) => {
                copied_sos += 1;
                existing_sos_ids.insert(id.to_string());
            }
            Ok(false) => {
                skipped_sos += 1;
                existing_sos_ids.insert(id.to_string());
            }
            Err(message) => return Err(message),
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
    println!(
        "sos_reports: {copied_sos}/{len} copied, {skipped_sos} skipped",
        len = sos_reports.len()
    );

    println!("migration done");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{deterministic_feature_id, feature_payload, retry_add};
    use contribution_backend::storage::StorageError;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use tokio::sync::Mutex;

    #[derive(Default)]
    struct MockFeatures {
        items: Mutex<Vec<Value>>,
        lose_next_response_after_commit: AtomicBool,
    }

    impl MockFeatures {
        async fn create(&self, payload: Value) -> Result<(), StorageError> {
            let mut items = self.items.lock().await;
            if items.iter().any(|item| item.get("id") == payload.get("id")) {
                return Err(StorageError::Invalid("already exists/conflict".to_string()));
            }
            items.push(payload);
            if self
                .lose_next_response_after_commit
                .swap(false, Ordering::SeqCst)
            {
                return Err(StorageError::Invalid(
                    "request timeout after commit".to_string(),
                ));
            }
            Ok(())
        }

        async fn exists_by_legacy_id(&self, legacy_id: &str) -> Result<bool, StorageError> {
            Ok(self
                .items
                .lock()
                .await
                .iter()
                .any(|item| item.get("legacy_id").and_then(Value::as_str) == Some(legacy_id)))
        }
    }

    #[test]
    fn feature_ids_are_deterministic_and_separate_from_legacy_ids() {
        let first = deterministic_feature_id("legacy-123");
        assert_eq!(first, deterministic_feature_id("legacy-123"));
        assert_ne!(first, deterministic_feature_id("legacy-124"));
        assert_ne!(first, "legacy-123");
        assert!(first.starts_with("contribution-feature-"));
    }

    #[test]
    fn feature_payload_retains_traceability_without_reusing_the_old_id() {
        let payload = feature_payload(&json!({
            "id": "legacy-123",
            "_id": "legacy-123",
            "properties": { "feature_type": "Đèn đường" }
        }))
        .unwrap();
        assert_eq!(payload["id"], deterministic_feature_id("legacy-123"));
        assert_eq!(payload["legacy_id"], "legacy-123");
        assert_eq!(payload["legacy_source"], "contribution_features");
        assert!(payload.get("_id").is_none());
        assert!(feature_payload(&json!({ "properties": {} })).is_err());
    }

    #[tokio::test]
    async fn committed_create_with_lost_response_and_rerun_leaves_one_feature() {
        let target = Arc::new(MockFeatures::default());
        target
            .lose_next_response_after_commit
            .store(true, Ordering::SeqCst);
        let payload = feature_payload(&json!({
            "id": "legacy-123",
            "properties": { "feature_type": "Đèn đường" }
        }))
        .unwrap();
        let legacy_id = payload["legacy_id"]
            .as_str()
            .expect("legacy id")
            .to_string();

        let create_target = Arc::clone(&target);
        let lookup_target = Arc::clone(&target);
        let lookup_id = legacy_id.clone();
        let first = retry_add(
            move || {
                let target = Arc::clone(&create_target);
                let payload = payload.clone();
                async move { target.create(payload).await }
            },
            move || {
                let target = Arc::clone(&lookup_target);
                let id = lookup_id.clone();
                async move { target.exists_by_legacy_id(&id).await }
            },
            &legacy_id,
            "feature",
        )
        .await
        .unwrap();
        assert!(
            !first,
            "a committed record must be reconciled, not recreated"
        );

        let create_target = Arc::clone(&target);
        let lookup_target = Arc::clone(&target);
        let lookup_id = legacy_id.clone();
        let rerun_payload = feature_payload(&json!({
            "id": "legacy-123",
            "properties": { "feature_type": "Đèn đường" }
        }))
        .unwrap();
        let second = retry_add(
            move || {
                let target = Arc::clone(&create_target);
                let payload = rerun_payload.clone();
                async move { target.create(payload).await }
            },
            move || {
                let target = Arc::clone(&lookup_target);
                let id = lookup_id.clone();
                async move { target.exists_by_legacy_id(&id).await }
            },
            &legacy_id,
            "feature",
        )
        .await
        .unwrap();
        assert!(!second);
        assert_eq!(target.items.lock().await.len(), 1);
    }
}
