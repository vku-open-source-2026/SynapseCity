// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Incident public/private split.
 *
 * `city-incidents` is the public projection, so the record written to Tier-2
 * may only contain fields that are safe for the anonymous SynapseLDS export.
 * Reporter identity, contact details, internal notes and internal comments are
 * stored in the private `city-incident-internal` sidecar instead of being
 * stripped at read time.
 */

export const INTERNAL_INCIDENT_FIELDS = [
  'reported_by',
  'contact_info',
  'reporter_name',
  'reporter_phone',
  'reporter_email',
  'reporter_id_card',
  'internal_notes',
  'internal_attachments',
  'assigned_to',
  'assigned_at',
  'resolution_notes',
  'merged_reporter_ids',
  'maintenance_record_id',
  'cost_status',
  'cost_approved_at',
] as const;

const PUBLIC_FIELDS = [
  'id',
  'incidentId',
  'incident_number',
  'incident_code',
  'title',
  'description',
  'category',
  'severity',
  'status',
  'asset_id',
  'location',
  'occurredAt',
  'reported_at',
  'created_at',
  'updated_at',
  'upvotes',
  'photos',
  'public_visible',
  'reporter_type',
  'resolution_type',
  'resolved_at',
  'closed_at',
  'acknowledged_at',
  'merged_into',
  'source',
  'sourceVersion',
] as const;

export type IncidentRecord = Record<string, unknown>;

function publicComment(comment: unknown): Record<string, unknown> | null {
  if (!comment || typeof comment !== 'object' || Array.isArray(comment)) return null;
  const entry = comment as Record<string, unknown>;
  if (entry.is_internal === true) return null;
  const clean: Record<string, unknown> = {
    id: entry.id,
    comment: entry.comment,
    posted_at: entry.posted_at || entry.created_at,
    created_at: entry.created_at || entry.posted_at,
    is_internal: false,
  };
  if (entry.user_name && entry.public_author === true) clean.user_name = entry.user_name;
  return clean;
}

/** Redact a full operational incident into the public projection shape. */
export function toPublishedIncident(record: IncidentRecord): IncidentRecord {
  const published: IncidentRecord = {};
  for (const field of PUBLIC_FIELDS) {
    if (record[field] !== undefined) published[field] = record[field];
  }
  for (const field of INTERNAL_INCIDENT_FIELDS) delete published[field];
  const comments = Array.isArray(record.comments) ? record.comments : [];
  published.comments = comments.map(publicComment).filter((entry): entry is Record<string, unknown> => entry !== null);
  published.reporter_type = String(record.reporter_type || 'citizen');
  if (record.public_visible === undefined) published.public_visible = true;
  return published;
}

/** Extract the fields that may only live in the private sidecar dataset. */
export function toInternalIncident(record: IncidentRecord): IncidentRecord | null {
  const internal: IncidentRecord = {};
  for (const field of INTERNAL_INCIDENT_FIELDS) {
    if (record[field] !== undefined) internal[field] = record[field];
  }
  const internalComments = (Array.isArray(record.comments) ? record.comments : [])
    .filter((comment) => comment && typeof comment === 'object' && (comment as Record<string, unknown>).is_internal === true);
  if (internalComments.length > 0) internal.internal_comments = internalComments;
  if (Object.keys(internal).length === 0) return null;
  internal.updated_at = record.updated_at || new Date().toISOString();
  return internal;
}

/** Merge the private sidecar back into an operator-facing incident view. */
export function mergeIncidentInternal(publicIncident: IncidentRecord, internal: IncidentRecord | null): IncidentRecord {
  if (!internal) return publicIncident;
  const merged: IncidentRecord = { ...publicIncident };
  for (const field of INTERNAL_INCIDENT_FIELDS) {
    if (internal[field] !== undefined) merged[field] = internal[field];
  }
  const comments = Array.isArray(publicIncident.comments) ? [...publicIncident.comments] : [];
  if (Array.isArray(internal.internal_comments)) comments.push(...(internal.internal_comments as unknown[]));
  merged.comments = comments.sort((a, b) => Date.parse(String((a as Record<string, unknown>).created_at || '')) - Date.parse(String((b as Record<string, unknown>).created_at || '')));
  return merged;
}

/** Final read-time redaction for the anonymous public API. */
export function toPublicIncidentView(record: IncidentRecord): IncidentRecord {
  const view = toPublishedIncident(record);
  delete view.reported_by;
  delete view.assigned_to;
  delete view.resolution_notes;
  view.reporter_type = 'citizen';
  return view;
}

export function incidentIsPubliclyVisible(record: IncidentRecord): boolean {
  if (record.public_visible === false) return false;
  if (record.deleted_at) return false;
  const status = String(record.status || '').toLowerCase();
  return !['deleted', 'purged', 'rejected'].includes(status);
}
