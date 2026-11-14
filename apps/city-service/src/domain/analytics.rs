// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! GIS coverage analysis and population-weighted prioritisation
//! (port of `src/analytics.ts`).
//!
//! The calculation is deterministic and mirrors the TypeScript formula:
//!
//! ```text
//! requiredAssets   = ceil(population / targetPopulationPerAsset)
//! coverageRatio    = min(1, assetCount / requiredAssets)
//! coverageGap      = 1 - coverageRatio
//! incidentPressure = min(1, openIncidents / max(1, assetCount))
//! demandPressure   = min(1, (population / max(1, assetCount)) / targetPopulationPerAsset)
//! gapScore         = round(100 * (0.5*coverageGap + 0.3*incidentPressure + 0.2*demandPressure))
//! ```

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::geo::{haversine_meters, point_in_bounding_box, point_in_polygon, BoundingBox, Point};
use super::{iso_from_millis, js_round, now_millis, parse_timestamp_millis};

pub const DEFAULT_SERVICE_RADIUS_METERS: f64 = 500.0;
pub const DEFAULT_TARGET_POPULATION_PER_ASSET: f64 = 2_000.0;
const OPEN_INCIDENT_WINDOW_MILLIS: i64 = 30 * 86_400_000;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoverageAreaInput {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub population: f64,
    #[serde(default)]
    pub bbox: Option<BoundingBox>,
    #[serde(default)]
    pub polygon: Option<Vec<(f64, f64)>>,
    #[serde(default, alias = "assetTypes")]
    pub asset_types: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageAsset {
    #[serde(default)]
    pub id: String,
    #[serde(default, alias = "featureType")]
    pub feature_type: String,
    #[serde(default)]
    pub point: Option<Point>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageIncident {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub point: Option<Point>,
    #[serde(default, alias = "reportedAt")]
    pub reported_at: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CoveragePriority {
    Critical,
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AreaCoverage {
    pub area: String,
    pub population: f64,
    pub asset_count: usize,
    pub assets_by_type: BTreeMap<String, u64>,
    pub missing_asset_types: Vec<String>,
    pub population_per_asset: f64,
    pub incident_count: usize,
    pub open_incident_count: usize,
    pub gap_score: i32,
    pub priority: CoveragePriority,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CoverageReport {
    pub generated_at: String,
    pub service_radius_meters: f64,
    pub target_population_per_asset: f64,
    pub areas: Vec<AreaCoverage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CoverageInput {
    #[serde(default)]
    pub areas: Vec<CoverageAreaInput>,
    #[serde(default)]
    pub assets: Vec<CoverageAsset>,
    #[serde(default)]
    pub incidents: Vec<CoverageIncident>,
    #[serde(default, alias = "serviceRadiusMeters")]
    pub service_radius_meters: Option<f64>,
    #[serde(default, alias = "targetPopulationPerAsset")]
    pub target_population_per_asset: Option<f64>,
    #[serde(default)]
    pub now: Option<i64>,
}

fn priority_for(score: i32) -> CoveragePriority {
    if score >= 70 {
        CoveragePriority::Critical
    } else if score >= 50 {
        CoveragePriority::High
    } else if score >= 30 {
        CoveragePriority::Medium
    } else {
        CoveragePriority::Low
    }
}

fn distance_to_box_meters(point: Point, bbox: BoundingBox) -> f64 {
    let min_lat = bbox.min_lat.min(bbox.max_lat);
    let max_lat = bbox.min_lat.max(bbox.max_lat);
    let min_lng = bbox.min_lng.min(bbox.max_lng);
    let max_lng = bbox.min_lng.max(bbox.max_lng);
    let clamped_lat = point.latitude.max(min_lat).min(max_lat);
    let clamped_lng = point.longitude.max(min_lng).min(max_lng);
    haversine_meters(point, Point::new(clamped_lng, clamped_lat))
}

fn distance_to_polygon_meters(point: Point, polygon: &[(f64, f64)]) -> f64 {
    if point_in_polygon(point, polygon) {
        return 0.0;
    }
    polygon
        .iter()
        .map(|(longitude, latitude)| haversine_meters(point, Point::new(*longitude, *latitude)))
        .fold(f64::INFINITY, f64::min)
}

fn serves(asset: &CoverageAsset, area: &CoverageAreaInput, radius_meters: f64) -> bool {
    let Some(point) = asset.point else {
        return false;
    };
    if let Some(polygon) = area.polygon.as_ref() {
        if polygon.len() >= 3 {
            return distance_to_polygon_meters(point, polygon) <= radius_meters;
        }
    }
    if let Some(bbox) = area.bbox {
        if point_in_bounding_box(point, bbox) {
            return true;
        }
        return distance_to_box_meters(point, bbox) <= radius_meters;
    }
    false
}

fn incident_in_area(incident: &CoverageIncident, area: &CoverageAreaInput) -> bool {
    let Some(point) = incident.point else {
        return false;
    };
    if let Some(polygon) = area.polygon.as_ref() {
        if polygon.len() >= 3 {
            return point_in_polygon(point, polygon);
        }
    }
    if let Some(bbox) = area.bbox {
        return point_in_bounding_box(point, bbox);
    }
    false
}

fn positive_or(value: Option<f64>, fallback: f64) -> f64 {
    match value {
        Some(value) if value.is_finite() && value > 0.0 => value,
        _ => fallback,
    }
}

/// Computes the coverage report. Areas are sorted by `gap_score` descending so
/// the first entry is always the highest-priority gap.
pub fn analyse_coverage(input: CoverageInput) -> CoverageReport {
    let radius = positive_or(input.service_radius_meters, DEFAULT_SERVICE_RADIUS_METERS);
    let target = positive_or(
        input.target_population_per_asset,
        DEFAULT_TARGET_POPULATION_PER_ASSET,
    );
    let now = input.now.unwrap_or_else(now_millis);
    let window_start = now - OPEN_INCIDENT_WINDOW_MILLIS;

    let mut areas: Vec<AreaCoverage> = input
        .areas
        .iter()
        .map(|area| {
            let population = if area.population.is_finite() {
                area.population.max(0.0)
            } else {
                0.0
            };
            let requested_types = &area.asset_types;

            let served: Vec<&CoverageAsset> = input
                .assets
                .iter()
                .filter(|asset| serves(asset, area, radius))
                .collect();

            let mut assets_by_type: BTreeMap<String, u64> = BTreeMap::new();
            for asset in &served {
                let feature_type = if asset.feature_type.is_empty() {
                    "infrastructure".to_string()
                } else {
                    asset.feature_type.clone()
                };
                *assets_by_type.entry(feature_type).or_insert(0) += 1;
            }

            let missing_asset_types: Vec<String> = requested_types
                .iter()
                .filter(|asset_type| !assets_by_type.contains_key(*asset_type))
                .cloned()
                .collect();
            let asset_count = served.len();

            let incidents: Vec<&CoverageIncident> = input
                .incidents
                .iter()
                .filter(|incident| incident_in_area(incident, area))
                .collect();
            let open_incidents: Vec<&&CoverageIncident> = incidents
                .iter()
                .filter(|incident| {
                    let status = incident.status.to_lowercase();
                    if ["resolved", "closed", "rejected"].contains(&status.as_str()) {
                        return false;
                    }
                    match incident.reported_at.as_deref() {
                        None | Some("") => true,
                        Some(raw) => match parse_timestamp_millis(raw) {
                            None => true,
                            Some(reported) => reported >= window_start,
                        },
                    }
                })
                .collect();

            let required_assets = (population / target).ceil().max(1.0);
            let coverage_ratio = (asset_count as f64 / required_assets).min(1.0);
            let coverage_gap = 1.0 - coverage_ratio;
            let incident_pressure =
                (open_incidents.len() as f64 / (asset_count.max(1) as f64)).min(1.0);
            let demand_pressure = ((population / (asset_count.max(1) as f64)) / target).min(1.0);
            let gap_score = js_round(
                100.0 * (0.5 * coverage_gap + 0.3 * incident_pressure + 0.2 * demand_pressure),
            ) as i32;
            let population_per_asset = if asset_count > 0 {
                js_round(population / asset_count as f64)
            } else {
                population
            };

            AreaCoverage {
                area: area.name.clone(),
                population,
                asset_count,
                assets_by_type,
                missing_asset_types,
                population_per_asset,
                incident_count: incidents.len(),
                open_incident_count: open_incidents.len(),
                gap_score,
                priority: priority_for(gap_score),
            }
        })
        .collect();

    areas.sort_by(|left, right| right.gap_score.cmp(&left.gap_score));

    CoverageReport {
        generated_at: iso_from_millis(now),
        service_radius_meters: radius,
        target_population_per_asset: target,
        areas,
    }
}

/// Convenience helper for callers that hold records instead of typed input.
pub fn analyse_coverage_from_value(input: &Value) -> Result<CoverageReport, serde_json::Error> {
    serde_json::from_value(input.clone()).map(analyse_coverage)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn asset(id: &str, feature_type: &str, longitude: f64, latitude: f64) -> CoverageAsset {
        CoverageAsset {
            id: id.to_string(),
            feature_type: feature_type.to_string(),
            point: Some(Point::new(longitude, latitude)),
        }
    }

    fn incident(id: &str, status: &str, longitude: f64, latitude: f64) -> CoverageIncident {
        CoverageIncident {
            id: id.to_string(),
            status: status.to_string(),
            point: Some(Point::new(longitude, latitude)),
            reported_at: Some("2026-11-01T00:00:00Z".to_string()),
        }
    }

    #[test]
    fn prioritises_areas_with_unmet_population_demand() {
        let now = parse_timestamp_millis("2026-11-04T00:00:00Z").unwrap();
        let report = analyse_coverage(CoverageInput {
            areas: vec![
                CoverageAreaInput {
                    name: "Covered".to_string(),
                    population: 2_000.0,
                    bbox: Some(BoundingBox::new(105.79, 20.99, 105.81, 21.01)),
                    polygon: None,
                    asset_types: vec!["street_light".to_string(), "hydrant".to_string()],
                },
                CoverageAreaInput {
                    name: "Uncovered".to_string(),
                    population: 50_000.0,
                    bbox: Some(BoundingBox::new(106.0, 21.0, 106.1, 21.1)),
                    polygon: None,
                    asset_types: vec!["street_light".to_string()],
                },
            ],
            assets: vec![
                asset("a1", "street_light", 105.8, 21.0),
                asset("h1", "hydrant", 105.8001, 21.0001),
            ],
            incidents: vec![
                incident("i1", "open", 106.05, 21.05),
                incident("i2", "open", 106.05, 21.05),
            ],
            service_radius_meters: Some(100.0),
            target_population_per_asset: Some(2_000.0),
            now: Some(now),
        });

        assert_eq!(report.generated_at, "2026-11-04T00:00:00.000Z");
        assert_eq!(report.areas[0].area, "Uncovered");
        let uncovered = &report.areas[0];
        assert_eq!(uncovered.asset_count, 0);
        assert_eq!(uncovered.missing_asset_types, vec!["street_light"]);
        assert_eq!(uncovered.open_incident_count, 2);
        assert_eq!(uncovered.gap_score, 100);
        assert_eq!(uncovered.priority, CoveragePriority::Critical);

        let covered = report
            .areas
            .iter()
            .find(|area| area.area == "Covered")
            .unwrap();
        assert_eq!(covered.asset_count, 2);
        assert_eq!(covered.gap_score, 10);
        assert_eq!(covered.priority, CoveragePriority::Low);
        assert!(covered.missing_asset_types.is_empty());
        assert_eq!(covered.population_per_asset, 1_000.0);
    }

    #[test]
    fn polygon_geometries_take_precedence_and_radius_extends_coverage() {
        let report = analyse_coverage(CoverageInput {
            areas: vec![CoverageAreaInput {
                name: "Polygon".to_string(),
                population: 2_000.0,
                bbox: None,
                polygon: Some(vec![
                    (105.79, 20.99),
                    (105.81, 20.99),
                    (105.81, 21.01),
                    (105.79, 21.01),
                ]),
                asset_types: vec![],
            }],
            // ~104 m outside the east edge/vertex, served by the 200 m radius.
            assets: vec![asset("near", "street_light", 105.811, 20.9901)],
            incidents: vec![],
            service_radius_meters: Some(200.0),
            target_population_per_asset: Some(2_000.0),
            now: Some(0),
        });
        assert_eq!(report.areas[0].asset_count, 1);
        assert_eq!(report.areas[0].gap_score, 20);
    }

    #[test]
    fn old_or_resolved_incidents_do_not_add_pressure() {
        let now = parse_timestamp_millis("2026-11-04T00:00:00Z").unwrap();
        let mut old = incident("old", "open", 105.8, 21.0);
        old.reported_at = Some("2026-01-01T00:00:00Z".to_string());
        let mut resolved = incident("resolved", "resolved", 105.8, 21.0);
        resolved.reported_at = Some("2026-11-03T00:00:00Z".to_string());
        let report = analyse_coverage(CoverageInput {
            areas: vec![CoverageAreaInput {
                name: "Area".to_string(),
                population: 2_000.0,
                bbox: Some(BoundingBox::new(105.79, 20.99, 105.81, 21.01)),
                polygon: None,
                asset_types: vec![],
            }],
            assets: vec![asset("a1", "street_light", 105.8, 21.0)],
            incidents: vec![old, resolved],
            service_radius_meters: Some(100.0),
            target_population_per_asset: Some(2_000.0),
            now: Some(now),
        });
        assert_eq!(report.areas[0].incident_count, 2);
        assert_eq!(report.areas[0].open_incident_count, 0);
        assert_eq!(report.areas[0].gap_score, 20);
    }

    #[test]
    fn json_input_is_accepted() {
        let input = json!({
            "areas": [{
                "name": "A", "population": 1000,
                "bbox": {"minLng": 105.79, "minLat": 20.99, "maxLng": 105.81, "maxLat": 21.01},
                "asset_types": ["street_light"]
            }],
            "assets": [{"id": "a", "feature_type": "street_light", "point": {"longitude": 105.8, "latitude": 21.0}}],
            "incidents": [],
            "serviceRadiusMeters": 100
        });
        let report = analyse_coverage_from_value(&input).unwrap();
        assert_eq!(report.areas[0].asset_count, 1);
        assert_eq!(report.areas[0].population_per_asset, 1000.0);
    }
}
