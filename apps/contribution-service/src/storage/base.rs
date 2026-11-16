// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase persistence, matching `base_storage.py`.

use super::{
    cap_limit, feature_code_from_properties, normalise_item, sort_by_created_desc, Storage,
    StorageError, StorageResult, FEATURES, SOS_REPORTS, SUBMISSIONS,
};
use crate::util::{new_id, now_utc_iso};
use async_trait::async_trait;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::time::Duration;
use synapseone::{Client, Credentials, OrderBy, Query, SynapseOneClient};

pub struct BaseStorage {
    client: SynapseOneClient,
}

impl BaseStorage {
    pub async fn new(base_url: &str, api_key: &str) -> StorageResult<Self> {
        let transport = Client::builder(base_url)
            .credentials(Credentials::api_key(api_key))
            .timeout(Duration::from_secs(20))
            .max_attempts(3)
            .build()?;
        let client = SynapseOneClient::from_client(transport);
        let storage = Self { client };
        storage.ensure_collections().await?;
        Ok(storage)
    }

    #[allow(dead_code)]
    pub fn client(&self) -> &SynapseOneClient {
        &self.client
    }

    async fn ensure_collections(&self) -> StorageResult<()> {
        let collections = [
            (
                FEATURES,
                "SynapseCity approved city infrastructure features",
            ),
            (SUBMISSIONS, "SynapseCity pending/approved contributions"),
            (SOS_REPORTS, "SynapseCity contribution SOS reports"),
        ];
        for (name, description) in collections {
            match self.client.base().get_collection(name).await {
                Ok(_) => continue,
                Err(error) if error.is_not_found() => {}
                Err(error) => return Err(error.into()),
            }
            match self
                .client
                .base()
                .create_collection(name, Some(description), None, None, None)
                .await
            {
                Ok(_) => {}
                Err(error) if error.is_conflict() => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }

    async fn query_all(
        &self,
        collection: &str,
        filter: Option<Value>,
        order_by: Option<Vec<OrderBy>>,
    ) -> StorageResult<Vec<Value>> {
        let mut items = Vec::new();
        let mut cursor: Option<String> = None;
        let mut seen: HashSet<String> = HashSet::new();
        loop {
            let mut query = Query::new().limit(1_000);
            if let Some(filter) = filter.clone() {
                query = query.filter(filter);
            }
            if let Some(order_by) = order_by.clone() {
                query = query.order_by(order_by);
            }
            if let Some(cursor) = cursor.clone() {
                query = query.cursor(cursor);
            }
            let page = self
                .client
                .base()
                .query_documents(collection, query)
                .await?;
            items.extend(page.items);
            match page.next_cursor {
                Some(next) if !next.is_empty() && seen.insert(next.clone()) => {
                    cursor = Some(next);
                }
                _ => break,
            }
        }
        Ok(items)
    }

    async fn create_document(
        &self,
        collection: &str,
        mut data: Map<String, Value>,
        default_type: Option<&str>,
        default_created_at: bool,
        default_city_synced: bool,
    ) -> StorageResult<String> {
        let id = data
            .get("id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(new_id);
        data.insert("id".to_string(), Value::String(id.clone()));
        if let Some(default_type) = default_type {
            data.entry("type")
                .or_insert_with(|| Value::String(default_type.to_string()));
        }
        if default_created_at {
            data.entry("created_at")
                .or_insert_with(|| Value::String(now_utc_iso()));
        }
        if default_city_synced {
            data.entry("city_synced").or_insert(Value::Bool(false));
        }
        self.client
            .base()
            .create_document(collection, Value::Object(data), Some(&id))
            .await?;
        Ok(id)
    }
}

#[async_trait]
impl Storage for BaseStorage {
    async fn get_features(&self) -> StorageResult<Vec<Value>> {
        let items = self.query_all(FEATURES, None, None).await?;
        Ok(items.iter().map(normalise_item).collect())
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
        self.create_document(FEATURES, data, Some("Feature"), true, true)
            .await?;
        Ok(())
    }

    async fn delete_feature(&self, feature_id: &str) -> StorageResult<bool> {
        match self
            .client
            .base()
            .delete_document(FEATURES, feature_id, None)
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
        self.create_document(SUBMISSIONS, data, None, true, false)
            .await?;
        Ok(())
    }

    async fn get_pending_contributions(&self) -> StorageResult<Vec<Value>> {
        let items = self
            .query_all(
                SUBMISSIONS,
                Some(json!({ "status": "pending" })),
                Some(vec![OrderBy::desc("timestamp")]),
            )
            .await?;
        Ok(items.iter().map(normalise_item).collect())
    }

    async fn approve_contribution(&self, contribution_id: &str) -> StorageResult<bool> {
        let doc = match self
            .client
            .base()
            .get_document(SUBMISSIONS, contribution_id, "data")
            .await
        {
            Ok(doc) => doc,
            Err(error) if error.is_not_found() => return Ok(false),
            Err(error) => return Err(error.into()),
        };
        let mut feature = doc
            .get("data")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
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
        let feature_id = new_id();
        feature.insert("id".to_string(), Value::String(feature_id));
        feature.insert("type".to_string(), Value::String("Feature".to_string()));
        feature.insert("created_at".to_string(), Value::String(now_utc_iso()));
        feature.insert("city_synced".to_string(), Value::Bool(false));
        self.client
            .base()
            .create_document(FEATURES, Value::Object(feature), None)
            .await?;
        self.client
            .base()
            .update_document(
                SUBMISSIONS,
                contribution_id,
                Some(json!({
                    "status": "approved",
                    "approved_at": now_utc_iso(),
                })),
                None,
                None,
            )
            .await?;
        Ok(true)
    }

    async fn reject_contribution(&self, contribution_id: &str) -> StorageResult<bool> {
        match self
            .client
            .base()
            .delete_document(SUBMISSIONS, contribution_id, None)
            .await
        {
            Ok(_) => Ok(true),
            Err(error) if error.is_not_found() => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    async fn get_leaderboard(&self) -> StorageResult<Value> {
        let items = self
            .query_all(SUBMISSIONS, Some(json!({ "status": "approved" })), None)
            .await?;
        let mut stats: std::collections::HashMap<String, (String, String, i64)> =
            std::collections::HashMap::new();
        for item in items {
            let Some(row) = item.get("data").and_then(Value::as_object) else {
                continue;
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
                json!({
                    "msv": msv,
                    "contributor_name": name,
                    "unit": unit,
                    "count": count,
                })
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
        let data = report
            .as_object()
            .cloned()
            .ok_or_else(|| StorageError::Invalid("SOS report must be an object".to_string()))?;
        let mut data = data;
        let created_at = data
            .get("created_at")
            .cloned()
            .unwrap_or_else(|| Value::String(now_utc_iso()));
        data.entry("created_at".to_string())
            .or_insert(created_at.clone());
        data.entry("updated_at".to_string()).or_insert(created_at);
        self.create_document(SOS_REPORTS, data, None, false, false)
            .await?;
        Ok(())
    }

    async fn get_sos_reports(&self, status: Option<&str>) -> StorageResult<Vec<Value>> {
        let filter = status.map(|status| json!({ "status": status }));
        let items = self.query_all(SOS_REPORTS, filter, None).await?;
        let mut reports: Vec<Value> = items.iter().map(normalise_item).collect();
        sort_by_created_desc(&mut reports);
        Ok(reports)
    }

    async fn update_sos_status(&self, report_id: &str, next_status: &str) -> StorageResult<bool> {
        match self
            .client
            .base()
            .update_document(
                SOS_REPORTS,
                report_id,
                Some(json!({
                    "status": next_status,
                    "updated_at": now_utc_iso(),
                })),
                None,
                None,
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
        let page = self
            .client
            .base()
            .query_documents(
                FEATURES,
                Query::new()
                    .filter(json!({ "city_synced": false }))
                    .order_by(vec![OrderBy::asc("created_at")])
                    .limit(cap),
            )
            .await?;
        let ids: Vec<String> = page
            .items
            .iter()
            .filter_map(|item| item.get("id").and_then(Value::as_str).map(str::to_string))
            .collect();
        if ids.is_empty() {
            return Ok(0);
        }
        let marked_at = now_utc_iso();
        let mut marked = 0i64;
        for chunk in ids.chunks(100) {
            let operations = chunk
                .iter()
                .map(|id| {
                    json!({
                        "op": "update",
                        "id": id,
                        "data": { "city_synced": true, "city_synced_at": marked_at },
                    })
                })
                .collect::<Vec<_>>();
            let result = self
                .client
                .base()
                .batch_values(FEATURES, Value::Array(operations))
                .await?;
            if let Some(results) = result.get("results").and_then(Value::as_array) {
                marked += results
                    .iter()
                    .filter(|row| row.get("ok").and_then(Value::as_bool) == Some(true))
                    .count() as i64;
            }
        }
        Ok(marked)
    }
}
