// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Development-only JSON persistence, matching `JsonStorage` in Python.

use super::{Storage, StorageResult};
use crate::util::now_naive_iso;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tokio::sync::Mutex;

struct JsonState {
    features: Vec<Value>,
    contributions: Vec<Value>,
    sos: Vec<Value>,
}

struct Paths {
    features: PathBuf,
    contributions: PathBuf,
    sos: PathBuf,
}

pub struct JsonStorage {
    state: Mutex<JsonState>,
    paths: Paths,
}

impl JsonStorage {
    pub async fn new(dir: &Path) -> StorageResult<Self> {
        tokio::fs::create_dir_all(dir).await?;
        let paths = Paths {
            features: dir.join("data.json"),
            contributions: dir.join("contributions.json"),
            sos: dir.join("sos_reports.json"),
        };
        let state = JsonState {
            features: load_array(&paths.features).await?,
            contributions: load_array(&paths.contributions).await?,
            sos: load_array(&paths.sos).await?,
        };
        Ok(Self {
            state: Mutex::new(state),
            paths,
        })
    }

    async fn save_features(&self, state: &JsonState) -> StorageResult<()> {
        write_array(&self.paths.features, &state.features).await
    }

    async fn save_contributions(&self, state: &JsonState) -> StorageResult<()> {
        write_array(&self.paths.contributions, &state.contributions).await
    }

    async fn save_sos(&self, state: &JsonState) -> StorageResult<()> {
        write_array(&self.paths.sos, &state.sos).await
    }

    fn push_feature(state: &mut JsonState, mut feature: Value) {
        let id = feature
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| (state.features.len() + 1).to_string());
        if let Some(object) = feature.as_object_mut() {
            object.insert("id".to_string(), Value::String(id));
        }
        state.features.push(feature);
    }
}

