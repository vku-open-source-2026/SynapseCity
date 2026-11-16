// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Geospatial predicates and distance calculations (port of `src/geo.ts`).
//!
//! The server applies exactly these rules in the nearby/bounds/polygon/geofence
//! endpoints, so the tests assert exact membership on small fixtures.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{first_non_null, js_round, number_from_value};

/// A WGS84 coordinate. Longitude first, matching GeoJSON.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub longitude: f64,
    pub latitude: f64,
}

impl Point {
    pub fn new(longitude: f64, latitude: f64) -> Self {
        Self {
            longitude,
            latitude,
        }
    }
}

/// A south-west/north-east (or any two-corner) bounding box.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundingBox {
    pub min_lng: f64,
    pub min_lat: f64,
    pub max_lng: f64,
    pub max_lat: f64,
}

impl BoundingBox {
    pub fn new(min_lng: f64, min_lat: f64, max_lng: f64, max_lat: f64) -> Self {
        Self {
            min_lng,
            min_lat,
            max_lng,
            max_lat,
        }
    }
}

const EARTH_RADIUS_METERS: f64 = 6_371_000.0;

fn to_radians(value: f64) -> f64 {
    (value * std::f64::consts::PI) / 180.0
}

/// Great-circle distance in metres. Alias kept for callers that use the short
/// TS-style name.
pub fn haversine(a: Point, b: Point) -> f64 {
    haversine_meters(a, b)
}

pub fn haversine_meters(a: Point, b: Point) -> f64 {
    let d_lat = to_radians(b.latitude - a.latitude);
    let d_lng = to_radians(b.longitude - a.longitude);
    let lat1 = to_radians(a.latitude);
    let lat2 = to_radians(b.latitude);
    let h = (d_lat / 2.0).sin().powi(2) + lat1.cos() * lat2.cos() * (d_lng / 2.0).sin().powi(2);
    2.0 * EARTH_RADIUS_METERS * h.sqrt().min(1.0).asin()
}

/// Validates a point: finite coordinates inside the WGS84 range.
pub fn is_valid_point(point: Option<&Point>) -> bool {
    match point {
        Some(point) => {
            point.longitude.is_finite()
                && point.latitude.is_finite()
                && point.longitude.abs() <= 180.0
                && point.latitude.abs() <= 90.0
        }
        None => false,
    }
}

/// Parses `lng|lon|longitude` and `lat|latitude` from a query-like record.
/// `lng`, `lon` and `longitude` are nullish-coalesced exactly like the TS
/// implementation; missing or out-of-range coordinates return `None`.
pub fn parse_point(input: &serde_json::Map<String, Value>) -> Option<Point> {
    let longitude_value = first_non_null(input, &["lng", "lon", "longitude"])?;
    let latitude_value = first_non_null(input, &["lat", "latitude"])?;
    let longitude = number_from_value(longitude_value)?;
    let latitude = number_from_value(latitude_value)?;
    if longitude == 0.0
        && latitude == 0.0
        && input.get("lng").is_none()
        && input.get("lon").is_none()
        && input.get("longitude").is_none()
    {
        return None;
    }
    let point = Point::new(longitude, latitude);
    is_valid_point(Some(&point)).then_some(point)
}

/// Inclusive bounding-box membership, tolerating inverted corners.
pub fn point_in_bounding_box(point: Point, bbox: BoundingBox) -> bool {
    point.longitude >= bbox.min_lng.min(bbox.max_lng)
        && point.longitude <= bbox.min_lng.max(bbox.max_lng)
        && point.latitude >= bbox.min_lat.min(bbox.max_lat)
        && point.latitude <= bbox.min_lat.max(bbox.max_lat)
}

/// Ray-casting point-in-polygon test. Coordinates are `(longitude, latitude)`.
pub fn point_in_polygon(point: Point, polygon: &[(f64, f64)]) -> bool {
    if polygon.len() < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = polygon.len() - 1;
    for i in 0..polygon.len() {
        let (xi, yi) = polygon[i];
        let (xj, yj) = polygon[j];
        let intersects = (yi > point.latitude) != (yj > point.latitude)
            && point.longitude < ((xj - xi) * (point.latitude - yi)) / (yj - yi) + xi;
        if intersects {
            inside = !inside;
        }
        j = i;
    }
    inside
}

fn extract_ring(value: &Value) -> Option<Vec<(f64, f64)>> {
    let ring = value.as_array()?;
    if ring.len() < 3 {
        return None;
    }
    let mut points = Vec::with_capacity(ring.len());
    for entry in ring {
        let pair = entry.as_array()?;
        if pair.len() < 2 {
            return None;
        }
        let longitude = number_from_value(&pair[0])?;
        let latitude = number_from_value(&pair[1])?;
        if !longitude.is_finite() || !latitude.is_finite() {
            return None;
        }
        points.push((longitude, latitude));
    }
    Some(points)
}

