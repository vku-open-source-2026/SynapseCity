// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Explainable asset criticality and outage-risk scoring
//! (port of `src/risk.ts`).
//!
//! Every score is a weighted sum of explicit factors. Missing or stale sensor
//! data lowers confidence and is surfaced as a flag; it is never silently
//! replaced with a healthy default.

use std::cmp::Ordering;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    clamp_number, first_non_null, first_truthy, iso_from_millis, js_number_string, js_round,
    js_string, now_millis, number_from_value, parse_timestamp_millis, string_value, JsonMap,
};

const CLOSED_INCIDENTS: [&str; 4] = ["resolved", "closed", "cancelled", "canceled"];
const CLOSED_MAINTENANCE: [&str; 3] = ["completed", "cancelled", "closed"];
const MINUTE_MILLIS: f64 = 60_000.0;
const DAY_MILLIS: f64 = 86_400_000.0;

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct CriticalityInput {
    #[serde(default)]
    pub service_impact: Option<f64>,
    #[serde(default)]
    pub population_served: Option<f64>,
    #[serde(default)]
    pub redundancy: Option<f64>,
    #[serde(default)]
    pub safety_impact: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct CriticalityNormalized {
    pub service_impact: f64,
    pub population_served: f64,
    pub redundancy: f64,
    pub safety_impact: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskSensorReading {
    #[serde(default)]
    pub metric: Option<String>,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub min: Option<f64>,
    #[serde(default)]
    pub max: Option<f64>,
    #[serde(default, alias = "observedAt")]
    pub observed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RiskFactor {
    pub name: String,
    pub weight: f64,
    pub score: f64,
    pub explanation: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RiskBand {
    Low,
    Moderate,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriticalityResult {
    pub score: f64,
    pub normalized: CriticalityNormalized,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DataFreshness {
    pub sensor_observed_at: Option<String>,
    pub age_minutes: Option<i64>,
    pub stale: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AssetRiskResult {
    pub asset_id: String,
    pub score: f64,
    pub band: RiskBand,
    pub confidence: f64,
    pub factors: Vec<RiskFactor>,
    pub flags: Vec<String>,
    pub criticality: CriticalityResult,
    pub data_freshness: DataFreshness,
    pub recommendations: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScoreAssetRiskInput {
    #[serde(default)]
    pub asset: JsonMap,
    #[serde(default)]
    pub incidents: Vec<JsonMap>,
    #[serde(default)]
    pub maintenance: Vec<JsonMap>,
    #[serde(default)]
    pub sensors: Vec<RiskSensorReading>,
    #[serde(default)]
    pub now: Option<i64>,
    #[serde(default, alias = "staleAfterMinutes")]
    pub stale_after_minutes: Option<f64>,
}

fn option_number(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(value) if value.is_finite() => value,
        _ => fallback,
    }
}

fn criticality_normalized(input: &CriticalityInput) -> CriticalityNormalized {
    CriticalityNormalized {
        service_impact: clamp_number(option_number(input.service_impact, 3.0), 1.0, 5.0),
        population_served: option_number(input.population_served, 0.0).max(0.0),
        redundancy: clamp_number(option_number(input.redundancy, 3.0), 1.0, 5.0),
        safety_impact: clamp_number(option_number(input.safety_impact, 3.0), 1.0, 5.0),
    }
}

pub fn criticality_score(input: &CriticalityInput) -> f64 {
    let normalized = criticality_normalized(input);
    let service = ((normalized.service_impact - 1.0) / 4.0) * 100.0;
    let population = clamp_number(
        ((1.0 + normalized.population_served).log10() / (1.0 + 1_000_000.0f64).log10()) * 100.0,
        0.0,
        100.0,
    );
    let redundancy = ((5.0 - normalized.redundancy) / 4.0) * 100.0;
    let safety = ((normalized.safety_impact - 1.0) / 4.0) * 100.0;
    js_round(service * 0.35 + population * 0.25 + redundancy * 0.2 + safety * 0.2)
}

fn number_field(map: &JsonMap, key: &str) -> Option<f64> {
    match map.get(key) {
        None | Some(Value::Null) => None,
        Some(value) => number_from_value(value),
    }
}

fn criticality_from_asset(asset: &JsonMap) -> CriticalityInput {
    let Some(Value::Object(criticality)) = asset.get("criticality") else {
        return CriticalityInput::default();
    };
    CriticalityInput {
        service_impact: number_field(criticality, "service_impact"),
        population_served: number_field(criticality, "population_served"),
        redundancy: number_field(criticality, "redundancy"),
        safety_impact: number_field(criticality, "safety_impact"),
    }
}

fn factor(name: &str, weight: f64, score: f64, explanation: String) -> RiskFactor {
    RiskFactor {
        name: name.to_string(),
        weight,
        score,
        explanation,
    }
}

/// Scores one asset, returning every factor, flag and recommendation used to
/// derive the score.
pub fn score_asset_risk(input: ScoreAssetRiskInput) -> AssetRiskResult {
    let now = input.now.unwrap_or_else(now_millis);
    let stale_after_minutes = input.stale_after_minutes.unwrap_or(180.0);
    let asset = &input.asset;

    let criticality_input = criticality_from_asset(asset);
    let criticality = criticality_normalized(&criticality_input);
    let criticality_value = criticality_score(&criticality_input);

    let mut factors = vec![factor(
        "criticality",
        0.35,
        criticality_value,
        format!(
            "service {}/5 · population {} · redundancy {}/5 · safety {}/5",
            js_number_string(criticality.service_impact),
            js_number_string(criticality.population_served),
            js_number_string(criticality.redundancy),
            js_number_string(criticality.safety_impact),
        ),
    )];

    let health_value = first_non_null(asset, &["health_score", "condition_score"])
        .map(|value| number_from_value(value).unwrap_or(f64::NAN))
        .unwrap_or(70.0);
    let health_for_risk = if health_value.is_finite() {
        health_value
    } else {
        70.0
    };
    let condition_risk = clamp_number(100.0 - health_for_risk, 0.0, 100.0);
    factors.push(factor(
        "condition",
        0.25,
        condition_risk,
        format!(
            "health score {}",
            if health_value.is_finite() {
                js_number_string(health_value)
            } else {
                "unknown".to_string()
            }
        ),
    ));

    let open_incident_count = input
        .incidents
        .iter()
        .filter(|incident| {
            let status = string_value(incident.get("status")).to_lowercase();
            !CLOSED_INCIDENTS.contains(&status.as_str())
        })
        .count();
    let incident_risk = clamp_number(open_incident_count as f64 * 18.0, 0.0, 100.0);
    factors.push(factor(
        "incidents",
        0.2,
        incident_risk,
        format!(
            "{open_incident_count} open incident{}",
            if open_incident_count == 1 { "" } else { "s" }
        ),
    ));

    let maintenance_risk = {
        let mut worst: f64 = 0.0;
        for order in &input.maintenance {
            let status = string_value(order.get("status")).to_lowercase();
            if CLOSED_MAINTENANCE.contains(&status.as_str()) {
                continue;
            }
            let due_raw = first_truthy(order, &["scheduled_date", "due_date"])
                .map(js_string)
                .unwrap_or_default();
            match parse_timestamp_millis(&due_raw) {
                Some(due) => {
                    let overdue_days = ((now - due) as f64 / DAY_MILLIS).max(0.0);
                    worst = worst.max(clamp_number(overdue_days * 2.0 + 25.0, 0.0, 100.0));
                }
                None => {
                    worst = worst.max(30.0);
                }
            }
        }
        worst
    };
    factors.push(factor(
        "maintenance",
        0.15,
        maintenance_risk,
        if maintenance_risk > 0.0 {
            "open preventive/corrective work exists".to_string()
        } else {
            "no overdue work orders".to_string()
        },
    ));

    let mut flags: Vec<String> = Vec::new();
    let mut sensor_risk: f64 = 0.0;
    let mut confidence_penalty: f64 = 0.0;
    let mut latest_observation: Option<String> = None;
    let mut latest_age: Option<f64> = None;

    for reading in &input.sensors {
        let observed_raw = reading.observed_at.as_deref().unwrap_or("");
        if let Some(observed) = parse_timestamp_millis(observed_raw) {
            let age_minutes = ((now - observed) as f64 / MINUTE_MILLIS).max(0.0);
            if latest_age.is_none() || age_minutes < latest_age.unwrap_or(f64::INFINITY) {
                latest_age = Some(age_minutes);
                latest_observation = Some(iso_from_millis(observed));
            }
            if age_minutes > stale_after_minutes {
                flags.push("stale_sensor_data".to_string());
                confidence_penalty += 0.15;
            }
        } else {
            flags.push("missing_sensor_timestamp".to_string());
            confidence_penalty += 0.1;
        }

        if let (Some(value), Some(min)) = (reading.value, reading.min) {
            if value.is_finite() && value < min {
                sensor_risk = sensor_risk.max(80.0);
            }
        }
        if let (Some(value), Some(max)) = (reading.value, reading.max) {
            if value.is_finite() && value > max {
                sensor_risk = sensor_risk.max(80.0);
            }
        }
    }

    if input.sensors.is_empty() {
        flags.push("no_sensor_data".to_string());
        confidence_penalty += 0.25;
    }
    factors.push(factor(
        "sensor",
        0.05,
        sensor_risk,
        if sensor_risk > 0.0 {
            "reading outside configured range".to_string()
        } else {
            "no threshold breach".to_string()
        },
    ));

    let score = js_round(
        factors
            .iter()
            .map(|factor| factor.score * factor.weight)
            .sum::<f64>(),
    );
    let band = if score >= 75.0 {
        RiskBand::Critical
    } else if score >= 55.0 {
        RiskBand::High
    } else if score >= 35.0 {
        RiskBand::Moderate
    } else {
        RiskBand::Low
    };
    let confidence = js_round(clamp_number(1.0 - confidence_penalty, 0.1, 1.0) * 100.0) / 100.0;

    let mut recommendations: Vec<String> = Vec::new();
    if score >= 55.0 {
        recommendations.push("Schedule an inspection within 7 days.".to_string());
    }
    if maintenance_risk >= 50.0 {
        recommendations
            .push("Create a prioritized work order for the overdue maintenance.".to_string());
    }
    if sensor_risk >= 50.0 {
        recommendations
            .push("Check the sensor reading and dispatch a technician if confirmed.".to_string());
    }
    if recommendations.is_empty() {
        recommendations
            .push("Continue routine monitoring; no immediate action required.".to_string());
    }

    let mut unique_flags: Vec<String> = Vec::new();
    for flag in flags {
        if !unique_flags.contains(&flag) {
            unique_flags.push(flag);
        }
    }

    AssetRiskResult {
        asset_id: string_value(first_truthy(asset, &["id", "asset_code"])),
        score,
        band,
        confidence,
        factors,
        flags: unique_flags,
        criticality: CriticalityResult {
            score: criticality_value,
            normalized: criticality,
        },
        data_freshness: DataFreshness {
            sensor_observed_at: latest_observation,
            age_minutes: latest_age.map(|age| js_round(age) as i64),
            stale: latest_age
                .map(|age| age > stale_after_minutes)
                .unwrap_or(false),
        },
        recommendations,
    }
}

/// Ranks by score descending, then confidence descending, then asset id.
pub fn rank_assets_by_risk(mut results: Vec<AssetRiskResult>) -> Vec<AssetRiskResult> {
    results.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(Ordering::Equal)
            .then_with(|| {
                right
                    .confidence
                    .partial_cmp(&left.confidence)
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| left.asset_id.cmp(&right.asset_id))
    });
    results
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> JsonMap {
        value.as_object().unwrap().clone()
    }

    fn base_input() -> ScoreAssetRiskInput {
        let now = parse_timestamp_millis("2026-11-04T00:00:00Z").unwrap();
        ScoreAssetRiskInput {
            asset: map(json!({
                "id": "a1",
                "health_score": 70,
                "criticality": {
                    "service_impact": 1,
                    "population_served": 100,
                    "redundancy": 5,
                    "safety_impact": 1
                }
            })),
            incidents: vec![],
            maintenance: vec![],
            sensors: vec![RiskSensorReading {
                metric: Some("vibration".to_string()),
                value: Some(1.0),
                unit: None,
                min: Some(0.0),
                max: Some(10.0),
                observed_at: Some("2026-11-04T00:00:00Z".to_string()),
            }],
            now: Some(now),
            stale_after_minutes: None,
        }
    }

    #[test]
    fn criticality_raises_the_explained_score() {
        let low = score_asset_risk(base_input());
        let mut high_input = base_input();
        high_input.asset = map(json!({
            "id": "a1",
            "health_score": 70,
            "criticality": {
                "service_impact": 5,
                "population_served": 500000,
                "redundancy": 1,
                "safety_impact": 5
            }
        }));
        let high = score_asset_risk(high_input);
        assert!(
            high.score > low.score,
            "{} must exceed {}",
            high.score,
            low.score
        );
        assert_eq!(low.factors.len(), 5);
        assert_eq!(low.factors[0].name, "criticality");
        assert_eq!(high.band, RiskBand::Moderate);
    }

    #[test]
    fn missing_sensor_data_lowers_confidence() {
        let full = score_asset_risk(base_input());
        let mut missing_input = base_input();
        missing_input.sensors.clear();
        let missing = score_asset_risk(missing_input);
        assert!(missing.flags.contains(&"no_sensor_data".to_string()));
        assert!(missing.confidence < full.confidence);
        assert_eq!(missing.data_freshness.sensor_observed_at, None);
        assert_eq!(missing.data_freshness.age_minutes, None);
        assert!(!missing.data_freshness.stale);
    }

    #[test]
    fn stale_and_out_of_range_readings_are_flagged() {
        let mut input = base_input();
        input.sensors = vec![RiskSensorReading {
            metric: Some("vibration".to_string()),
            value: Some(99.0),
            unit: None,
            min: Some(0.0),
            max: Some(10.0),
            observed_at: Some("2026-11-03T00:00:00Z".to_string()),
        }];
        let result = score_asset_risk(input);
        assert!(result.flags.contains(&"stale_sensor_data".to_string()));
        assert!(result.data_freshness.stale);
        assert_eq!(result.data_freshness.age_minutes, Some(1_440));
        assert_eq!(
            result
                .factors
                .iter()
                .find(|f| f.name == "sensor")
                .unwrap()
                .score,
            80.0
        );
        assert!(result
            .recommendations
            .iter()
            .any(|line| line.contains("sensor reading")));
    }

    #[test]
    fn maintenance_overdue_creates_recommendation_and_rank_is_stable() {
        let mut input = base_input();
        input.asset = map(json!({
            "id": "a1",
            "health_score": 90,
            "criticality": {
                "service_impact": 3,
                "population_served": 1000,
                "redundancy": 3,
                "safety_impact": 3
            }
        }));
        input.maintenance = vec![map(json!({
            "id": "wo-1",
            "status": "scheduled",
            "scheduled_date": "2026-10-01T00:00:00Z"
        }))];
        let result = score_asset_risk(input);
        assert!(result
            .recommendations
            .iter()
            .any(|line| line.contains("prioritized work order")));

        let mut other = result.clone();
        other.asset_id = "a0".to_string();
        let ranked = rank_assets_by_risk(vec![result.clone(), other]);
        assert_eq!(ranked[0].asset_id, "a0");
        assert_eq!(ranked[1].asset_id, "a1");
    }

    #[test]
    fn criticality_score_matches_ts_formula() {
        let score = criticality_score(&CriticalityInput {
            service_impact: Some(5.0),
            population_served: Some(500_000.0),
            redundancy: Some(1.0),
            safety_impact: Some(5.0),
        });
        assert_eq!(score, 99.0);
    }
}
