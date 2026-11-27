// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 persistence through SynapseDX capabilities datasets/records.
//!
//! The contribution portal is a Tier-3 product. Production records live in
//! `city-contribution-*` datasets through `https://synapsedx.sbs`; the legacy
//! Tier-1 collections are used only by the migration/rollback backend.

use super::{
    cap_limit, feature_code_from_properties, sort_by_created_desc, ApproveOutcome, Storage,
    StorageError, StorageResult,
};
use crate::util::{new_id, now_utc_iso};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::time::Duration;
use synapsedx::{
    Client, Credentials, Dataset, DatasetInput, RecordItem, RecordQuery, RequestOptions,
};

const LICENSE: &str = "PDDL-1.0";

pub const FEATURES_DATASET: &str = "city-contribution-features";
pub const SUBMISSIONS_DATASET: &str = "city-contribution-submissions";
pub const SOS_DATASET: &str = "city-contribution-sos-reports";

struct DatasetSpec {
    id: &'static str,
    name: &'static str,
    entity_type: &'static str,
    description: &'static str,
    public: bool,
}

const FEATURES_SPEC: DatasetSpec = DatasetSpec {
    id: FEATURES_DATASET,
    name: "SynapseCity contribution features",
    entity_type: "ContributionFeature",
    description: "Approved city infrastructure features from public contributions",
    public: true,
};
const SUBMISSIONS_SPEC: DatasetSpec = DatasetSpec {
    id: SUBMISSIONS_DATASET,
    name: "SynapseCity contribution submissions",
    entity_type: "ContributionSubmission",
    description: "Pending/approved public contributions",
    public: false,
};
const SOS_SPEC: DatasetSpec = DatasetSpec {
    id: SOS_DATASET,
    name: "SynapseCity contribution SOS reports",
    entity_type: "ContributionSosReport",
    description: "Public citizen SOS reports collected by the contribution portal",
    public: false,
};

pub struct DxStorage {
    client: Client,
    opts: RequestOptions,
}

impl DxStorage {
    pub async fn new(
        base_url: &str,
        api_key: &str,
        token: &str,
        timeout_secs: u64,
    ) -> StorageResult<Self> {
        let mut credentials = Credentials::none();
        if !token.trim().is_empty() {
            credentials = credentials.with_token(token.trim().to_string());
        }
        if !api_key.trim().is_empty() {
            credentials = credentials.with_api_key(api_key.trim().to_string());
        }
        let client = Client::builder(base_url.trim().trim_end_matches('/').to_string())
            .credentials(credentials)
            .timeout(Duration::from_secs(timeout_secs.clamp(5, 120)))
            .retries(1)
            .build()
            .map_err(|error| StorageError::Invalid(format!("Tier-2 client: {error}")))?;
        let opts = RequestOptions::new();
        let storage = Self { client, opts };
        storage.ensure_datasets().await?;
        Ok(storage)
    }

    async fn ensure_datasets(&self) -> StorageResult<()> {
        for spec in [&FEATURES_SPEC, &SUBMISSIONS_SPEC, &SOS_SPEC] {
            self.ensure_dataset(spec).await?;
        }
        Ok(())
    }

