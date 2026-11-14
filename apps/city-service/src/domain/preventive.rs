// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! Preventive-maintenance derivation (port of `src/preventive.ts`).
//!
//! Tasks are derived from the asset's `preventive_maintenance_plan` and from
//! work orders that were created as preventive work. Nothing is invented: no
//! plan and no preventive work order means no tasks.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{
    first_truthy, iso_from_millis, js_number_string, js_string, now_millis, number_from_value,
    parse_timestamp_millis, string_value, JsonMap,
};

const DAY_MS: f64 = 86_400_000.0;
const CLOSED_STATUSES: [&str; 3] = ["completed", "cancelled", "closed"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreventiveTaskStatus {
    Upcoming,
    DueSoon,
    Overdue,
    Scheduled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreventiveTaskSource {
    Plan,
    WorkOrder,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PreventiveTask {
    pub id: String,
    pub asset_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_order_id: Option<String>,
    pub title: String,
    pub due_date: String,
    pub scheduled_date: String,
    pub status: PreventiveTaskStatus,
    pub days_until_due: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cycle_days: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub responsible_team: Option<String>,
    pub source: PreventiveTaskSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PreventiveView {
    Tasks,
    Upcoming,
    Overdue,
}

fn day_difference(from: i64, to: i64) -> i64 {
    (((to - from) as f64) / DAY_MS).ceil() as i64
}

fn status_for(days_until_due: i64, warning_days: f64) -> PreventiveTaskStatus {
    if days_until_due < 0 {
        PreventiveTaskStatus::Overdue
    } else if (days_until_due as f64) <= warning_days {
        PreventiveTaskStatus::DueSoon
    } else {
        PreventiveTaskStatus::Upcoming
    }
}

fn ts_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_string(),
        Some(value) => js_string(value),
    }
}

fn plan_string(plan: Option<&JsonMap>, key: &str) -> Option<String> {
    plan.and_then(|plan| first_truthy(plan, &[key]))
        .map(js_string)
}

fn plan_cycle_days(plan: Option<&JsonMap>) -> Option<f64> {
    let plan = plan?;
    if !plan.contains_key("cycle_days") {
        return None;
    }
    plan.get("cycle_days")
        .and_then(number_from_value)
        .filter(|value| value.is_finite())
}

/// Derives preventive tasks from a plan and its related work orders.
pub fn derive_preventive_tasks(
    plan: Option<&JsonMap>,
    work_orders: &[JsonMap],
    now: Option<i64>,
) -> Vec<PreventiveTask> {
    let now = now.unwrap_or_else(now_millis);
    let mut tasks: Vec<PreventiveTask> = Vec::new();

    let warning_days = plan
        .and_then(|plan| plan.get("warning_days"))
        .and_then(number_from_value)
        .filter(|value| *value != 0.0)
        .map(|value| value.max(0.0))
        .unwrap_or(7.0);

    let preventive_orders: Vec<&JsonMap> = work_orders
        .iter()
        .filter(|order| {
            let order_type = first_truthy(order, &["type", "maintenance_type"])
                .map(js_string)
                .unwrap_or_default()
                .to_lowercase();
            let preventive_flag = matches!(order.get("preventive"), Some(Value::Bool(true)));
            let has_plan = order.get("plan_id").map(super::js_truthy).unwrap_or(false);
            let is_preventive = order_type == "preventive" || preventive_flag || has_plan;
            let status = string_value(order.get("status")).to_lowercase();
            is_preventive && !CLOSED_STATUSES.contains(&status.as_str())
        })
        .collect();

    let plan_id = plan_string(plan, "id");
    let plan_asset_id = plan
        .and_then(|plan| first_truthy(plan, &["asset_id"]))
        .map(js_string);
    let plan_cycle_days = plan_cycle_days(plan);
    let plan_responsible = plan_string(plan, "responsible_team");

    for order in &preventive_orders {
        let due_raw = first_truthy(order, &["scheduled_date", "due_date", "scheduledDate"])
            .map(js_string)
            .unwrap_or_default();
        let Some(due) = parse_timestamp_millis(&due_raw) else {
            continue;
        };
        let days_until_due = day_difference(now, due);
        let order_id = ts_string(order.get("id"));
        let asset_id = first_truthy(order, &["asset_id", "assetId"])
            .map(js_string)
            .or_else(|| plan_asset_id.clone())
            .unwrap_or_default();
        let title = first_truthy(order, &["title"])
            .map(js_string)
            .unwrap_or_else(|| "Preventive maintenance".to_string());
        let responsible_team = first_truthy(order, &["responsible_team"])
            .map(js_string)
            .or_else(|| plan_responsible.clone());
        let due = iso_from_millis(due);

        tasks.push(PreventiveTask {
            id: format!("wo-{order_id}"),
            asset_id,
            plan_id: plan_id.clone(),
            work_order_id: Some(order_id),
            title,
            due_date: due.clone(),
            scheduled_date: due,
            status: status_for(days_until_due, warning_days),
            days_until_due,
            cycle_days: plan_cycle_days,
            responsible_team,
            source: PreventiveTaskSource::WorkOrder,
        });
    }

    let plan_next_due = plan
        .and_then(|plan| first_truthy(plan, &["next_maintenance_date"]))
        .map(js_string)
        .and_then(|raw| parse_timestamp_millis(&raw));
    let plan_id_value = plan_id.clone().unwrap_or_default();
    let plan_already_scheduled = if plan_id_value.is_empty() {
        false
    } else {
        preventive_orders
            .iter()
            .any(|order| string_value(order.get("plan_id")) == plan_id_value)
    };

    if let Some(plan_next_due) = plan_next_due {
        if !plan_already_scheduled {
            let days_until_due = day_difference(now, plan_next_due);
            let title = plan_string(plan, "cycle_description").unwrap_or_else(|| {
                let cycle = plan
                    .and_then(|plan| plan.get("cycle_days"))
                    .and_then(number_from_value)
                    .filter(|value| value.is_finite() && *value != 0.0)
                    .unwrap_or(180.0);
                format!(
                    "Preventive maintenance every {} days",
                    js_number_string(cycle)
                )
            });
            let due = iso_from_millis(plan_next_due);
            let id_suffix = if !plan_id_value.is_empty() {
                plan_id_value.clone()
            } else if let Some(asset_id) = plan_asset_id.clone() {
                if asset_id.is_empty() {
                    "asset".to_string()
                } else {
                    asset_id
                }
            } else {
                "asset".to_string()
            };

            tasks.push(PreventiveTask {
                id: format!("plan-{id_suffix}"),
                asset_id: string_value(plan.and_then(|plan| plan.get("asset_id"))),
                plan_id: plan_id.clone(),
                work_order_id: None,
                title,
                due_date: due.clone(),
                scheduled_date: due,
                status: status_for(days_until_due, warning_days),
                days_until_due,
                cycle_days: plan_cycle_days,
                responsible_team: plan_responsible.clone(),
                source: PreventiveTaskSource::Plan,
            });
        }
    }

    // A work order always wins over the plan-derived placeholder for the same plan.
    let mut deduped: Vec<PreventiveTask> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for task in tasks {
        let key = match task.work_order_id.as_ref().filter(|id| !id.is_empty()) {
            Some(order_id) => format!("wo-{order_id}"),
            None => format!(
                "plan-{}",
                task.plan_id
                    .as_ref()
                    .filter(|id| !id.is_empty())
                    .cloned()
                    .unwrap_or_else(|| task.asset_id.clone())
            ),
        };
        if !seen.contains(&key) {
            seen.push(key);
            deduped.push(task);
        }
    }

    deduped.sort_by(|left, right| {
        let left_due = parse_timestamp_millis(&left.due_date).unwrap_or(i64::MAX);
        let right_due = parse_timestamp_millis(&right.due_date).unwrap_or(i64::MAX);
        left_due.cmp(&right_due)
    });
    deduped
}

/// Filters tasks for the `/tasks`, `/upcoming` and `/overdue` views.
pub fn filter_preventive_tasks(
    tasks: &[PreventiveTask],
    view: PreventiveView,
) -> Vec<PreventiveTask> {
    match view {
        PreventiveView::Overdue => tasks
            .iter()
            .filter(|task| task.status == PreventiveTaskStatus::Overdue)
            .cloned()
            .collect(),
        PreventiveView::Upcoming => tasks
            .iter()
            .filter(|task| task.status != PreventiveTaskStatus::Overdue)
            .cloned()
            .collect(),
        PreventiveView::Tasks => tasks.to_vec(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn map(value: Value) -> JsonMap {
        value.as_object().unwrap().clone()
    }

    fn now() -> i64 {
        parse_timestamp_millis("2026-11-04T00:00:00Z").unwrap()
    }

    fn plan(asset_id: &str, plan_id: &str, next: &str, cycle_days: f64) -> JsonMap {
        map(json!({
            "id": plan_id,
            "asset_id": asset_id,
            "cycle_days": cycle_days,
            "warning_days": 7,
            "next_maintenance_date": next,
            "responsible_team": "Team A"
        }))
    }

    #[test]
    fn derives_tasks_from_work_orders_and_skips_completed_or_corrective() {
        let plan = plan("asset-1", "plan-1", "2026-11-02T00:00:00Z", 180.0);
        let orders = vec![
            map(json!({
                "id": "wo-overdue", "asset_id": "asset-1", "title": "Overdue preventive",
                "type": "preventive", "status": "scheduled",
                "scheduled_date": "2026-11-01T00:00:00Z", "plan_id": "plan-1"
            })),
            map(json!({
                "id": "wo-due-soon", "asset_id": "asset-1", "title": "Due soon preventive",
                "type": "preventive", "status": "scheduled",
                "scheduled_date": "2026-11-06T00:00:00Z"
            })),
            map(json!({
                "id": "wo-completed", "asset_id": "asset-1", "title": "Completed",
                "type": "preventive", "status": "completed",
                "scheduled_date": "2026-10-01T00:00:00Z"
            })),
            map(json!({
                "id": "wo-corrective", "asset_id": "asset-1", "title": "Corrective",
                "type": "corrective", "status": "scheduled",
                "scheduled_date": "2026-11-03T00:00:00Z"
            })),
        ];
        let tasks = derive_preventive_tasks(Some(&plan), &orders, Some(now()));
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0].id, "wo-wo-overdue");
        assert_eq!(tasks[0].status, PreventiveTaskStatus::Overdue);
        assert_eq!(tasks[0].days_until_due, -3);
        assert_eq!(tasks[1].id, "wo-wo-due-soon");
        assert_eq!(tasks[1].status, PreventiveTaskStatus::DueSoon);
        assert_eq!(tasks[1].days_until_due, 2);
        assert!(tasks
            .iter()
            .all(|task| task.source == PreventiveTaskSource::WorkOrder));
        assert!(tasks
            .iter()
            .all(|task| task.plan_id.as_deref() == Some("plan-1")));

        let overdue = filter_preventive_tasks(&tasks, PreventiveView::Overdue);
        assert_eq!(overdue.len(), 1);
        assert_eq!(overdue[0].work_order_id.as_deref(), Some("wo-overdue"));
        let upcoming = filter_preventive_tasks(&tasks, PreventiveView::Upcoming);
        assert_eq!(upcoming.len(), 1);
        assert_eq!(upcoming[0].work_order_id.as_deref(), Some("wo-due-soon"));
    }

    #[test]
    fn plan_creates_a_task_when_no_work_order_exists() {
        let plan = plan("asset-2", "plan-2", "2026-12-04T00:00:00Z", 90.0);
        let tasks = derive_preventive_tasks(Some(&plan), &[], Some(now()));
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].source, PreventiveTaskSource::Plan);
        assert_eq!(tasks[0].id, "plan-plan-2");
        assert_eq!(tasks[0].status, PreventiveTaskStatus::Upcoming);
        assert_eq!(tasks[0].days_until_due, 30);
        assert_eq!(tasks[0].due_date, "2026-12-04T00:00:00.000Z");
        assert_eq!(tasks[0].cycle_days, Some(90.0));
        assert_eq!(tasks[0].responsible_team.as_deref(), Some("Team A"));
    }

    #[test]
    fn plan_is_suppressed_when_its_work_order_exists() {
        let plan = plan("asset-1", "plan-1", "2026-11-02T00:00:00Z", 180.0);
        let orders = vec![map(json!({
            "id": "wo-1", "asset_id": "asset-1", "title": "Preventive",
            "type": "preventive", "status": "scheduled",
            "scheduled_date": "2026-11-10T00:00:00Z", "plan_id": "plan-1"
        }))];
        let tasks = derive_preventive_tasks(Some(&plan), &orders, Some(now()));
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].source, PreventiveTaskSource::WorkOrder);
    }

    #[test]
    fn no_plan_and_no_orders_means_no_tasks_and_duplicates_are_removed() {
        assert!(derive_preventive_tasks(None, &[], Some(now())).is_empty());

        let orders = vec![
            map(json!({
                "id": "wo-1", "title": "A", "type": "preventive", "status": "open",
                "scheduled_date": "2026-11-05T00:00:00Z"
            })),
            map(json!({
                "id": "wo-1", "title": "A", "type": "preventive", "status": "open",
                "scheduled_date": "2026-11-05T00:00:00Z"
            })),
        ];
        let tasks = derive_preventive_tasks(None, &orders, Some(now()));
        assert_eq!(tasks.len(), 1);
        assert_eq!(tasks[0].asset_id, "");
        assert_eq!(tasks[0].title, "A");
    }
}
