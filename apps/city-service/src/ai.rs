// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Tier-2 AI adapter for the City service.

use std::time::{Duration, Instant};

use serde_json::{json, Value};
use synapsedx::RequestOptions;

use crate::error::ApiError;
use crate::state::AppState;

const AI_DEPENDENCY: &str = "https://github.com/vku-open-source-2026/SynapseDX/issues/11";
const STATUS_TTL: Duration = Duration::from_secs(10);

fn extract_message(payload: &Value) -> (String, Option<String>) {
    if let Some(text) = payload.as_str() {
        return (text.to_string(), None);
    }
    let Some(object) = payload.as_object() else {
        return (String::new(), None);
    };
    let choice = object
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|values| values.first())
        .and_then(Value::as_object);
    let message = choice
        .and_then(|choice| choice.get("message"))
        .and_then(Value::as_object);
    let content = message
        .and_then(|message| message.get("content"))
        .or_else(|| object.get("message"))
        .or_else(|| object.get("content"))
        .or_else(|| object.get("response"));
    let text = content
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    (
        text,
        object.get("model").and_then(Value::as_str).map(str::to_string),
    )
}

pub async fn ai_status(state: &AppState, opts: &RequestOptions) -> Value {
    {
        let cache = state.ai_status_cache.lock().unwrap_or_else(|poison| poison.into_inner());
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < STATUS_TTL {
                return value.clone();
            }
        }
    }
    let value = match state.tier2.ai().status(opts).await {
        Ok(upstream) => {
            let status = upstream
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            json!({
                "status": if status == "ok" { "ready" } else { "degraded" },
                "service": "synapsecity-ai",
                "provider": "synapsedx",
                "configured": true,
                "upstream": upstream,
                "dependency": if status == "ok" { Value::Null } else { json!(AI_DEPENDENCY) },
            })
        }
        Err(error) => json!({
            "status": "unavailable",
            "service": "synapsecity-ai",
            "provider": "synapsedx",
            "configured": false,
            "dependency": AI_DEPENDENCY,
            "detail": match error.status() {
                Some(401 | 403) => "Tier-2 AI capability rejected the service credential.",
                Some(404 | 501) => "Tier-2 AI capability is not published on this deployment.",
                _ => "Tier-2 AI capability is unreachable.",
            },
        }),
    };
    let mut cache = state.ai_status_cache.lock().unwrap_or_else(|poison| poison.into_inner());
    *cache = Some((Instant::now(), value.clone()));
    value
}

pub async fn ai_chat(
    state: &AppState,
    opts: &RequestOptions,
    message: &str,
    context: Option<Value>,
) -> Result<Value, ApiError> {
    let system = "You are the SynapseCity infrastructure operations assistant. Answer using only the supplied City context. If the data is insufficient, say so.";
    let mut messages = vec![json!({ "role": "system", "content": system })];
    if let Some(context) = context.filter(|value| value.as_object().map(|map| !map.is_empty()).unwrap_or(false)) {
        messages.push(json!({
            "role": "user",
            "content": format!("City context: {}", serde_json::to_string(&context).unwrap_or_default()),
        }));
    }
    messages.push(json!({ "role": "user", "content": message }));
    let upstream = state
        .tier2
        .ai()
        .chat(Value::Array(messages), None, None, None, opts)
        .await
        .map_err(|error| {
            ApiError::unavailable("ai_capability_unavailable", "Tier-2 AI capability is unavailable.")
                .with_dependency(AI_DEPENDENCY)
                .with_details(json!({ "upstream_status": error.status() }))
        })?;
    let (answer, model) = extract_message(&upstream);
    if answer.trim().is_empty() {
        return Err(ApiError::unavailable(
            "ai_empty_response",
            "Tier-2 AI capability returned an empty answer.",
        )
        .with_dependency(AI_DEPENDENCY));
    }
    Ok(json!({
        "message": answer,
        "citations": [],
        "provider": "synapsedx",
        "model": model,
        "upstream": upstream,
    }))
}
