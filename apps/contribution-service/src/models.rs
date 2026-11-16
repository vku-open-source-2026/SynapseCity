// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Request models and validation mirroring the Python/Pydantic backend.

use crate::error::ApiError;
use crate::util::{is_geometry, python_repr, sanitize_html, sanitize_json_strings};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub token_type: String,
}

impl TokenResponse {
    pub fn new(access_token: String, refresh_token: String) -> Self {
        Self {
            access_token,
            refresh_token,
            token_type: "bearer".to_string(),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub struct ContributionInput {
    #[serde(default)]
    pub contributor_name: Option<String>,
    #[serde(default)]
    pub msv: Option<String>,
    #[serde(default)]
    pub unit: Option<String>,
    #[serde(default)]
    pub anonymous: bool,
    pub properties: Map<String, Value>,
    pub geometry: Value,
}

#[derive(Debug)]
pub struct ValidatedContribution {
    pub contributor_name: String,
    pub msv: String,
    pub unit: String,
    pub anonymous: bool,
    pub properties: Value,
    pub geometry: Value,
}

impl ContributionInput {
    pub fn validate(self) -> Result<ValidatedContribution, ApiError> {
        let mut name = self
            .contributor_name
            .map(|value| sanitize_html(value.trim()))
            .filter(|value| !value.is_empty());
        let mut msv = self
            .msv
            .map(|value| sanitize_html(value.trim()))
            .filter(|value| !value.is_empty());

        if name.is_none() && msv.is_none() {
            // No identity supplied: store an anonymous contribution.
            return Ok(ValidatedContribution {
                contributor_name: "Ẩn danh".to_string(),
                msv: "ANON".to_string(),
                unit: "Ẩn danh".to_string(),
                anonymous: true,
                properties: validate_properties(self.properties)?,
                geometry: validate_geometry(self.geometry)?,
            });
        }

        if self.anonymous {
            return Ok(ValidatedContribution {
                contributor_name: "Ẩn danh".to_string(),
                msv: "ANON".to_string(),
                unit: "Ẩn danh".to_string(),
                anonymous: true,
                properties: validate_properties(self.properties)?,
                geometry: validate_geometry(self.geometry)?,
            });
        }

        let name_value = name.take().ok_or_else(|| {
            ApiError::validation(
                "contributor_name",
                "contributor_name and msv are required unless anonymous",
            )
        })?;
        let msv_value = msv.take().ok_or_else(|| {
            ApiError::validation(
                "msv",
                "contributor_name and msv are required unless anonymous",
            )
        })?;

        if name_value.chars().count() > 100 {
            return Err(ApiError::validation(
                "contributor_name",
                "ensure this value has at most 100 characters",
            ));
        }
        if msv_value.chars().count() > 20 {
            return Err(ApiError::validation(
                "msv",
                "ensure this value has at most 20 characters",
            ));
        }

        Ok(ValidatedContribution {
            contributor_name: name_value,
            msv: msv_value,
            unit: self
                .unit
                .map(|value| sanitize_html(value.trim()))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "VKU".to_string()),
            anonymous: false,
            properties: validate_properties(self.properties)?,
            geometry: validate_geometry(self.geometry)?,
        })
    }
}

fn validate_properties(properties: Map<String, Value>) -> Result<Value, ApiError> {
    let value = Value::Object(properties);
    let size = python_repr(&value).chars().count();
    if size > 10_000 {
        return Err(ApiError::validation(
            "properties",
            "Properties payload too large (max 10KB)",
        ));
    }
    Ok(sanitize_json_strings(&value))
}

const MAX_GEOMETRY_CHARS: usize = 16_000;
const MAX_GEOMETRY_POSITIONS: usize = 2_000;

fn validate_position(value: &Value) -> Result<(), ApiError> {
    let Some(position) = value.as_array() else {
        return Err(ApiError::validation(
            "geometry",
            "Each coordinate must be a [longitude, latitude] array",
        ));
    };
    if position.len() < 2 || position.len() > 3 {
        return Err(ApiError::validation(
            "geometry",
            "Each coordinate must contain longitude and latitude",
        ));
    }
    let longitude = position[0].as_f64();
    let latitude = position[1].as_f64();
    let altitude = position.get(2).map(Value::as_f64);
    if longitude
        .filter(|value| value.is_finite() && (-180.0..=180.0).contains(value))
        .is_none()
        || latitude
            .filter(|value| value.is_finite() && (-90.0..=90.0).contains(value))
            .is_none()
        || (position.len() == 3
            && altitude
                .flatten()
                .filter(|value| value.is_finite())
                .is_none())
    {
        return Err(ApiError::validation(
            "geometry",
            "Coordinates must be finite and inside longitude [-180,180], latitude [-90,90]",
        ));
    }
    Ok(())
}

fn validate_positions(
    values: &[Value],
    minimum: usize,
    budget: &mut usize,
) -> Result<(), ApiError> {
    if values.len() < minimum {
        return Err(ApiError::validation(
            "geometry",
            format!("Geometry must contain at least {minimum} positions"),
        ));
    }
    if values.len() > *budget {
        return Err(ApiError::validation(
            "geometry",
            format!("Geometry exceeds {MAX_GEOMETRY_POSITIONS} positions"),
        ));
    }
    *budget -= values.len();
    for value in values {
        validate_position(value)?;
    }
    Ok(())
}

fn validate_geometry_value(geometry_type: &str, coordinates: &Value) -> Result<(), ApiError> {
    let mut budget = MAX_GEOMETRY_POSITIONS;
    let Some(values) = coordinates.as_array() else {
        return Err(ApiError::validation(
            "geometry",
            "geometry.coordinates must be an array",
        ));
    };
    match geometry_type {
        "Point" => validate_positions(std::slice::from_ref(coordinates), 1, &mut budget),
        "LineString" => validate_positions(values, 2, &mut budget),
        "Polygon" => {
            if values.is_empty() {
                return Err(ApiError::validation(
                    "geometry",
                    "Polygon must contain at least one ring",
                ));
            }
            for ring in values {
                let Some(ring) = ring.as_array() else {
                    return Err(ApiError::validation(
                        "geometry",
                        "Polygon rings must be arrays of positions",
                    ));
                };
                validate_positions(ring, 4, &mut budget)?;
            }
            Ok(())
        }
        _ => Err(ApiError::validation(
            "geometry",
            "geometry.type must be Point, LineString or Polygon",
        )),
    }
}

fn validate_geometry(geometry: Value) -> Result<Value, ApiError> {
    if !is_geometry(&geometry) {
        return Err(ApiError::validation(
            "geometry",
            "geometry must contain type and coordinates",
        ));
    }
    if python_repr(&geometry).chars().count() > MAX_GEOMETRY_CHARS {
        return Err(ApiError::validation(
            "geometry",
            format!("Geometry payload too large (max {MAX_GEOMETRY_CHARS} characters)"),
        ));
    }
    let geometry_type = geometry
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let coordinates = geometry.get("coordinates").cloned().unwrap_or(Value::Null);
    validate_geometry_value(&geometry_type, &coordinates)?;
    Ok(geometry)
}

#[derive(Debug, Deserialize)]
pub struct SOSReportInput {
    pub contributor_name: String,
    pub msv: String,
    #[serde(default)]
    pub unit: Option<String>,
    pub emergency_type: String,
    pub severity: String,
    pub message: String,
    #[serde(default)]
    pub district: Option<String>,
    #[serde(default)]
    pub ward: Option<String>,
    #[serde(default)]
    pub contact_phone: Option<String>,
    #[serde(default)]
    pub geometry: Option<Value>,
}

#[derive(Debug)]
pub struct ValidatedSos {
    pub contributor_name: String,
    pub msv: String,
    pub unit: String,
    pub emergency_type: String,
    pub severity: String,
    pub message: String,
    pub district: Option<String>,
    pub ward: Option<String>,
    pub contact_phone: Option<String>,
    pub geometry: Option<Value>,
}

impl SOSReportInput {
    pub fn validate(self) -> Result<ValidatedSos, ApiError> {
        let contributor_name = clean_required("contributor_name", &self.contributor_name, 1, 100)?;
        let msv = clean_required("msv", &self.msv, 1, 20)?;
        let emergency_type = clean_required("emergency_type", &self.emergency_type, 2, 50)?;
        let message = clean_required("message", &self.message, 5, 2_000)?;
        let severity_raw = sanitize_html(self.severity.trim()).to_lowercase();
        if !(3..=20).contains(&severity_raw.chars().count()) {
            return Err(ApiError::validation(
                "severity",
                "ensure this value has between 3 and 20 characters",
            ));
        }
        if !matches!(
            severity_raw.as_str(),
            "low" | "medium" | "high" | "critical"
        ) {
            return Err(ApiError::validation(
                "severity",
                "Severity must be one of: low, medium, high, critical",
            ));
        }

        let district = clean_optional("district", self.district, 120)?;
        let ward = clean_optional("ward", self.ward, 120)?;
        let contact_phone = clean_optional("contact_phone", self.contact_phone, 30)?;

        let geometry = match self.geometry {
            Some(value) => {
                if !is_geometry(&value) {
                    return Err(ApiError::validation(
                        "geometry",
                        "geometry must contain type and coordinates",
                    ));
                }
                if python_repr(&value).chars().count() > 5_000 {
                    return Err(ApiError::validation(
                        "geometry",
                        "Geometry payload too large (max 5KB)",
                    ));
                }
                Some(value)
            }
            None => None,
        };

        Ok(ValidatedSos {
            contributor_name,
            msv,
            unit: self
                .unit
                .map(|value| sanitize_html(value.trim()))
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "VKU".to_string()),
            emergency_type,
            severity: severity_raw,
            message,
            district,
            ward,
            contact_phone,
            geometry,
        })
    }
}

fn clean_required(field: &str, value: &str, min: usize, max: usize) -> Result<String, ApiError> {
    let cleaned = sanitize_html(value.trim());
    let length = cleaned.chars().count();
    if length < min {
        return Err(ApiError::validation(
            field,
            format!("ensure this value has at least {min} characters"),
        ));
    }
    if length > max {
        return Err(ApiError::validation(
            field,
            format!("ensure this value has at most {max} characters"),
        ));
    }
    Ok(cleaned)
}

fn clean_optional(
    field: &str,
    value: Option<String>,
    max: usize,
) -> Result<Option<String>, ApiError> {
    match value {
        Some(value) => {
            let cleaned = sanitize_html(value.trim());
            if cleaned.chars().count() > max {
                return Err(ApiError::validation(
                    field,
                    format!("ensure this value has at most {max} characters"),
                ));
            }
            Ok(Some(cleaned))
        }
        None => Ok(None),
    }
}

#[derive(Debug, Deserialize)]
pub struct FeatureInput {
    #[serde(rename = "type", default = "default_feature_type")]
    pub feature_type: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub feature_code: Option<String>,
    pub properties: Map<String, Value>,
    pub geometry: Value,
}

fn default_feature_type() -> String {
    "Feature".to_string()
}

impl FeatureInput {
    pub fn validate(self) -> Result<Value, ApiError> {
        let properties = sanitize_json_strings(&Value::Object(self.properties));
        let geometry = validate_geometry(self.geometry)?;
        let feature_type = sanitize_html(self.feature_type.trim());
        let feature_code = self
            .feature_code
            .map(|value| sanitize_html(value.trim()))
            .filter(|value| !value.is_empty());

        let mut object = Map::new();
        object.insert("type".to_string(), Value::String(feature_type));
        if let Some(id) = self.id {
            object.insert("id".to_string(), Value::String(id));
        }
        if let Some(feature_code) = feature_code {
            object.insert("feature_code".to_string(), Value::String(feature_code));
        }
        object.insert("properties".to_string(), properties);
        object.insert("geometry".to_string(), geometry);
        Ok(Value::Object(object))
    }
}

#[derive(Debug, Deserialize)]
pub struct SosQuery {
    #[serde(default)]
    pub status: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExportQuery {
    #[serde(default)]
    pub types: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn geometry_accepts_bounded_shapes() {
        for geometry in [
            json!({"type": "Point", "coordinates": [106.7, 10.7]}),
            json!({"type": "LineString", "coordinates": [[106.7, 10.7], [106.8, 10.8]]}),
            json!({"type": "Polygon", "coordinates": [[[106.7, 10.7], [106.8, 10.7], [106.8, 10.8], [106.7, 10.7]]]}),
        ] {
            assert!(validate_geometry(geometry).is_ok());
        }
    }

    #[test]
    fn geometry_rejects_oversized_and_invalid_values() {
        let too_many: Vec<Value> = (0..2_001)
            .map(|index| json!([106.0 + (index as f64 / 10_000.0), 10.0]))
            .collect();
        let error = validate_geometry_value("LineString", &json!(too_many.clone())).unwrap_err();
        assert!(error.detail.to_string().contains("2000 positions"));
        let error =
            validate_geometry(json!({"type": "LineString", "coordinates": too_many})).unwrap_err();
        assert!(error.detail.to_string().contains("too large"));

        let error =
            validate_geometry(json!({"type": "Point", "coordinates": [181.0, 10.0]})).unwrap_err();
        assert!(error.detail.to_string().contains("longitude"));

        let error =
            validate_geometry(json!({"type": "MultiPoint", "coordinates": [[106.0, 10.0]]}))
                .unwrap_err();
        assert!(error
            .detail
            .to_string()
            .contains("Point, LineString or Polygon"));
    }
}