async fn load_array(path: &Path) -> StorageResult<Vec<Value>> {
    match tokio::fs::read(path).await {
        Ok(bytes) if !bytes.is_empty() => match serde_json::from_slice::<Value>(&bytes)? {
            Value::Array(items) => Ok(items),
            _ => Ok(Vec::new()),
        },
        Ok(_) => Ok(Vec::new()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

async fn write_array(path: &Path, value: &[Value]) -> StorageResult<()> {
    let bytes = serde_json::to_vec_pretty(&Value::Array(value.to_vec()))?;
    tokio::fs::write(path, bytes).await?;
    Ok(())
}

#[async_trait]
impl Storage for JsonStorage {
    async fn get_features(&self) -> StorageResult<Vec<Value>> {
        Ok(self.state.lock().await.features.clone())
    }

    async fn add_feature(&self, feature: Value) -> StorageResult<()> {
        let mut state = self.state.lock().await;
        Self::push_feature(&mut state, feature);
        self.save_features(&state).await
    }

    async fn delete_feature(&self, feature_id: &str) -> StorageResult<bool> {
        let mut state = self.state.lock().await;
        let before = state.features.len();
        state.features.retain(|feature| {
            let id = feature.get("id").and_then(Value::as_str).unwrap_or("");
            let old_id = feature.get("_id").and_then(Value::as_str).unwrap_or("");
            id != feature_id && old_id != feature_id
        });
        if state.features.len() == before {
            return Ok(false);
        }
        self.save_features(&state).await?;
        Ok(true)
    }

    async fn add_contribution(&self, contribution: Value) -> StorageResult<()> {
        let mut state = self.state.lock().await;
        let mut contribution = contribution;
        if contribution.get("id").is_none() {
            if let Some(object) = contribution.as_object_mut() {
                object.insert(
                    "id".to_string(),
                    Value::String((state.contributions.len() + 1).to_string()),
                );
            }
        }
        state.contributions.push(contribution);
        self.save_contributions(&state).await
    }

    async fn get_pending_contributions(&self) -> StorageResult<Vec<Value>> {
        let state = self.state.lock().await;
        Ok(state
            .contributions
            .iter()
            .filter(|item| item.get("status").and_then(Value::as_str) == Some("pending"))
            .cloned()
            .collect())
    }

    async fn approve_contribution(&self, contribution_id: &str) -> StorageResult<bool> {
        let feature =
            {
                let mut state = self.state.lock().await;
                let Some(index) = state.contributions.iter().position(|item| {
                    item.get("id").and_then(Value::as_str) == Some(contribution_id)
                }) else {
                    return Ok(false);
                };
                state.contributions[index]["status"] = Value::String("approved".to_string());
                let mut feature = state.contributions[index].clone();
                if let Some(object) = feature.as_object_mut() {
                    for key in [
                        "id",
                        "status",
                        "contributor_name",
                        "msv",
                        "unit",
                        "anonymous",
                        "timestamp",
                    ] {
                        object.remove(key);
                    }
                }
                self.save_contributions(&state).await?;
                feature
            };
        self.add_feature(feature).await?;
        Ok(true)
    }

    async fn reject_contribution(&self, contribution_id: &str) -> StorageResult<bool> {
        let mut state = self.state.lock().await;
        let before = state.contributions.len();
        state
            .contributions
            .retain(|item| item.get("id").and_then(Value::as_str) != Some(contribution_id));
        if state.contributions.len() == before {
            return Ok(false);
        }
        self.save_contributions(&state).await?;
        Ok(true)
    }

    async fn get_leaderboard(&self) -> StorageResult<Value> {
        let state = self.state.lock().await;
        let mut stats: std::collections::HashMap<String, (String, String, i64)> =
            std::collections::HashMap::new();
        for item in &state.contributions {
            if item.get("status").and_then(Value::as_str) != Some("approved") {
                continue;
            }
            if item.get("anonymous").and_then(Value::as_bool) == Some(true) {
                continue;
            }
            let Some(msv) = item.get("msv").and_then(Value::as_str) else {
                continue;
            };
            let name = item
                .get("contributor_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let unit = item
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
                left.get("contributor_name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .cmp(
                        right
                            .get("contributor_name")
                            .and_then(Value::as_str)
                            .unwrap_or(""),
                    )
            })
        });
        Ok(Value::Array(rows))
    }

    async fn add_sos_report(&self, report: Value) -> StorageResult<()> {
        let mut state = self.state.lock().await;
        let mut report = report;
        if report.get("id").is_none() {
            if let Some(object) = report.as_object_mut() {
                object.insert(
                    "id".to_string(),
                    Value::String((state.sos.len() + 1).to_string()),
                );
            }
        }
        state.sos.push(report);
        self.save_sos(&state).await
    }

    async fn get_sos_reports(&self, status: Option<&str>) -> StorageResult<Vec<Value>> {
        let state = self.state.lock().await;
        let mut reports: Vec<Value> = state
            .sos
            .iter()
            .filter(|item| {
                status
                    .map(|status| item.get("status").and_then(Value::as_str) == Some(status))
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        reports.sort_by(|left, right| {
            let left = left.get("created_at").and_then(Value::as_str).unwrap_or("");
            let right = right
                .get("created_at")
                .and_then(Value::as_str)
                .unwrap_or("");
            right.cmp(left)
        });
        Ok(reports)
    }

    async fn update_sos_status(&self, report_id: &str, next_status: &str) -> StorageResult<bool> {
        let mut state = self.state.lock().await;
        let Some(report) = state
            .sos
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(report_id))
        else {
            return Ok(false);
        };
        if let Some(object) = report.as_object_mut() {
            object.insert("status".to_string(), Value::String(next_status.to_string()));
            object.insert("updated_at".to_string(), Value::String(now_naive_iso()));
        }
        self.save_sos(&state).await?;
        Ok(true)
    }

    async fn mark_synced(&self, limit: i64) -> StorageResult<i64> {
        let cap = super::cap_limit(limit) as usize;
        let mut state = self.state.lock().await;
        let mut marked = 0i64;
        for feature in state.features.iter_mut() {
            if marked >= cap as i64 {
                break;
            }
            let synced = feature
                .get("city_synced")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if !synced {
                if let Some(object) = feature.as_object_mut() {
                    object.insert("city_synced".to_string(), Value::Bool(true));
                    object.insert(
                        "city_synced_at".to_string(),
                        Value::String(crate::util::now_utc_iso()),
                    );
                }
                marked += 1;
            }
        }
        self.save_features(&state).await?;
        Ok(marked)
    }
}
