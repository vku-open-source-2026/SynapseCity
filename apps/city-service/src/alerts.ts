// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Infrastructure alert -> maintenance automation rules.
 *
 * A critical/high alert that has been acknowledged and is linked to an asset
 * produces exactly one work order. Callers must persist `source_alert_id` and
 * check for an existing order before creating a new one, which makes retries
 * idempotent.
 */

export const MAINTENANCE_ALERT_SEVERITIES = ['critical', 'high'] as const;

const SLA_HOURS: Record<string, number> = {
  critical: 4,
  high: 24,
  medium: 72,
  low: 168,
};

const PRIORITY_BY_SEVERITY: Record<string, string> = {
  critical: 'urgent',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

export interface AlertForAutomation {
  id: string;
  severity?: unknown;
  status?: unknown;
  asset_id?: unknown;
  assetId?: unknown;
  title?: unknown;
  description?: unknown;
  acknowledged_at?: unknown;
  [key: string]: unknown;
}

export function isTriggerSeverity(severity: unknown): boolean {
  return (MAINTENANCE_ALERT_SEVERITIES as readonly string[]).includes(String(severity || '').toLowerCase());
}

export function shouldCreateMaintenance(alert: AlertForAutomation): boolean {
  const status = String(alert.status || '').toLowerCase();
  const assetId = String(alert.asset_id || alert.assetId || '').trim();
  return isTriggerSeverity(alert.severity) && assetId.length > 0 && ['acknowledged', 'active', 'open'].includes(status);
}

export function slaDueAt(severity: unknown, now = Date.now()): string {
  const hours = SLA_HOURS[String(severity || '').toLowerCase()] ?? SLA_HOURS.medium;
  return new Date(now + hours * 3_600_000).toISOString();
}

export function maintenanceFromAlert(alert: AlertForAutomation, now = Date.now()): Record<string, unknown> {
  const severity = String(alert.severity || 'medium').toLowerCase();
  const assetId = String(alert.asset_id || alert.assetId || '');
  return {
    id: `alert-${alert.id}`,
    asset_id: assetId,
    source_alert_id: String(alert.id),
    title: `Alert ${String(alert.title || alert.id)}: corrective maintenance`.slice(0, 200),
    description: String(alert.description || ''),
    type: 'corrective',
    status: 'scheduled',
    priority: PRIORITY_BY_SEVERITY[severity] || 'medium',
    severity,
    sla_due_at: slaDueAt(severity, now),
    scheduled_date: new Date(now).toISOString(),
    created_at: new Date(now).toISOString(),
    source: 'synapsecity-alert-automation',
  };
}
