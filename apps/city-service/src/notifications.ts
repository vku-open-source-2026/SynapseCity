// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { randomUUID } from 'node:crypto';

/**
 * Notification producer and delivery projection.
 *
 * City domain events (incident assignment/resolution, alert raising, work-order
 * completion) create a notification record in `city-notifications`. That record
 * is the *in-app projection* read by the console notification centre.
 *
 * External delivery (email/SMS/push) is owned by the Tier-2 notifications
 * capability, which delegates to the Tier-1 notification service. City sends
 * through `notifications.send` with a template and an idempotency key; the
 * per-channel result is written back to the projection. A deployment with no
 * external channel or provider is reported as `not_configured`/`unavailable`,
 * never as delivered.
 */

export const NOTIFICATIONS_DEPENDENCY = 'https://github.com/vku-open-source-2026/SynapseDX/issues/10';

export type NotificationType =
  | 'incident_assigned'
  | 'incident_resolved'
  | 'incident_reported'
  | 'alert_raised'
  | 'maintenance_due'
  | 'maintenance_assigned'
  | 'maintenance_completed'
  | 'report_ready'
  | 'system';

export type NotificationChannel = 'email' | 'sms' | 'push';

export type DeliveryState = 'delivered' | 'queued' | 'sent' | 'failed' | 'unsupported' | 'not_configured' | 'suppressed';

export interface DeliveryReceipt {
  status: DeliveryState;
  channel?: string;
  notification_id?: string;
  error?: string;
  dependency?: string;
  detail?: string;
}

export interface NotificationInput {
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  link?: string;
  entity_type?: string;
  entity_id?: string;
  dedupe_key?: string;
  metadata?: Record<string, unknown>;
  /** Recipient addresses resolved from the City operator profile. */
  recipient?: { email?: string; phone?: string; push_token?: string };
}

export interface NotificationRecord extends Record<string, unknown> {
  id: string;
  user_id: string;
  type: NotificationType;
  title: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
  read: false;
  channel: 'in_app';
  delivery: Record<string, DeliveryReceipt>;
  link?: string;
  entity_type?: string;
  entity_id?: string;
  dedupe_key?: string;
  updated_at?: string;
  created_at: string;
}

export function buildNotification(
  input: NotificationInput,
  now = new Date(),
  delivery: Record<string, DeliveryReceipt> = deliveryStatuses(),
): NotificationRecord {
  const userId = String(input.user_id || '').trim();
  if (!userId) throw Object.assign(new Error('notification_user_id_required'), { status: 400 });
  if (!String(input.title || '').trim()) throw Object.assign(new Error('notification_title_required'), { status: 400 });
  return {
    id: randomUUID(),
    user_id: userId,
    type: input.type,
    title: String(input.title),
    message: String(input.message || ''),
    severity: input.severity || 'info',
    read: false,
    channel: 'in_app',
    delivery,
    ...(input.link ? { link: String(input.link) } : {}),
    ...(input.entity_type ? { entity_type: String(input.entity_type) } : {}),
    ...(input.entity_id ? { entity_id: String(input.entity_id) } : {}),
    ...(input.dedupe_key ? { dedupe_key: String(input.dedupe_key) } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    source: 'synapsecity',
  };
}

/** In-app is always delivered by the City projection; external channels start unconfigured. */
export function deliveryStatuses(overrides: Partial<Record<NotificationChannel, DeliveryReceipt>> = {}): Record<string, DeliveryReceipt> {
  return {
    in_app: { status: 'delivered' },
    email: overrides.email || { status: 'not_configured' },
    sms: overrides.sms || { status: 'not_configured' },
    push: overrides.push || { status: 'not_configured' },
  };
}

export function externalChannels(recipient: NotificationInput['recipient']): NotificationChannel[] {
  const channels: NotificationChannel[] = [];
  if (recipient?.email) channels.push('email');
  if (recipient?.phone) channels.push('sms');
  if (recipient?.push_token) channels.push('push');
  return channels;
}

export interface NotificationCapabilityStatus {
  status: 'available' | 'partial';
  in_app: 'available';
  external: 'available' | 'unavailable';
  dependency?: string;
  detail?: string;
  channels: NotificationChannel[];
  templates: string;
}

/**
 * `external` is `available` when the deployment is expected to have a delivery
 * provider configured. Tier-2 cannot be probed cheaply per request, so the
 * status is configuration-driven and the real per-send result is authoritative.
 */
export function notificationCapabilityStatus(externalAvailable = false): NotificationCapabilityStatus {
  return externalAvailable
    ? {
        status: 'available',
        in_app: 'available',
        external: 'available',
        channels: ['email', 'sms', 'push'],
        templates: 'synapsedx',
        detail: 'External delivery is sent through the Tier-2 notifications capability; per-channel receipts are recorded on each notification.',
      }
    : {
        status: 'partial',
        in_app: 'available',
        external: 'unavailable',
        dependency: NOTIFICATIONS_DEPENDENCY,
        channels: ['email', 'sms', 'push'],
        templates: 'synapsedx',
        detail: 'Tier-2 notification delivery is not configured on this deployment; in-app records are still produced and persisted.',
      };
}

/** Deterministic template id so a retried producer reuses the same template. */
export function templateId(type: NotificationType): string {
  return `city-${type.replace(/_/g, '-')}`;
}

export function templateDefinition(type: NotificationType): { id: string; name: string; subject: string; body: string; channel: NotificationChannel } {
  return {
    id: templateId(type),
    name: `SynapseCity ${type.replace(/_/g, ' ')}`,
    subject: `[SynapseCity] {{title}}`,
    body: '{{title}}\n\n{{message}}' + (type === 'system' ? '' : '\n\nOpen: {{link}}'),
    channel: 'email',
  };
}

export function templateVariables(notification: Pick<NotificationRecord, 'title' | 'message' | 'severity' | 'link' | 'entity_type' | 'entity_id'>): Record<string, unknown> {
  return {
    title: notification.title,
    message: notification.message,
    severity: notification.severity,
    link: notification.link || '',
    entity_type: notification.entity_type || '',
    entity_id: notification.entity_id || '',
  };
}

/** Stable key so a retried domain transition does not duplicate a notification. */
export function dedupeKey(type: NotificationType, entityId: string, event: string): string {
  return `${type}:${entityId}:${event}`;
}

/** Recipient key used by the Tier-2 preference store (matches its `user:<id>` mapping). */
export function preferenceRecipient(userId: string): string {
  return `user:${String(userId || '').trim()}`;
}
