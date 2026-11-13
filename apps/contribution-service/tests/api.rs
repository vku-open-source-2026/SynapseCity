// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! HTTP contract tests for the contribution backend.

use async_trait::async_trait;
use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use contribution_backend::auth::JwtKeys;
use contribution_backend::config::{Config, StorageBackend};
use contribution_backend::ratelimit::RateLimiter;
use contribution_backend::state::{AppState, SharedState};
use contribution_backend::storage::{Storage, StorageResult};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tower::ServiceExt;

#[derive(Default)]
struct MockStorage {
    features: Mutex<Vec<Value>>,
    contributions: Mutex<Vec<Value>>,
    sos: Mutex<Vec<Value>>,
    marked: AtomicI64,
}

#[async_trait]
impl Storage for MockStorage {
    async fn get_features(&self) -> StorageResult<Vec<Value>> {
        Ok(self.features.lock().await.clone())
    }

    async fn add_feature(&self, mut feature: Value) -> StorageResult<()> {
        let mut features = self.features.lock().await;
        if feature.get("id").is_none() {
            feature["id"] = json!(format!("f{}", features.len() + 1));
        }
        features.push(feature);
        Ok(())
    }

    async fn delete_feature(&self, feature_id: &str) -> StorageResult<bool> {
        let mut features = self.features.lock().await;
        let before = features.len();
        features.retain(|feature| feature.get("id").and_then(Value::as_str) != Some(feature_id));
        Ok(features.len() < before)
    }

    async fn add_contribution(&self, mut contribution: Value) -> StorageResult<()> {
        let mut contributions = self.contributions.lock().await;
        if contribution.get("id").is_none() {
            contribution["id"] = json!(format!("c{}", contributions.len() + 1));
        }
        contributions.push(contribution);
        Ok(())
    }

    async fn get_pending_contributions(&self) -> StorageResult<Vec<Value>> {
        Ok(self
            .contributions
            .lock()
            .await
            .iter()
            .filter(|item| item.get("status").and_then(Value::as_str) == Some("pending"))
            .cloned()
            .collect())
    }

    async fn approve_contribution(&self, contribution_id: &str) -> StorageResult<bool> {
        let mut contributions = self.contributions.lock().await;
        let Some(item) = contributions
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(contribution_id))
        else {
            return Ok(false);
        };
        item["status"] = json!("approved");
        let mut feature = item.clone();
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
            object.insert("id".to_string(), json!(format!("f-{contribution_id}")));
        }
        self.features.lock().await.push(feature);
        Ok(true)
    }

    async fn reject_contribution(&self, contribution_id: &str) -> StorageResult<bool> {
        let mut contributions = self.contributions.lock().await;
        let before = contributions.len();
        contributions
            .retain(|item| item.get("id").and_then(Value::as_str) != Some(contribution_id));
        Ok(contributions.len() < before)
    }

    async fn get_leaderboard(&self) -> StorageResult<Value> {
        let contributions = self.contributions.lock().await;
        let mut stats: std::collections::HashMap<String, (String, String, i64)> =
            std::collections::HashMap::new();
        for item in contributions.iter() {
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
                json!({ "msv": msv, "contributor_name": name, "unit": unit, "count": count })
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

    async fn add_sos_report(&self, mut report: Value) -> StorageResult<()> {
        let mut reports = self.sos.lock().await;
        if report.get("id").is_none() {
            report["id"] = json!(format!("s{}", reports.len() + 1));
        }
        reports.push(report);
        Ok(())
    }

    async fn get_sos_reports(&self, status: Option<&str>) -> StorageResult<Vec<Value>> {
        Ok(self
            .sos
            .lock()
            .await
            .iter()
            .filter(|item| {
                status
                    .map(|status| item.get("status").and_then(Value::as_str) == Some(status))
                    .unwrap_or(true)
            })
            .cloned()
            .collect())
    }

    async fn update_sos_status(&self, report_id: &str, next_status: &str) -> StorageResult<bool> {
        let mut reports = self.sos.lock().await;
        let Some(report) = reports
            .iter_mut()
            .find(|item| item.get("id").and_then(Value::as_str) == Some(report_id))
        else {
            return Ok(false);
        };
        report["status"] = json!(next_status);
        Ok(true)
    }

    async fn mark_synced(&self, limit: i64) -> StorageResult<i64> {
        let mut features = self.features.lock().await;
        let mut marked = 0;
        for feature in features.iter_mut().take(limit.max(0) as usize) {
            feature["city_synced"] = json!(true);
            marked += 1;
        }
        self.marked.store(marked, Ordering::SeqCst);
        Ok(marked)
    }
}

fn test_config() -> Config {
    Config {
        bind: "127.0.0.1:0".to_string(),
        storage_backend: StorageBackend::Json,
        synapseone_base_url: "https://api.synapseone.space".to_string(),
        synapseone_api_key: String::new(),
        sync_shared_secret: Some("testsecret".to_string()),
        vietmap_api_key: None,
        jwt_secret: "0123456789abcdef0123456789abcdef".to_string(),
        access_token_expire_minutes: 60,
        refresh_token_expire_days: 7,
        admin_username: "admin".to_string(),
        admin_password: "test-password-123".to_string(),
        environment: "test".to_string(),
        cors_origins: vec!["https://contribution.synapsecity.sbs".to_string()],
        trust_proxy_headers: true,
        json_storage_dir: PathBuf::from("."),
        body_limit_bytes: 25 * 1024 * 1024,
        request_timeout: Duration::from_secs(60),
    }
}

fn test_state(config: Config) -> (SharedState, String) {
    let jwt = JwtKeys::new(
        &config.jwt_secret,
        config.access_token_expire_minutes,
        config.refresh_token_expire_days,
    );
    let token = jwt.access_token("admin").unwrap();
    let state: SharedState = Arc::new(AppState {
        config: Arc::new(config),
        storage: Arc::new(MockStorage::default()),
        jwt,
        limiter: RateLimiter::new(),
        http: reqwest::Client::new(),
    });
    (state, token)
}

async fn body_json(response: axum::response::Response) -> Value {
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    serde_json::from_slice(&bytes).unwrap_or(Value::Null)
}

fn request(
    method: Method,
    uri: &str,
    body: Option<Value>,
    token: Option<&str>,
    ip: &str,
) -> Request<Body> {
    let mut builder = Request::builder()
        .method(method)
        .uri(uri)
        .header("x-forwarded-for", ip);
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    match body {
        Some(body) => builder
            .header("content-type", "application/json")
            .body(Body::from(serde_json::to_vec(&body).unwrap()))
            .unwrap(),
        None => builder.body(Body::empty()).unwrap(),
    }
}

async fn call(app: &Router, request: Request<Body>) -> (StatusCode, Value) {
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let body = body_json(response).await;
    (status, body)
}

#[tokio::test]
async fn health_is_public() {
    let (state, _) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/health")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = body_json(response).await;
    assert_eq!(body["status"], "ok");
}

#[tokio::test]
async fn login_and_refresh() {
    let (state, _) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "username": "admin", "password": "test-password-123" })),
            None,
            "10.0.0.1",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["token_type"], "bearer");
    let refresh = body["refresh_token"].as_str().unwrap().to_string();

    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/auth/refresh",
            Some(json!({ "refresh_token": refresh })),
            None,
            "10.0.0.1",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(body["access_token"].as_str().is_some());
}

