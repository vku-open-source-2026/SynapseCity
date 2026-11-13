// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! SynapseBase persistence tests against an HTTP mock.

use contribution_backend::storage::{BaseStorage, Storage, FEATURES, SOS_REPORTS, SUBMISSIONS};
use serde_json::json;
use wiremock::matchers::{body_partial_json, header, method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn existing_collections(server: &MockServer) {
    for collection in [FEATURES, SUBMISSIONS, SOS_REPORTS] {
        Mock::given(method("GET"))
            .and(path(format!("/v1/base/collections/{collection}")))
            .and(header("x-api-key", "test-key"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "collection": { "name": collection },
                "stats": { "documents": 0 },
            })))
            .mount(server)
            .await;
    }
}

#[tokio::test]
async fn creates_missing_collections() {
    let server = MockServer::start().await;
    for collection in [FEATURES, SUBMISSIONS, SOS_REPORTS] {
        Mock::given(method("GET"))
            .and(path(format!("/v1/base/collections/{collection}")))
            .respond_with(ResponseTemplate::new(404).set_body_json(json!({
                "error": "not_found",
                "message": "collection not found",
            })))
            .mount(&server)
            .await;
    }
    Mock::given(method("POST"))
        .and(path("/v1/base/collections"))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"ok": true})))
        .mount(&server)
        .await;

    BaseStorage::new(&server.uri(), "test-key").await.unwrap();
    let requests = server.received_requests().await.unwrap();
    let creates = requests
        .iter()
        .filter(|request| request.method.as_str() == "POST")
        .count();
    assert_eq!(creates, 3);
    let names = requests
        .iter()
        .filter(|request| request.method.as_str() == "POST")
        .filter_map(|request| serde_json::from_slice::<serde_json::Value>(&request.body).ok())
        .filter_map(|body| {
            body.get("name")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    assert!(names.contains(&FEATURES.to_string()));
}

#[tokio::test]
async fn normalises_documents_and_aliases_id() {
    let server = MockServer::start().await;
    existing_collections(&server).await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/base/collections/{FEATURES}/query")))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [
                {
                    "id": "doc-1",
                    "version": 2,
                    "data": { "name": "Lamp", "properties": { "feature_type": "Đèn đường" } }
                }
            ],
            "total": 1,
            "limit": 1000,
            "offset": 0,
            "nextCursor": null
        })))
        .mount(&server)
        .await;

    let storage = BaseStorage::new(&server.uri(), "test-key").await.unwrap();
    let features = storage.get_features().await.unwrap();
    assert_eq!(features.len(), 1);
    assert_eq!(features[0]["id"], "doc-1");
    assert_eq!(features[0]["_id"], "doc-1");
    assert_eq!(features[0]["name"], "Lamp");
}

#[tokio::test]
async fn add_feature_sets_defaults_and_feature_code() {
    let server = MockServer::start().await;
    existing_collections(&server).await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/base/collections/{FEATURES}/documents")))
        .and(body_partial_json(json!({
            "data": {
                "id": "fixed-id",
                "type": "Feature",
                "city_synced": false,
                "feature_code": "đèn_đường",
            }
        })))
        .respond_with(ResponseTemplate::new(201).set_body_json(json!({"ok": true})))
        .mount(&server)
        .await;

    let storage = BaseStorage::new(&server.uri(), "test-key").await.unwrap();
    storage
        .add_feature(json!({
            "id": "fixed-id",
            "properties": { "feature_type": "Đèn đường" },
            "geometry": { "type": "Point", "coordinates": [106.7, 10.7] },
        }))
        .await
        .unwrap();
    let requests = server.received_requests().await.unwrap();
    assert!(requests.iter().any(|request| {
        request.method.as_str() == "POST"
            && String::from_utf8_lossy(&request.body).contains("\"feature_code\":\"đèn_đường\"")
    }));
}

#[tokio::test]
async fn mark_synced_batches_updates() {
    let server = MockServer::start().await;
    existing_collections(&server).await;
    Mock::given(method("POST"))
        .and(path(format!("/v1/base/collections/{FEATURES}/query")))
        .and(body_partial_json(json!({
            "where": { "city_synced": false },
            "limit": 10,
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "items": [
                { "id": "a", "data": {} },
                { "id": "b", "data": {} }
            ],
            "total": 2,
            "limit": 10,
            "offset": 0,
            "nextCursor": null
        })))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path(format!(
            "/v1/base/collections/{FEATURES}/documents:batch"
        )))
        .and(body_partial_json(json!({
            "operations": [
                { "op": "update", "id": "a", "data": { "city_synced": true } },
                { "op": "update", "id": "b", "data": { "city_synced": true } }
            ]
        })))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "results": [{ "ok": true }, { "ok": false }]
        })))
        .mount(&server)
        .await;

    let storage = BaseStorage::new(&server.uri(), "test-key").await.unwrap();
    let marked = storage.mark_synced(10).await.unwrap();
    assert_eq!(marked, 1);
}
