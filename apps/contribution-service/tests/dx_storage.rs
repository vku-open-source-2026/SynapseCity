// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 pagination and bootstrap tests against an HTTP mock.

use contribution_backend::storage::{DxStorage, Storage, FEATURES_DATASET};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

async fn existing_datasets(server: &MockServer) {
    let specs = [
        (
            FEATURES_DATASET,
            "SynapseCity contribution features",
            "ContributionFeature",
            "Approved city infrastructure features from public contributions",
            true,
        ),
        (
            "city-contribution-submissions",
            "SynapseCity contribution submissions",
            "ContributionSubmission",
            "Pending/approved public contributions",
            false,
        ),
        (
            "city-contribution-sos-reports",
            "SynapseCity contribution SOS reports",
            "ContributionSosReport",
            "Public citizen SOS reports collected by the contribution portal",
            false,
        ),
    ];
    for (id, name, entity_type, description, public) in specs {
        Mock::given(method("GET"))
            .and(path(format!("/v1/capabilities/datasets/{id}")))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "id": id,
                "slug": id,
                "name": name,
                "entityType": entity_type,
                "license": "PDDL-1.0",
                "description": description,
                "public": public,
                "status": if public { "published" } else { "draft" },
                "schemaVersion": "1.0.0",
            })))
            .mount(server)
            .await;
    }
}

fn records(count: usize) -> Vec<Value> {
    (0..count)
        .map(|index| {
            json!({
                "id": format!("record-{index}"),
                "data": { "name": format!("record-{index}") },
                "version": 1,
                "createdAt": "2026-11-26T00:00:00Z",
                "updatedAt": "2026-11-26T00:00:00Z",
            })
        })
        .collect()
}

#[tokio::test]
async fn query_all_reads_more_than_ten_thousand_records_without_truncation() {
    let server = MockServer::start().await;
    existing_datasets(&server).await;
    let state = Arc::new(Mutex::new(records(10_005)));
    let responder_state = Arc::clone(&state);
    let requests = Arc::new(AtomicUsize::new(0));
    let responder_requests = Arc::clone(&requests);
    Mock::given(method("POST"))
        .and(path(format!(
            "/v1/capabilities/datasets/{FEATURES_DATASET}/records/query"
        )))
        .respond_with(move |request: &wiremock::Request| {
            responder_requests.fetch_add(1, Ordering::SeqCst);
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let limit = body["limit"].as_i64().unwrap_or(500) as usize;
            let offset = body["offset"].as_i64().unwrap_or(0) as usize;
            let state = responder_state.lock().unwrap();
            let end = (offset + limit).min(state.len());
            let items = state[offset..end].to_vec();
            ResponseTemplate::new(200).set_body_json(json!({
                "items": items,
                "total": state.len(),
                "limit": limit,
                "offset": offset,
                "nextCursor": null,
            }))
        })
        .mount(&server)
        .await;

    let storage = DxStorage::new(&server.uri(), "test-key", "", 20)
        .await
        .unwrap();
    let features = storage.get_features().await.unwrap();
    assert_eq!(features.len(), 10_005);
    assert_eq!(requests.load(Ordering::SeqCst), 21);
    let ids: HashSet<_> = features
        .iter()
        .map(|feature| feature["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids.len(), 10_005);
}

#[tokio::test]
async fn cursor_pagination_does_not_skip_initial_rows_during_concurrent_inserts() {
    let server = MockServer::start().await;
    existing_datasets(&server).await;
    let initial = records(1_200);
    let state = Arc::new(Mutex::new(initial.clone()));
    let responder_state = Arc::clone(&state);
    Mock::given(method("POST"))
        .and(path(format!(
            "/v1/capabilities/datasets/{FEATURES_DATASET}/records/query"
        )))
        .respond_with(move |request: &wiremock::Request| {
            let body: Value = serde_json::from_slice(&request.body).unwrap();
            let mut state = responder_state.lock().unwrap();
            if body.get("cursor").is_none() {
                let items = state[..500].to_vec();
                state.insert(
                    0,
                    json!({
                        "id": "concurrent-insert",
                        "data": { "name": "concurrent-insert" },
                        "version": 1,
                    }),
                );
                return ResponseTemplate::new(200).set_body_json(json!({
                    "items": items,
                    "total": state.len(),
                    "limit": 500,
                    "offset": 0,
                    "nextCursor": "after-500",
                }));
            }
            let cursor = body["cursor"].as_str().unwrap();
            let consumed = cursor
                .trim_start_matches("after-")
                .parse::<usize>()
                .unwrap();
            // The new row shifted offset pagination by one. A real cursor keeps
            // its position; this mock models that by skipping only the insert.
            let start = consumed + 1;
            let end = (start + 500).min(state.len());
            let items = state[start..end].to_vec();
            let next_cursor = if end < state.len() {
                json!(format!("after-{}", end - 1))
            } else {
                Value::Null
            };
            ResponseTemplate::new(200).set_body_json(json!({
                "items": items,
                "total": state.len(),
                "limit": 500,
                "offset": start,
                "nextCursor": next_cursor,
            }))
        })
        .mount(&server)
        .await;

    let storage = DxStorage::new(&server.uri(), "test-key", "", 20)
        .await
        .unwrap();
    let features = storage.get_features().await.unwrap();
    assert_eq!(features.len(), 1_200);
    let ids: HashSet<_> = features
        .iter()
        .map(|feature| feature["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids.len(), 1_200, "offset drift must not duplicate rows");
    for record in initial {
        assert!(
            ids.contains(record["id"].as_str().unwrap()),
            "initial row {} was skipped",
            record["id"]
        );
    }
}