#[tokio::test]
async fn login_rejects_bad_password() {
    let (state, _) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "username": "admin", "password": "wrong" })),
            None,
            "10.0.0.2",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["detail"], "Incorrect username or password");
}

#[tokio::test]
async fn login_is_rate_limited() {
    let (state, _) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    for _ in 0..5 {
        let (status, _) = call(
            &app,
            request(
                Method::POST,
                "/api/auth/login",
                Some(json!({ "username": "admin", "password": "wrong" })),
                None,
                "10.0.0.3",
            ),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/auth/login",
            Some(json!({ "username": "admin", "password": "wrong" })),
            None,
            "10.0.0.3",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(body["detail"], "Rate limit exceeded");
}

#[tokio::test]
async fn missing_and_bad_auth_match_fastapi() {
    let (state, token) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(Method::GET, "/api/contributions", None, None, "10.0.0.4"),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["detail"], "Not authenticated");

    let (status, body) = call(
        &app,
        request(
            Method::GET,
            "/api/contributions",
            None,
            Some("not-a-jwt"),
            "10.0.0.4",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["detail"], "Could not validate credentials");

    let (status, _) = call(
        &app,
        request(
            Method::GET,
            "/api/contributions",
            None,
            Some(&token),
            "10.0.0.4",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn anonymous_contribution_is_hidden_from_leaderboard() {
    let (state, token) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/contributions",
            Some(json!({
                "properties": { "feature_type": "Đèn đường", "name": "Anonymous lamp" },
                "geometry": { "type": "Point", "coordinates": [106.7, 10.7] },
            })),
            None,
            "10.0.0.5",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "success");

    let (status, body) = call(
        &app,
        request(
            Method::GET,
            "/api/contributions",
            None,
            Some(&token),
            "10.0.0.5",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body[0]["contributor_name"], "Ẩn danh");
    assert_eq!(body[0]["msv"], "ANON");
    assert_eq!(body[0]["unit"], "Ẩn danh");
    assert_eq!(body[0]["anonymous"], true);
}

#[tokio::test]
async fn approve_then_leaderboard() {
    let (state, token) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, _) = call(
        &app,
        request(
            Method::POST,
            "/api/contributions",
            Some(json!({
                "contributor_name": "Nguyen Van A",
                "msv": "23AI034",
                "unit": "VKU",
                "properties": { "feature_type": "Trạm điện" },
                "geometry": { "type": "Point", "coordinates": [106.7, 10.7] },
            })),
            None,
            "10.0.0.6",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, list) = call(
        &app,
        request(
            Method::GET,
            "/api/contributions",
            None,
            Some(&token),
            "10.0.0.6",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let id = list[0]["id"].as_str().unwrap().to_string();

    let (status, _) = call(
        &app,
        request(
            Method::POST,
            &format!("/api/contributions/{id}/approve"),
            Some(json!({})),
            Some(&token),
            "10.0.0.6",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, leaderboard) = call(
        &app,
        request(Method::GET, "/api/leaderboard", None, None, "10.0.0.6"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(leaderboard[0]["msv"], "23AI034");
    assert_eq!(leaderboard[0]["count"], 1);
    assert_eq!(leaderboard[0]["contributor_name"], "Nguyen Van A");
}

#[tokio::test]
async fn feature_create_list_and_delete() {
    let (state, token) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, _) = call(
        &app,
        request(
            Method::POST,
            "/api/features",
            Some(json!({
                "type": "Feature",
                "properties": { "feature_type": "Cột điện", "name": "Pole" },
                "geometry": { "type": "Point", "coordinates": [106.7, 10.7] },
            })),
            Some(&token),
            "10.0.0.7",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, features) = call(
        &app,
        request(Method::GET, "/api/features", None, None, "10.0.0.7"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(features["type"], "FeatureCollection");
    assert_eq!(features["features"].as_array().unwrap().len(), 1);
    let id = features["features"][0]["id"].as_str().unwrap().to_string();

    let (status, _) = call(
        &app,
        request(
            Method::DELETE,
            &format!("/api/features/{id}"),
            None,
            Some(&token),
            "10.0.0.7",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn sync_ack_requires_the_shared_secret() {
    let (state, _) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/sync/ack",
            Some(json!({ "limit": 10 })),
            None,
            "10.0.0.8",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(body["detail"], "Invalid sync secret");

    let mut request_with_secret = request(
        Method::POST,
        "/api/sync/ack",
        Some(json!({ "limit": 10 })),
        None,
        "10.0.0.8",
    );
    request_with_secret
        .headers_mut()
        .insert("x-sync-secret", "testsecret".parse().unwrap());
    let (status, body) = call(&app, request_with_secret).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "success");
}

#[tokio::test]
async fn export_csv_is_public_and_has_bom() {
    let (state, _) = test_state(test_config());
    // Seed a feature through the public mock store.
    state
        .storage
        .add_feature(json!({
            "id": "f1",
            "type": "Feature",
            "feature_code": "den_duong",
            "properties": { "feature_type": "Đèn đường", "name": "A" },
            "geometry": { "type": "Point", "coordinates": [106.7, 10.7] },
        }))
        .await
        .unwrap();
    let app = contribution_backend::routes::router(state);
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/export_csv")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "text/csv; charset=utf-8"
    );
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(bytes.starts_with(&[0xEF, 0xBB, 0xBF]));
    let text = String::from_utf8(bytes[3..].to_vec()).unwrap();
    assert!(text.contains("feature_type,feature_code,geometry,name"));
    assert!(
        text.contains("Đèn đường,den_duong,\"POINT [106.7, 10.7]\",A"),
        "{text:?}"
    );
}

#[tokio::test]
async fn map_config_defaults_to_osm() {
    let (state, _) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(Method::GET, "/api/map/config", None, None, "10.0.0.9"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["provider"], "osm");
}

#[tokio::test]
async fn sos_create_ack_and_resolve() {
    let (state, token) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/sos",
            Some(json!({
                "contributor_name": "Nguyen Van A",
                "msv": "23AI034",
                "unit": "VKU",
                "emergency_type": "fire",
                "severity": "HIGH",
                "message": "Smoke near the market",
                "district": "Quan 1",
                "geometry": { "type": "Point", "coordinates": [106.7, 10.7] },
            })),
            None,
            "10.0.0.10",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], "success");

    let (status, reports) = call(
        &app,
        request(Method::GET, "/api/sos", None, Some(&token), "10.0.0.10"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reports[0]["severity"], "high");
    assert_eq!(reports[0]["status"], "pending");
    let id = reports[0]["id"].as_str().unwrap().to_string();

    let (status, _) = call(
        &app,
        request(
            Method::POST,
            &format!("/api/sos/{id}/ack"),
            Some(json!({})),
            Some(&token),
            "10.0.0.10",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, reports) = call(
        &app,
        request(
            Method::GET,
            "/api/sos?status=acknowledged",
            None,
            Some(&token),
            "10.0.0.10",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reports[0]["status"], "acknowledged");

    let (status, _) = call(
        &app,
        request(
            Method::POST,
            &format!("/api/sos/{id}/resolve"),
            Some(json!({})),
            Some(&token),
            "10.0.0.10",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn sos_rejects_invalid_severity() {
    let (state, _) = test_state(test_config());
    let app = contribution_backend::routes::router(state);
    let (status, body) = call(
        &app,
        request(
            Method::POST,
            "/api/sos",
            Some(json!({
                "contributor_name": "A",
                "msv": "1",
                "emergency_type": "fire",
                "severity": "urgent",
                "message": "Smoke",
            })),
            None,
            "10.0.0.11",
        ),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(body["detail"][0]["loc"][1], "severity");
}