    async fn ensure_dataset(&self, spec: &DatasetSpec) -> StorageResult<Dataset> {
        match self.client.datasets().get(spec.id, &self.opts).await {
            Ok(existing) => {
                let publish_drift = spec.public && existing.status != "published";
                let metadata_drift = existing.license != LICENSE
                    || existing.public != spec.public
                    || existing.name != spec.name
                    || existing.entity_type != spec.entity_type
                    || existing.description.as_deref().unwrap_or("") != spec.description;
                if !publish_drift && !metadata_drift {
                    return Ok(existing);
                }
                let mut current = existing;
                if metadata_drift {
                    let patch = json!({
                        "name": spec.name,
                        "entityType": spec.entity_type,
                        "license": LICENSE,
                        "description": spec.description,
                        "public": spec.public,
                        "schemaVersion": current.schema_version.clone().unwrap_or_else(|| "1.0.0".into()),
                    });
                    current = self
                        .client
                        .datasets()
                        .update(current.id.as_str(), patch, &self.opts)
                        .await?;
                }
                if publish_drift {
                    match self
                        .client
                        .datasets()
                        .publish(current.id.as_str(), &self.opts)
                        .await
                    {
                        Ok(published) => Ok(published),
                        Err(error) => {
                            tracing::warn!(dataset = %spec.id, error = %error, "public dataset not published; reconcile will retry");
                            Ok(current)
                        }
                    }
                } else {
                    Ok(current)
                }
            }
            Err(error) if error.is_not_found() => {
                let input = DatasetInput {
                    slug: spec.id.to_string(),
                    name: spec.name.to_string(),
                    entity_type: spec.entity_type.to_string(),
                    license: LICENSE.into(),
                    description: Some(spec.description.to_string()),
                    public: Some(spec.public),
                    schema_version: Some("1.0.0".into()),
                    ..Default::default()
                };
                match self.client.datasets().create(input, &self.opts).await {
                    Ok(created) => {
                        if spec.public {
                            match self
                                .client
                                .datasets()
                                .publish(created.id.as_str(), &self.opts)
                                .await
                            {
                                Ok(published) => Ok(published),
                                Err(error) => {
                                    tracing::warn!(dataset = %spec.id, error = %error, "publish failed at bootstrap; reconcile will retry");
                                    Ok(created)
                                }
                            }
                        } else {
                            Ok(created)
                        }
                    }
                    Err(create_error) => {
                        if matches!(create_error.status(), Some(400 | 409)) {
                            self.client
                                .datasets()
                                .get(spec.id, &self.opts)
                                .await
                                .map_err(StorageError::from)
                        } else {
                            Err(create_error.into())
                        }
                    }
                }
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Read every matching record. Cursor pages are preferred because they stay
    /// stable while contributors insert records; offset pages remain supported
    /// for Tier-2 deployments that do not return a cursor. There is deliberately
    /// no 10,000-row cap: callers must either receive all rows or an error.
    async fn query_all(
        &self,
        dataset: &str,
        filter: Option<Value>,
        order_by: Option<Value>,
    ) -> StorageResult<Vec<RecordItem>> {
        let mut query = RecordQuery::new().limit(500);
        if let Some(filter) = filter {
            query = query.filter(filter);
        }
        if let Some(order_by) = order_by {
            query.order_by = Some(order_by);
        }

        let mut items = Vec::new();
        let mut seen_ids = HashSet::new();
        let mut seen_cursors = HashSet::new();
        let mut cursor: Option<String> = None;
        let mut offset = 0i64;
        loop {
            let mut page_query = query.clone();
            if let Some(next_cursor) = &cursor {
                page_query.cursor = Some(next_cursor.clone());
            } else {
                page_query.offset = Some(offset);
            }
            let page = self
                .client
                .records()
                .query(dataset, page_query, &self.opts)
                .await?;
            let count = i64::try_from(page.items.len()).unwrap_or(i64::MAX);
            let previous_len = items.len();
            for item in page.items {
                if seen_ids.insert(item.id.clone()) {
                    items.push(item);
                }
            }

            if let Some(next_cursor) = page.next_cursor.filter(|value| !value.is_empty()) {
                if !seen_cursors.insert(next_cursor.clone()) {
                    return Err(StorageError::Invalid(format!(
                        "Tier-2 pagination repeated cursor while reading {dataset}"
                    )));
                }
                cursor = Some(next_cursor);
                continue;
            }

            cursor = None;
            let page_offset = if page.offset < 0 { 0 } else { page.offset };
            let next_offset = page_offset.saturating_add(count);
            if count == 0 {
                if next_offset < page.total {
                    return Err(StorageError::Invalid(format!(
                        "Tier-2 returned an empty page before the reported total for {dataset}"
                    )));
                }
                break;
            }
            if next_offset >= page.total {
                break;
            }
            if items.len() == previous_len {
                return Err(StorageError::Invalid(format!(
                    "Tier-2 pagination made no progress while reading {dataset}"
                )));
            }
            offset = next_offset;
        }
        Ok(items)
    }

    fn normalise_record(item: &RecordItem) -> Value {
        let mut data = match &item.data {
            Value::Object(map) => map.clone(),
            _ => Map::new(),
        };
        data.entry("id".to_string())
            .or_insert_with(|| Value::String(item.id.clone()));
        data.entry("_id".to_string())
            .or_insert_with(|| Value::String(item.id.clone()));
        if !item.created_at.is_empty() {
            data.entry("created_at".to_string())
                .or_insert_with(|| Value::String(item.created_at.clone()));
        }
        Value::Object(data)
    }

    async fn create_record(
        &self,
        dataset: &str,
        mut data: Map<String, Value>,
        default_type: Option<&str>,
        default_created: bool,
        default_city_synced: bool,
        publish: bool,
    ) -> StorageResult<String> {
        let id = data
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(new_id);
        data.insert("id".to_string(), Value::String(id.clone()));
        if let Some(default_type) = default_type {
            data.entry("type".to_string())
                .or_insert_with(|| Value::String(default_type.to_string()));
        }
        if default_created {
            data.entry("created_at".to_string())
                .or_insert_with(|| Value::String(now_utc_iso()));
        }
        if default_city_synced {
            data.entry("city_synced".to_string())
                .or_insert(Value::Bool(false));
        }
        self.client
            .records()
            .create(
                dataset,
                Value::Object(data),
                Some(&id),
                Some(publish),
                &self.opts,
            )
            .await?;
        Ok(id)
    }

    pub async fn feature_exists_by_legacy_id(&self, legacy_id: &str) -> StorageResult<bool> {
        let query = RecordQuery::new()
            .limit(1)
            .filter(json!({ "legacy_id": legacy_id }));
        let page = self
            .client
            .records()
            .query(FEATURES_DATASET, query, &self.opts)
            .await?;
        Ok(!page.items.is_empty())
    }

    pub async fn contribution_exists(&self, id: &str) -> StorageResult<bool> {
        match self
            .client
            .records()
            .get(SUBMISSIONS_DATASET, id, &self.opts)
            .await
        {
            Ok(_) => Ok(true),
            Err(error) if error.is_not_found() => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub async fn sos_report_exists(&self, id: &str) -> StorageResult<bool> {
        match self.client.records().get(SOS_DATASET, id, &self.opts).await {
            Ok(_) => Ok(true),
            Err(error) if error.is_not_found() => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
}

#[async_trait]
impl Storage for DxStorage {
    async fn get_features(&self) -> StorageResult<Vec<Value>> {
        let items = self.query_all(FEATURES_DATASET, None, None).await?;
        let mut values: Vec<Value> = items.iter().map(Self::normalise_record).collect();
        sort_by_created_desc(&mut values);
        Ok(values)
    }

    async fn add_feature(&self, feature: Value) -> StorageResult<()> {
        let data = feature
            .as_object()
            .cloned()
            .ok_or_else(|| StorageError::Invalid("feature must be a JSON object".to_string()))?;
        let mut value = Value::Object(data);
        feature_code_from_properties(&mut value);
        let data = value
            .as_object()
            .cloned()
            .ok_or_else(|| StorageError::Invalid("feature must be a JSON object".to_string()))?;
        self.create_record(FEATURES_DATASET, data, Some("Feature"), true, true, true)
            .await?;
        Ok(())
    }

    async fn delete_feature(&self, feature_id: &str) -> StorageResult<bool> {
        match self
            .client
            .records()
            .delete(FEATURES_DATASET, feature_id, &self.opts)
            .await
        {
            Ok(_) => Ok(true),
            Err(error) if error.is_not_found() => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    async fn add_contribution(&self, contribution: Value) -> StorageResult<()> {
        let data = contribution
            .as_object()
            .cloned()
            .ok_or_else(|| StorageError::Invalid("contribution must be an object".to_string()))?;
        self.create_record(SUBMISSIONS_DATASET, data, None, true, false, false)
            .await?;
        Ok(())
    }

    async fn get_pending_contributions(&self) -> StorageResult<Vec<Value>> {
        let items = self
            .query_all(
                SUBMISSIONS_DATASET,
                Some(json!({ "status": "pending" })),
                Some(Value::String("timestamp:desc".to_string())),
            )
            .await?;
        Ok(items.iter().map(Self::normalise_record).collect())
    }

    async fn get_all_contributions(&self) -> StorageResult<Vec<Value>> {
        let items = self.query_all(SUBMISSIONS_DATASET, None, None).await?;
        Ok(items.iter().map(Self::normalise_record).collect())
    }

    async fn approve_contribution(&self, contribution_id: &str) -> StorageResult<ApproveOutcome> {
        let doc = match self
            .client
            .records()
            .get(SUBMISSIONS_DATASET, contribution_id, &self.opts)
            .await
        {
            Ok(doc) => doc,
            Err(error) if error.is_not_found() => return Ok(ApproveOutcome::NotFound),
            Err(error) => return Err(error.into()),
        };
        let mut feature = doc.data.as_object().cloned().unwrap_or_default();
        match feature.get("status").and_then(Value::as_str) {
            Some("approved") => return Ok(ApproveOutcome::AlreadyApproved),
            Some("pending") | None => {}
            Some(_) => return Ok(ApproveOutcome::NotFound),
        }
        let existing = self
            .query_all(
                FEATURES_DATASET,
                Some(json!({ "source_submission_id": contribution_id })),
                None,
            )
            .await?;
        if !existing.is_empty() {
            let patch = json!({ "status": "approved", "approved_at": now_utc_iso() });
            self.client
                .records()
                .update(
                    SUBMISSIONS_DATASET,
                    contribution_id,
                    patch,
                    Some(false),
                    &self.opts,
                )
                .await?;
            return Ok(ApproveOutcome::AlreadyApproved);
        }
        for key in [
            "_id",
            "id",
            "status",
            "contributor_name",
            "msv",
            "unit",
            "anonymous",
            "timestamp",
        ] {
            feature.remove(key);
        }
        let feature_id = format!("feature-{contribution_id}");
        feature.insert("id".to_string(), Value::String(feature_id.clone()));
        feature.insert("type".to_string(), Value::String("Feature".to_string()));
        feature.insert(
            "source_submission_id".to_string(),
            Value::String(contribution_id.to_string()),
        );
        feature.insert("created_at".to_string(), Value::String(now_utc_iso()));
        feature.insert("city_synced".to_string(), Value::Bool(false));
        match self
            .client
            .records()
            .create(
                FEATURES_DATASET,
                Value::Object(feature),
                Some(&feature_id),
                Some(true),
                &self.opts,
            )
            .await
        {
            Ok(_) => {}
            Err(error) if error.is_conflict() => {
                let patch = json!({ "status": "approved", "approved_at": now_utc_iso() });
                self.client
                    .records()
                    .update(
                        SUBMISSIONS_DATASET,
                        contribution_id,
                        patch,
                        Some(false),
                        &self.opts,
                    )
                    .await?;
                return Ok(ApproveOutcome::AlreadyApproved);
            }
            Err(error) => return Err(error.into()),
        }
        if let Err(error) = self
            .client
            .records()
            .update(
                SUBMISSIONS_DATASET,
                contribution_id,
                json!({ "status": "approved", "approved_at": now_utc_iso() }),
                Some(false),
                &self.opts,
            )
            .await
        {
            let _ = self
                .client
                .records()
                .delete(FEATURES_DATASET, &feature_id, &self.opts)
                .await;
            return Err(error.into());
        }
        Ok(ApproveOutcome::Approved)
    }

    async fn reject_contribution(&self, contribution_id: &str) -> StorageResult<bool> {
        match self
            .client
            .records()
            .delete(SUBMISSIONS_DATASET, contribution_id, &self.opts)
            .await
        {
            Ok(_) => Ok(true),
            Err(error) if error.is_not_found() => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    async fn get_leaderboard(&self) -> StorageResult<Value> {
        let items = self
            .query_all(
                SUBMISSIONS_DATASET,
                Some(json!({ "status": "approved" })),
                None,
            )
            .await?;
        let mut stats: std::collections::HashMap<String, (String, String, i64)> =
            std::collections::HashMap::new();
        for item in items {
            let row = match &item.data {
                Value::Object(map) => map,
                _ => continue,
            };
            if row.get("anonymous").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(msv) = row.get("msv").and_then(Value::as_str) else {
                continue;
            };
            let name = row
                .get("contributor_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let unit = row
                .get("unit")
                .and_then(Value::as_str)
                .unwrap_or("VKU")
                .to_string();
            let entry = stats
                .entry(msv.to_string())
                .or_insert((name.clone(), unit.clone(), 0));
            entry.0 = name;
            entry.1 = unit;
            entry.2 += 1;
        }
        let mut rows: Vec<Value> = stats
            .into_iter()
            .map(|(msv, (name, unit, count))| {
                json!({ "msv": msv, "contributor_name": name, "unit": unit, "count": count })
            })
            .collect();
        rows.sort_by(|left, right| {
            let left_count = left.get("count").and_then(Value::as_i64).unwrap_or(0);
            let right_count = right.get("count").and_then(Value::as_i64).unwrap_or(0);
            right_count.cmp(&left_count).then_with(|| {
                let left_name = left
                    .get("contributor_name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let right_name = right
                    .get("contributor_name")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                left_name.cmp(right_name)
            })
        });
        Ok(Value::Array(rows))
    }

    async fn add_sos_report(&self, report: Value) -> StorageResult<()> {
        let mut data = report
            .as_object()
            .cloned()
            .ok_or_else(|| StorageError::Invalid("SOS report must be an object".to_string()))?;
        let created_at = data
            .get("created_at")
            .cloned()
            .unwrap_or_else(|| Value::String(now_utc_iso()));
        data.entry("created_at".to_string())
            .or_insert_with(|| created_at.clone());
        data.entry("updated_at".to_string()).or_insert(created_at);
        self.create_record(SOS_DATASET, data, None, false, false, false)
            .await?;
        Ok(())
    }

    async fn get_sos_reports(&self, status: Option<&str>) -> StorageResult<Vec<Value>> {
        let filter = status.map(|status| json!({ "status": status }));
        let items = self.query_all(SOS_DATASET, filter, None).await?;
        let mut reports: Vec<Value> = items.iter().map(Self::normalise_record).collect();
        sort_by_created_desc(&mut reports);
        Ok(reports)
    }

    async fn update_sos_status(&self, report_id: &str, next_status: &str) -> StorageResult<bool> {
        match self
            .client
            .records()
            .update(
                SOS_DATASET,
                report_id,
                json!({ "status": next_status, "updated_at": now_utc_iso() }),
                Some(false),
                &self.opts,
            )
            .await
        {
            Ok(_) => Ok(true),
            Err(error) if error.is_not_found() => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    async fn mark_synced(&self, limit: i64) -> StorageResult<i64> {
        let cap = cap_limit(limit);
        let items = self
            .query_all(
                FEATURES_DATASET,
                Some(json!({ "city_synced": false })),
                Some(Value::String("created_at:asc".to_string())),
            )
            .await?;
        let ids: Vec<String> = items
            .iter()
            .take(cap as usize)
            .map(|item| item.id.clone())
            .collect();
        if ids.is_empty() {
            return Ok(0);
        }
        let marked_at = now_utc_iso();
        let mut marked = 0i64;
        for id in ids {
            let patch = json!({ "city_synced": true, "city_synced_at": marked_at });
            match self
                .client
                .records()
                .update(FEATURES_DATASET, &id, patch, Some(true), &self.opts)
                .await
            {
                Ok(_) => marked += 1,
                Err(error) if error.is_not_found() => continue,
                Err(error) => return Err(error.into()),
            }
        }
        Ok(marked)
    }
}
