// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Notification producer and delivery projection
//! (port of `src/notifications.ts`).
//!
//! City domain events create an in-app notification record in
//! `city-notifications`. External delivery is owned by the Tier-2 notifications
//! capability; an unconfigured deployment is reported as
//! `not_configured`/`unavailable`, never as delivered.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use super::{iso_from_millis, JsonMap};

pub const NOTIFICATIONS_DEPENDENCY: &str =
    "https://github.com/vku-open-source-2026/SynapseDX/issues/10";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationType {
    IncidentAssigned,
    IncidentResolved,
    IncidentReported,
    AlertRaised,
    MaintenanceDue,
    MaintenanceAssigned,
    MaintenanceCompleted,
    ReportReady,
    System,
}

impl NotificationType {
    pub fn as_str(self) -> &'static str {
        match self {
            NotificationType::IncidentAssigned => "incident_assigned",
            NotificationType::IncidentResolved => "incident_resolved",
            NotificationType::IncidentReported => "incident_reported",
            NotificationType::AlertRaised => "alert_raised",
            NotificationType::MaintenanceDue => "maintenance_due",
            NotificationType::MaintenanceAssigned => "maintenance_assigned",
            NotificationType::MaintenanceCompleted => "maintenance_completed",
            NotificationType::ReportReady => "report_ready",
            NotificationType::System => "system",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationChannel {
    Email,
    Sms,
    Push,
}

impl NotificationChannel {
    pub fn as_str(self) -> &'static str {
        match self {
            NotificationChannel::Email => "email",
            NotificationChannel::Sms => "sms",
            NotificationChannel::Push => "push",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Delivered,
    Queued,
    Sent,
    Failed,
    Unsupported,
    NotConfigured,
    Suppressed,
}

impl DeliveryState {
    pub fn as_str(self) -> &'static str {
        match self {
            DeliveryState::Delivered => "delivered",
            DeliveryState::Queued => "queued",
            DeliveryState::Sent => "sent",
            DeliveryState::Failed => "failed",
            DeliveryState::Unsupported => "unsupported",
            DeliveryState::NotConfigured => "not_configured",
            DeliveryState::Suppressed => "suppressed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NotificationSeverity {
    Info,
    Warning,
    Critical,
}

impl NotificationSeverity {
    pub fn as_str(self) -> &'static str {
        match self {
            NotificationSeverity::Info => "info",
            NotificationSeverity::Warning => "warning",
            NotificationSeverity::Critical => "critical",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeliveryReceipt {
    pub status: DeliveryState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub channel: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl DeliveryReceipt {
    pub fn new(status: DeliveryState) -> Self {
        Self {
            status,
            channel: None,
            notification_id: None,
            error: None,
            dependency: None,
            detail: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recipient {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub push_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationInput {
    #[serde(default)]
    pub user_id: String,
    #[serde(rename = "type")]
    pub notification_type: NotificationType,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub severity: Option<NotificationSeverity>,
    #[serde(default)]
    pub link: Option<String>,
    #[serde(default)]
    pub entity_type: Option<String>,
    #[serde(default)]
    pub entity_id: Option<String>,
    #[serde(default)]
    pub dedupe_key: Option<String>,
    #[serde(default)]
    pub metadata: Option<JsonMap>,
    #[serde(default)]
    pub recipient: Option<Recipient>,
}

#[derive(Debug, Clone, Default)]
pub struct DeliveryOverrides {
    pub email: Option<DeliveryReceipt>,
    pub sms: Option<DeliveryReceipt>,
    pub push: Option<DeliveryReceipt>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotificationError {
    UserIdRequired,
    TitleRequired,
}

impl NotificationError {
    pub fn code(self) -> &'static str {
        match self {
            NotificationError::UserIdRequired => "notification_user_id_required",
            NotificationError::TitleRequired => "notification_title_required",
        }
    }

    pub fn status(self) -> u16 {
        400
    }
}

impl std::fmt::Display for NotificationError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for NotificationError {}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationCapabilityStatus {
    pub status: String,
    pub in_app: String,
    pub external: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dependency: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    pub channels: Vec<NotificationChannel>,
    pub templates: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TemplateDefinition {
    pub id: String,
    pub name: String,
    pub subject: String,
    pub body: String,
    pub channel: NotificationChannel,
}

fn receipt_value(receipt: DeliveryReceipt) -> Value {
    serde_json::to_value(receipt).unwrap_or(Value::Null)
}

/// In-app is always delivered by the City projection; external channels start
/// unconfigured unless a per-call receipt is supplied.
pub fn delivery_statuses(overrides: Option<&DeliveryOverrides>) -> JsonMap {
    let overrides = overrides.cloned().unwrap_or_default();
    let mut delivery = JsonMap::new();
    delivery.insert(
        "in_app".to_string(),
        receipt_value(DeliveryReceipt::new(DeliveryState::Delivered)),
    );
    delivery.insert(
        "email".to_string(),
        receipt_value(
            overrides
                .email
                .unwrap_or_else(|| DeliveryReceipt::new(DeliveryState::NotConfigured)),
        ),
    );
    delivery.insert(
        "sms".to_string(),
        receipt_value(
            overrides
                .sms
                .unwrap_or_else(|| DeliveryReceipt::new(DeliveryState::NotConfigured)),
        ),
    );
    delivery.insert(
        "push".to_string(),
        receipt_value(
            overrides
                .push
                .unwrap_or_else(|| DeliveryReceipt::new(DeliveryState::NotConfigured)),
        ),
    );
    delivery
}

pub fn external_channels(recipient: Option<&Recipient>) -> Vec<NotificationChannel> {
    let mut channels = Vec::new();
    let Some(recipient) = recipient else {
        return channels;
    };
    if recipient
        .email
        .as_deref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        channels.push(NotificationChannel::Email);
    }
    if recipient
        .phone
        .as_deref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        channels.push(NotificationChannel::Sms);
    }
    if recipient
        .push_token
        .as_deref()
        .map(|value| !value.is_empty())
        .unwrap_or(false)
    {
        channels.push(NotificationChannel::Push);
    }
    channels
}

/// Builds the in-app notification projection. `delivery` defaults to the
/// standard in-app/external status map.
pub fn build_notification(
    input: &NotificationInput,
    now: Option<DateTime<Utc>>,
    delivery: Option<JsonMap>,
) -> Result<JsonMap, NotificationError> {
    let user_id = input.user_id.trim();
    if user_id.is_empty() {
        return Err(NotificationError::UserIdRequired);
    }
    if input.title.trim().is_empty() {
        return Err(NotificationError::TitleRequired);
    }
    let now = now.unwrap_or_else(Utc::now);
    let timestamp = iso_from_millis(now.timestamp_millis());

    let mut record = JsonMap::new();
    record.insert("id".to_string(), Value::String(Uuid::new_v4().to_string()));
    record.insert("user_id".to_string(), Value::String(user_id.to_string()));
    record.insert(
        "type".to_string(),
        Value::String(input.notification_type.as_str().to_string()),
    );
    record.insert("title".to_string(), Value::String(input.title.clone()));
    record.insert("message".to_string(), Value::String(input.message.clone()));
    record.insert(
        "severity".to_string(),
        Value::String(
            input
                .severity
                .unwrap_or(NotificationSeverity::Info)
                .as_str()
                .to_string(),
        ),
    );
    record.insert("read".to_string(), Value::Bool(false));
    record.insert("channel".to_string(), Value::String("in_app".to_string()));
    record.insert(
        "delivery".to_string(),
        Value::Object(delivery.unwrap_or_else(|| delivery_statuses(None))),
    );

    insert_truthy_string(&mut record, "link", input.link.as_deref());
    insert_truthy_string(&mut record, "entity_type", input.entity_type.as_deref());
    insert_truthy_string(&mut record, "entity_id", input.entity_id.as_deref());
    insert_truthy_string(&mut record, "dedupe_key", input.dedupe_key.as_deref());
    if let Some(metadata) = &input.metadata {
        record.insert("metadata".to_string(), Value::Object(metadata.clone()));
    }
    record.insert("created_at".to_string(), Value::String(timestamp.clone()));
    record.insert("updated_at".to_string(), Value::String(timestamp));
    record.insert(
        "source".to_string(),
        Value::String("synapsecity".to_string()),
    );
    Ok(record)
}

fn insert_truthy_string(record: &mut JsonMap, key: &str, value: Option<&str>) {
    if let Some(value) = value.filter(|value| !value.is_empty()) {
        record.insert(key.to_string(), Value::String(value.to_string()));
    }
}

pub fn notification_capability_status(external_available: bool) -> NotificationCapabilityStatus {
    let channels = vec![
        NotificationChannel::Email,
        NotificationChannel::Sms,
        NotificationChannel::Push,
    ];
    if external_available {
        NotificationCapabilityStatus {
            status: "available".to_string(),
            in_app: "available".to_string(),
            external: "available".to_string(),
            dependency: None,
            detail: Some(
                "External delivery is sent through the Tier-2 notifications capability; per-channel receipts are recorded on each notification."
                    .to_string(),
            ),
            channels,
            templates: "synapsedx".to_string(),
        }
    } else {
        NotificationCapabilityStatus {
            status: "partial".to_string(),
            in_app: "available".to_string(),
            external: "unavailable".to_string(),
            dependency: Some(NOTIFICATIONS_DEPENDENCY.to_string()),
            detail: Some(
                "Tier-2 notification delivery is not configured on this deployment; in-app records are still produced and persisted."
                    .to_string(),
            ),
            channels,
            templates: "synapsedx".to_string(),
        }
    }
}

/// Deterministic template id so a retried producer reuses the same template.
pub fn template_id(notification_type: NotificationType) -> String {
    format!("city-{}", notification_type.as_str().replace('_', "-"))
}

pub fn template_definition(notification_type: NotificationType) -> TemplateDefinition {
    let body = if notification_type == NotificationType::System {
        "{{title}}\n\n{{message}}".to_string()
    } else {
        "{{title}}\n\n{{message}}\n\nOpen: {{link}}".to_string()
    };
    TemplateDefinition {
        id: template_id(notification_type),
        name: format!(
            "SynapseCity {}",
            notification_type.as_str().replace('_', " ")
        ),
        subject: "[SynapseCity] {{title}}".to_string(),
        body,
        channel: NotificationChannel::Email,
    }
}

pub fn template_variables(notification: &JsonMap) -> JsonMap {
    let mut variables = JsonMap::new();
    for (key, fallback) in [
        ("title", Value::String(String::new())),
        ("message", Value::String(String::new())),
        ("severity", Value::String(String::new())),
    ] {
        let value = notification
            .get(key)
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(fallback);
        variables.insert(key.to_string(), value);
    }
    for key in ["link", "entity_type", "entity_id"] {
        let value = super::string_value(notification.get(key));
        variables.insert(key.to_string(), Value::String(value));
    }
    variables
}

/// Stable key so a retried domain transition does not duplicate a notification.
pub fn dedupe_key(notification_type: NotificationType, entity_id: &str, event: &str) -> String {
    format!("{}:{entity_id}:{event}", notification_type.as_str())
}

/// Recipient key used by the Tier-2 preference store (`user:<id>`).
pub fn preference_recipient(user_id: &str) -> String {
    format!("user:{}", user_id.trim())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn input() -> NotificationInput {
        NotificationInput {
            user_id: " user-1 ".to_string(),
            notification_type: NotificationType::IncidentAssigned,
            title: "Assigned".to_string(),
            message: "You have a task".to_string(),
            severity: None,
            link: Some("/admin/incidents/1".to_string()),
            entity_type: Some("incident".to_string()),
            entity_id: Some("inc-1".to_string()),
            dedupe_key: Some("incident_assigned:inc-1:assigned".to_string()),
            metadata: None,
            recipient: None,
        }
    }

    #[test]
    fn builds_the_in_app_projection_with_delivery_statuses() {
        let now = DateTime::<Utc>::from_timestamp_millis(1_800_000_000_000).unwrap();
        let record = build_notification(&input(), Some(now), None).unwrap();
        assert_eq!(record.get("user_id").unwrap(), "user-1");
        assert_eq!(record.get("type").unwrap(), "incident_assigned");
        assert_eq!(record.get("severity").unwrap(), "info");
        assert_eq!(record.get("read").unwrap(), false);
        assert_eq!(record.get("channel").unwrap(), "in_app");
        assert_eq!(record.get("source").unwrap(), "synapsecity");
        assert_eq!(record.get("link").unwrap(), "/admin/incidents/1");
        assert_eq!(
            record.get("created_at").unwrap(),
            "2027-01-15T08:00:00.000Z"
        );
        assert!(Uuid::parse_str(record.get("id").unwrap().as_str().unwrap()).is_ok());
        let delivery = record.get("delivery").unwrap().as_object().unwrap();
        assert_eq!(
            delivery.get("in_app").unwrap().get("status").unwrap(),
            "delivered"
        );
        assert_eq!(
            delivery.get("email").unwrap().get("status").unwrap(),
            "not_configured"
        );
        assert_eq!(
            delivery.get("sms").unwrap().get("status").unwrap(),
            "not_configured"
        );
        assert_eq!(
            delivery.get("push").unwrap().get("status").unwrap(),
            "not_configured"
        );
    }

    #[test]
    fn validation_rejects_missing_user_or_title() {
        let mut invalid = input();
        invalid.user_id = "   ".to_string();
        assert_eq!(
            build_notification(&invalid, None, None).unwrap_err(),
            NotificationError::UserIdRequired
        );
        let mut invalid = input();
        invalid.title = "  ".to_string();
        assert_eq!(
            build_notification(&invalid, None, None).unwrap_err(),
            NotificationError::TitleRequired
        );
        assert_eq!(NotificationError::TitleRequired.status(), 400);
        assert_eq!(
            NotificationError::TitleRequired.code(),
            "notification_title_required"
        );
    }

    #[test]
    fn optional_fields_are_omitted_when_empty_and_metadata_is_kept() {
        let mut notification = input();
        notification.link = Some(String::new());
        notification.entity_type = None;
        notification.entity_id = Some(String::new());
        notification.dedupe_key = None;
        notification.metadata = Some(json!({ "k": "v" }).as_object().unwrap().clone());
        let record = build_notification(&notification, None, None).unwrap();
        assert!(!record.contains_key("link"));
        assert!(!record.contains_key("entity_type"));
        assert!(!record.contains_key("entity_id"));
        assert!(!record.contains_key("dedupe_key"));
        assert_eq!(record.get("metadata").unwrap().get("k").unwrap(), "v");
    }

    #[test]
    fn delivery_overrides_and_recipient_channels_are_honest() {
        let delivery = delivery_statuses(Some(&DeliveryOverrides {
            email: Some(DeliveryReceipt {
                status: DeliveryState::Queued,
                channel: Some("email".to_string()),
                notification_id: Some("notif-1".to_string()),
                error: None,
                dependency: None,
                detail: None,
            }),
            ..Default::default()
        }));
        assert_eq!(
            delivery.get("email").unwrap().get("status").unwrap(),
            "queued"
        );
        assert_eq!(
            delivery
                .get("email")
                .unwrap()
                .get("notification_id")
                .unwrap(),
            "notif-1"
        );
        assert_eq!(
            delivery.get("sms").unwrap().get("status").unwrap(),
            "not_configured"
        );

        let recipient = Recipient {
            email: Some("tech@example.com".to_string()),
            phone: Some("0900".to_string()),
            push_token: Some("token".to_string()),
        };
        assert_eq!(
            external_channels(Some(&recipient)),
            vec![
                NotificationChannel::Email,
                NotificationChannel::Sms,
                NotificationChannel::Push
            ]
        );
        assert!(external_channels(None).is_empty());
    }

    #[test]
    fn capability_status_reports_partial_without_a_provider() {
        let status = notification_capability_status(false);
        assert_eq!(status.status, "partial");
        assert_eq!(status.in_app, "available");
        assert_eq!(status.external, "unavailable");
        assert_eq!(status.dependency.as_deref(), Some(NOTIFICATIONS_DEPENDENCY));
        let available = notification_capability_status(true);
        assert_eq!(available.status, "available");
        assert_eq!(available.external, "available");
        assert!(available.dependency.is_none());
    }

    #[test]
    fn templates_variables_and_keys_are_stable() {
        assert_eq!(
            template_id(NotificationType::IncidentAssigned),
            "city-incident-assigned"
        );
        let definition = template_definition(NotificationType::IncidentAssigned);
        assert_eq!(definition.name, "SynapseCity incident assigned");
        assert_eq!(definition.subject, "[SynapseCity] {{title}}");
        assert!(definition.body.contains("Open: {{link}}"));
        assert_eq!(definition.channel, NotificationChannel::Email);
        assert!(!template_definition(NotificationType::System)
            .body
            .contains("Open:"));

        let record = build_notification(&input(), None, None).unwrap();
        let variables = template_variables(&record);
        assert_eq!(variables.get("title").unwrap(), "Assigned");
        assert_eq!(variables.get("severity").unwrap(), "info");
        assert_eq!(variables.get("link").unwrap(), "/admin/incidents/1");
        assert_eq!(variables.get("entity_id").unwrap(), "inc-1");

        assert_eq!(
            dedupe_key(NotificationType::IncidentAssigned, "inc-1", "assigned"),
            "incident_assigned:inc-1:assigned"
        );
        assert_eq!(preference_recipient(" user-1 "), "user:user-1");
    }
}