/// Accepts either a bare coordinate ring or a GeoJSON Polygon/MultiPolygon and
/// returns the outer ring. Returns `None` for malformed input.
pub fn polygon_coordinates(value: &Value) -> Option<Vec<(f64, f64)>> {
    if let Some(ring) = extract_ring(value) {
        return Some(ring);
    }
    let geometry = value.as_object()?;
    let geometry_type = geometry.get("type")?.as_str()?;
    if geometry_type == "Polygon" {
        let coordinates = geometry.get("coordinates")?.as_array()?;
        return extract_ring(coordinates.first()?);
    }
    if geometry_type == "MultiPolygon" {
        let coordinates = geometry.get("coordinates")?.as_array()?;
        let polygon = coordinates.first()?.as_array()?;
        return extract_ring(polygon.first()?);
    }
    None
}

/// Straight-line travel-time estimate used only when no routing provider is
/// configured. `speed_kmh` defaults to 30 km/h.
pub fn estimated_duration_seconds(distance_meters: f64, speed_kmh: Option<f64>) -> i64 {
    let speed = speed_kmh.unwrap_or(30.0);
    js_round((distance_meters / 1000.0 / speed) * 3600.0) as i64
}

pub fn within_radius(point: Point, center: Point, radius_meters: f64) -> bool {
    haversine_meters(point, center) <= radius_meters
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn haversine_matches_known_hanoi_offset() {
        let hanoi = Point::new(105.8, 21.0);
        let offset = Point::new(105.8005, 21.0);
        let distance = haversine_meters(hanoi, offset);
        assert!(distance > 40.0 && distance < 70.0, "unexpected {distance}");
        assert_eq!(haversine_meters(hanoi, hanoi), 0.0);
    }

    #[test]
    fn bounding_box_and_polygon_membership_are_inclusive() {
        let inside = Point::new(105.8005, 21.0);
        let outside = Point::new(106.0, 21.0);
        let bbox = BoundingBox::new(105.79, 20.99, 105.81, 21.01);
        assert!(point_in_bounding_box(inside, bbox));
        assert!(!point_in_bounding_box(outside, bbox));
        let square = [
            (105.79, 20.99),
            (105.81, 20.99),
            (105.81, 21.01),
            (105.79, 21.01),
        ];
        assert!(point_in_polygon(Point::new(105.8, 21.0), &square));
        assert!(!point_in_polygon(outside, &square));
        assert!(!point_in_polygon(inside, &[(0.0, 0.0), (1.0, 1.0)]));
    }

    #[test]
    fn polygon_coordinates_accepts_ring_and_geojson() {
        let square = json!([
            [105.79, 20.99],
            [105.81, 20.99],
            [105.81, 21.01],
            [105.79, 21.01]
        ]);
        let expected = vec![
            (105.79, 20.99),
            (105.81, 20.99),
            (105.81, 21.01),
            (105.79, 21.01),
        ];
        assert_eq!(polygon_coordinates(&square), Some(expected.clone()));
        let polygon = json!({ "type": "Polygon", "coordinates": [square] });
        assert_eq!(polygon_coordinates(&polygon), Some(expected.clone()));
        let multipolygon = json!({ "type": "MultiPolygon", "coordinates": [[square]] });
        assert_eq!(polygon_coordinates(&multipolygon), Some(expected));
        assert_eq!(polygon_coordinates(&json!([])), None);
        assert_eq!(
            polygon_coordinates(&json!({ "type": "Point", "coordinates": [1, 2] })),
            None
        );
    }

    #[test]
    fn parse_point_handles_aliases_and_invalid_values() {
        let parsed = parse_point(json!({ "lng": "105.8", "lat": "21" }).as_object().unwrap())
            .expect("valid point");
        assert_eq!(parsed.latitude, 21.0);
        assert_eq!(parse_point(json!({}).as_object().unwrap()), None);
        assert_eq!(
            parse_point(json!({ "lng": "nope", "lat": 21 }).as_object().unwrap()),
            None
        );
        assert_eq!(
            parse_point(json!({ "lng": 181, "lat": 21 }).as_object().unwrap()),
            None
        );
        assert_eq!(
            parse_point(json!({ "lon": 0, "latitude": 0 }).as_object().unwrap()),
            Some(Point::new(0.0, 0.0))
        );
    }

    #[test]
    fn duration_uses_default_speed_and_radius_is_inclusive() {
        assert_eq!(estimated_duration_seconds(120_000.0, None), 14_400);
        assert_eq!(estimated_duration_seconds(10_000.0, Some(50.0)), 720);
        let center = Point::new(105.8, 21.0);
        assert!(within_radius(center, center, 0.0));
        assert!(!within_radius(Point::new(105.81, 21.0), center, 100.0));
    }
}
