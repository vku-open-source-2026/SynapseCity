// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CapabilitiesError, CapabilitiesClient, type Dataset } from '@synapsedx/capabilities';
import { DATASETS, TIER2_URL, capabilitiesFromRequest, ensureDataset, objectBody, requiredString } from './domain';
import { proxyTier2Tile, tier2MapConfigured } from './tier2-map';
import {
  AuthedRequest,
  Permission,
  SessionPrincipal,
  containsPassword,
  hasPermission,
  issueSession,
  normalizeRole,
  permissionsForRole,
  principalFromInput,
  requireSession,
  revokeSession,
  sanitizeUser,
  sessionFromRequest,
  sessionUser,
  verifyToken,
} from './auth';
import { missingColumns, parseCsv } from './csv';
import { workspaceMovedMiddleware } from './workspace-moved';
import {
  buildNotification,
  dedupeKey,
  deliveryStatuses,
  externalChannels,
  notificationCapabilityStatus,
  preferenceRecipient,
  templateDefinition,
  templateVariables,
  type DeliveryReceipt,
  type NotificationChannel,
  type NotificationType,
} from './notifications';
import { aiChat, aiStatus } from './ai';
import {
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  UPLOAD_MIME_TYPES,
  assertMimeType,
  assertNoInlineBinary,
  assertStoredFileReference,
  checksumOf,
  cityFileUrl,
  fileIdFromReference,
  fileMaxBytes,
  fileMaxBytesFor,
  filesCapabilityStatus,
  isDataUrl,
  looksLikeFileId,
  normalizeChecksum,
  validateUpload,
} from './files';
import {
  identityCapabilityStatus,
  demoAuthAllowed,
  authErrorStatus,
  identityDependency,
  roleForIdentity,
  tier2Login,
  tier2Register,
  type Tier2Session,
} from './identity';
import {
  geoCoderStatus,
  tier2Autocomplete,
  tier2Geocode,
  tier2Reverse,
} from './geo-provider';
import {
  analyseCoverage,
  type CoverageAreaInput,
  type CoverageAsset,
  type CoverageIncident,
} from './analytics';
import { maintenanceFromAlert, shouldCreateMaintenance, type AlertForAutomation } from './alerts';
import { derivePreventiveTasks, filterPreventiveTasks, type PreventivePlan } from './preventive';
import { assertApproved, createApproval, decideApproval, hitlRequired, listPendingApprovals, type HitlError } from './hitl';
import { rankAssetsByRisk, scoreAssetRisk, type RiskSensorReading } from './risk';
import {
  generateReport,
  normalizeReportFormat,
  normalizeReportType,
} from './reports';
import {
  incidentIsPubliclyVisible,
  mergeIncidentInternal,
  toInternalIncident,
  toPublicIncidentView,
  toPublishedIncident,
} from './incidents';
import {
  estimatedDurationSeconds,
  haversineMeters,
  parsePoint,
  pointInBoundingBox,
  pointInPolygon,
  polygonCoordinates,
} from './geo';
import { metricsMiddleware, rateLimit, renderMetrics, verifyTurnstile } from './security';


const app = express();
const PORT = Number(process.env.PORT || 8083);
const PRODUCT = 'synapsecity';
const PUBLIC_URL = 'https://synapsecity.sbs';
const CITY_FEATURES = [
  'assets',
  'asset-lifecycle',
  'incidents',
  'maintenance',
  'preventive-maintenance',
  'technician-portal',
  'iot',
  'alerts',
  'notifications',
  'budgets',
  'reports',
  'users',
  'geofences',
  'ingest',
  'map',
  'geocoding',
  'ai',
  'public-asset-map',
  'public-incident-reporting',
  'public-incident-lookup',
] as const;
const NOT_OWNED = [
  'hazards',
  'emergency-events',
  'eop',
  'dispatch',
  'resources',
  'sitrep',
  'aar',
  'emergency-command-centre',
] as const;
// SynapseCitySOS owns these namespaces. They are rejected locally so a
// misrouted SOS request never reaches a City dataset or upstream.
const FOREIGN_NAMESPACES = ['/v1/emergency', '/v1/hazards', '/v1/sos'] as const;

// Product-boundary invariant: SynapseCity may only ever touch city-* datasets.
// A sos-* dataset belongs to the separate SynapseCitySOS product.
for (const spec of Object.values(DATASETS)) {
  if (!spec.id.startsWith('city-')) throw new Error(`SynapseCity dataset must use the city- prefix: ${spec.id}`);
}

app.disable('x-powered-by');
// The gateway is the only network hop in front of the service and forwards the
// client address, so the rate limiter can key on it.
app.set('trust proxy', true);
// CSV uploads are sent as JSON text (the DataIngest screen reads the file in
// the browser). Photos/documents are references to Tier-2 file storage, never
// data URLs; a 2 MB JSON limit is enough for ingest payloads and record writes.
// Binary upload endpoints must be parsed before the JSON body parser, otherwise
// a JSON/PDF/PNG file whose content type is `application/json` arrives as an
// object instead of bytes.
function hitlActor(req: Request): string {
  const session = (req as AuthedRequest).session || sessionFromRequest(req);
  return String((session as any)?.username || (session as any)?.email || (session as any)?.sub || 'city-user');
}

const uploadRaw = express.raw({ type: () => true, limit: fileMaxBytes() + 1024 * 1024 });
const isRawUploadPath = (pathname: string): boolean => pathname === '/v1/files/upload'
  || pathname === '/v1/public/files'
  || /^\/v1\/files\/[^/]+\/content$/.test(pathname);
app.use((req, res, next) => {
  if (!isRawUploadPath(req.path)) return next();
  if ((req as Request & { _body?: boolean })._body || Buffer.isBuffer(req.body)) return next();
  return uploadRaw(req, res, next);
});
app.use(express.json({ limit: '2mb' }));
// No write payload may carry a `data:` URL or inline base64 body; binary content
// belongs in the Tier-2 files capability.
app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return next();
  if (!req.body || typeof req.body !== 'object' || Buffer.isBuffer(req.body)) return next();
  try {
    assertNoInlineBinary(req.body);
    next();
  } catch (error) {
    next(error);
  }
});
app.use(metricsMiddleware);
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN || 'https://synapsecity.sbs';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use((_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  next();
});

function normalizedPath(pathname: string): string {
  let path = pathname;
  for (let round = 0; round < 3; round += 1) {
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = decoded;
    } catch { break; }
  }
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { segments.pop(); continue; }
    segments.push(segment.toLowerCase());
  }
  return `/${segments.join('/')}`;
}

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isForeignNamespace(pathname: string): boolean {
  const path = normalizedPath(pathname);
  return FOREIGN_NAMESPACES.some((prefix) => within(path, prefix));
}

app.use((req, res, next) => {
  if (!isForeignNamespace(req.path)) return next();
  res.status(404).json({ error: 'not_found', product: PRODUCT });
});

function numberParam(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 0), max) : fallback;
}

function privateInput(req: Request): Record<string, unknown> {
  const body = objectBody(req.body);
  return body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data as Record<string, unknown> : body;
}

function recordData(row: any): Record<string, unknown> {
  const data = (row?.data ?? row?.object ?? row) as Record<string, unknown>;
  return {
    ...data,
    id: data.id || row?.id,
    created_at: data.created_at || row?.createdAt,
    updated_at: data.updated_at || row?.updatedAt,
  };
}

function coordinatesOf(data: Record<string, unknown>): { longitude: number; latitude: number } {
  const geometry = data.geometry as { type?: string; coordinates?: unknown } | undefined;
  if (geometry && Array.isArray(geometry.coordinates) && typeof geometry.coordinates[0] === 'number' && typeof geometry.coordinates[1] === 'number') {
    return { longitude: geometry.coordinates[0], latitude: geometry.coordinates[1] };
  }
  const location = data.location as { coordinates?: { longitude?: unknown; latitude?: unknown } } | undefined;
  return {
    longitude: Number(location?.coordinates?.longitude) || 0,
    latitude: Number(location?.coordinates?.latitude) || 0,
  };
}

function assetView(row: any): Record<string, unknown> {
  const data = recordData(row);
  const location = (data.location && typeof data.location === 'object' ? data.location : {}) as Record<string, unknown>;
  const geometry = data.geometry || location.geometry || { type: 'Point', coordinates: [0, 0] };
  const assetCode = String(data.asset_code || data.assetCode || data.assetId || data.feature_code || data.id || '');
  return {
    ...data,
    id: data.id || assetCode,
    asset_code: data.asset_code || assetCode,
    name: data.name || assetCode,
    feature_type: data.feature_type || data.assetType || 'infrastructure',
    feature_code: data.feature_code || assetCode,
    geometry,
    location: { ...location, geometry },
    status: data.status || 'active',
  };
}

function incidentView(row: any): Record<string, unknown> {
  const data = recordData(row);
  return {
    ...data,
    id: data.id || data.incidentId,
    incident_code: data.incident_code || data.incident_number || data.incidentId || data.id,
    incident_number: data.incident_number || data.incident_code || data.incidentId || data.id,
    asset_id: data.asset_id || data.assetId,
    reporter_type: data.reporter_type || 'admin',
    upvotes: Number(data.upvotes) || 0,
    comments: Array.isArray(data.comments) ? data.comments : [],
    photos: Array.isArray(data.photos) ? data.photos : [],
    reported_at: data.reported_at || data.occurredAt || data.created_at,
    created_at: data.created_at,
    updated_at: data.updated_at || data.created_at,
  };
}

const PUBLIC_ASSET_FIELDS = [
  'id',
  'asset_code',
  'name',
  'feature_type',
  'feature_code',
  'category',
  'status',
  'location',
  'geometry',
] as const;

function assetIsPublic(asset: Record<string, unknown>, options: { includeInactive?: boolean } = {}): boolean {
  if (asset.deleted_at) return false;
  if (asset.public_visible === false) return false;
  // The public map can ask for the complete infrastructure inventory; the
  // default projection still keeps retired/decommissioned assets out.
  if (options.includeInactive === true) return true;
  const status = String(asset.status || '').toLowerCase();
  const lifecycle = String(asset.lifecycle_stage || (asset.lifecycle as Record<string, unknown> | undefined)?.lifecycle_status || '').toLowerCase();
  return !['decommissioned', 'deleted', 'purged', 'retired'].includes(status)
    && !['decommissioned', 'deleted', 'retired'].includes(lifecycle);
}

/**
 * Public asset projection. The documented contract is a stable JSON object with
 * these fields; it is deliberately *not* an NGSI-LD entity (see README).
 */
function publicAssetView(row: any): Record<string, unknown> {
  const asset = assetView(row);
  const location = (asset.location || {}) as Record<string, unknown>;
  const coordinates = coordinatesOf(asset);
  const assetCode = String(asset.asset_code || asset.id || '');
  const url = `${PUBLIC_URL}/asset/${encodeURIComponent(assetCode)}`;
  const view: Record<string, unknown> = {
    id: asset.id,
    asset_code: assetCode,
    name: asset.name,
    feature_type: asset.feature_type,
    feature_code: asset.feature_code,
    category: String(asset.category || asset.feature_type || 'infrastructure'),
    status: asset.status,
    location: {
      address: String(location.address || ''),
      coordinates,
      geometry: asset.geometry,
    },
    qr_code: url,
    public_url: url,
  };
  for (const field of PUBLIC_ASSET_FIELDS) {
    if (view[field] === undefined && asset[field] !== undefined) view[field] = asset[field];
  }
  return view;
}

function publicIncidentView(row: any): Record<string, unknown> {
  return toPublicIncidentView(recordData(row));
}

/**
 * Read every record of a dataset. Tier-2 exposes only limit/offset, so the City
 * service pages through the API and applies its own predicates before paging the
 * response; filtering after `limit` (the previous behaviour) missed matches.
 */
async function listAllRecords(client: CapabilitiesClient, datasetId: string, maxRecords = 5000): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const items: Array<{ id: string; data: Record<string, unknown> }> = [];
  const pageSize = 500;
  let offset = 0;
  for (;;) {
    const page = await client.records.list<Record<string, unknown>>(datasetId, { limit: pageSize, offset });
    for (const item of page.items) {
      items.push({ id: item.id, data: recordData(item) });
      if (items.length >= maxRecords) return items;
    }
    if (page.items.length < pageSize) return items;
    offset += pageSize;
    if (Number.isFinite(page.total) && offset >= page.total) return items;
  }
}

/**
 * Ask Tier-2 for a filtered page instead of downloading a whole dataset. IoT
 * readings grow without bound, so the old `list`-and-filter path hit its 5000
 * record ceiling and hid every sensor after the first few thousand rows.
 */
async function queryRecords(
  client: CapabilitiesClient,
  datasetId: string,
  where: Record<string, unknown>,
  options: { limit?: number; offset?: number; orderBy?: { field: string; direction: 'asc' | 'desc' } } = {},
): Promise<{ items: Array<Record<string, unknown>>; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000);
  const offset = Math.max(options.offset ?? 0, 0);
  const page = await client.records.query<Record<string, unknown>>(datasetId, {
    where,
    // Tier-2 accepts the `field:asc|desc` string form; an object is rejected by
    // its request validator even though the SDK type is wider.
    ...(options.orderBy ? { orderBy: `${options.orderBy.field}:${options.orderBy.direction}` } : {}),
    limit,
    offset,
  });
  return { items: page.items.map((item) => recordData(item)), total: page.total };
}

async function queryAllRecords(
  client: CapabilitiesClient,
  datasetId: string,
  where: Record<string, unknown>,
  options: { maxRecords?: number; orderBy?: { field: string; direction: 'asc' | 'desc' } } = {},
): Promise<Array<Record<string, unknown>>> {
  const maxRecords = Math.min(Math.max(options.maxRecords ?? 5000, 1), 5000);
  const items: Array<Record<string, unknown>> = [];
  let offset = 0;
  while (items.length < maxRecords) {
    const page = await queryRecords(client, datasetId, where, {
      limit: Math.min(500, maxRecords - items.length),
      offset,
      ...(options.orderBy ? { orderBy: options.orderBy } : {}),
    });
    items.push(...page.items);
    if (page.items.length < 500 || items.length >= page.total) break;
    offset += page.items.length;
  }
  return items;
}

const FILTER_IGNORED = new Set([
  'limit', 'offset', 'skip', 'page', 'with_total', 'sort', 'order',
  // Route/presentation parameters that are not record fields.
  'days', 'hours', 'all', 'view', 'radius_meters', 'lng', 'lat', 'lon', 'longitude', 'latitude',
  'min_lng', 'min_lat', 'max_lng', 'max_lat', 'metric', 'unread_only',
]);

function matchesFilters(row: Record<string, unknown>, filters: Record<string, string>): boolean {
  for (const [key, raw] of Object.entries(filters)) {
    if (FILTER_IGNORED.has(key) || raw === '') continue;
    const value = row[key];
    if (raw.includes(',')) {
      const allowed = raw.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean);
      if (!allowed.includes(String(value ?? '').toLowerCase())) return false;
      continue;
    }
    if (key.endsWith('_from') || key.endsWith('_after')) {
      const field = key.replace(/_(from|after)$/, '');
      const candidate = Date.parse(String(row[field] || ''));
      if (Number.isFinite(candidate) && candidate < Date.parse(raw)) return false;
      continue;
    }
    if (key.endsWith('_to') || key.endsWith('_before')) {
      const field = key.replace(/_(to|before)$/, '');
      const candidate = Date.parse(String(row[field] || ''));
      if (Number.isFinite(candidate) && candidate > Date.parse(raw)) return false;
      continue;
    }
    if (key === 'q' || key === 'search') {
      const needle = raw.toLowerCase();
      const haystack = ['name', 'title', 'description', 'asset_code', 'feature_code', 'incident_number', 'sensor_code', 'report_code']
        .map((field) => String(row[field] || '').toLowerCase())
        .join(' ');
      if (!haystack.includes(needle)) return false;
      continue;
    }
    if (Array.isArray(value)) {
      if (!value.map(String).map((entry) => entry.toLowerCase()).includes(raw.toLowerCase())) return false;
      continue;
    }
    if (value === undefined || value === null) return false;
    if (typeof value === 'boolean') {
      if (String(value) !== raw.toLowerCase()) return false;
      continue;
    }
    if (String(value).toLowerCase() !== raw.toLowerCase()) return false;
  }
  return true;
}

function queryFilters(req: Request, extra: Record<string, string> = {}): Record<string, string> {
  const filters: Record<string, string> = { ...extra };
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') filters[key] = value;
  }
  return filters;
}

function sendPage<T>(res: Response, rows: T[], req: Request, defaultLimit = 100): void {
  const limit = numberParam(req.query.limit, defaultLimit, 500);
  const offset = numberParam(req.query.offset ?? req.query.skip, 0, 1_000_000);
  res.setHeader('x-total-count', String(rows.length));
  res.json(rows.slice(offset, offset + limit));
}


async function findRecord(
  client: CapabilitiesClient,
  datasetId: string,
  reference: string,
  matchKeys: string[],
): Promise<Record<string, unknown> | null> {
  try {
    return recordData(await client.records.get(datasetId, reference));
  } catch (error) {
    if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
  }
  const page = await client.records.list(datasetId, { limit: 500, offset: 0 });
  const needle = reference.toLowerCase();
  const found = page.items
    .map(recordData)
    .find((row) => matchKeys.some((key) => String(row[key] || '').toLowerCase() === needle));
  return found || null;
}

async function updateAsset(req: Request, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.assets);
  const current = assetView(await client.records.get(dataset.id, id));
  const updated = await client.records.update(dataset.id, id, {
    ...current,
    ...patch,
    id,
    source: 'synapsecity',
    updatedBy: 'domain-api',
    updated_at: new Date().toISOString(),
  });
  return assetView(updated);
}

/**
 * Tier-2 record ids are unique across datasets. The public incident and its
 * private sidecar therefore use different ids; `incident_id` ties them
 * together. The legacy id is still read as a fallback so an older sidecar can
 * be merged without a migration.
 */
function incidentInternalRecordId(incidentId: string): string {
  return `internal-${incidentId}`;
}

async function findIncidentInternal(client: CapabilitiesClient, incidentId: string): Promise<Record<string, unknown> | null> {
  const dataset = await ensureDataset(client, DATASETS.incidentInternal);
  for (const id of [incidentInternalRecordId(incidentId), incidentId]) {
    try {
      return recordData(await client.records.get(dataset.id, id));
    } catch (error) {
      if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    }
  }
  return null;
}

async function writeIncidentInternal(req: Request, incidentId: string, record: Record<string, unknown>): Promise<void> {
  const internal = toInternalIncident(record);
  if (!internal) return;
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.incidentInternal);
  const internalId = incidentInternalRecordId(incidentId);
  const payload = { ...internal, id: internalId, incident_id: incidentId };
  try {
    await client.records.update(dataset.id, internalId, payload);
  } catch (error) {
    if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    await client.records.create(dataset.id, payload, { id: internalId, publish: false });
  }
}

/** Operator-facing incident: the public projection merged with its private sidecar. */
async function findIncident(req: Request, reference: string): Promise<Record<string, unknown> | null> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.incidents);
  const found = await findRecord(client, dataset.id, reference, ['incident_number', 'incident_code', 'incidentId', 'id']);
  if (!found) return null;
  const internal = await findIncidentInternal(client, String(found.id || reference));
  return mergeIncidentInternal(found, internal);
}

/** Anonymous-facing incident: never merges the private sidecar. */
async function findPublicIncident(req: Request, reference: string): Promise<Record<string, unknown> | null> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.incidents);
  return findRecord(client, dataset.id, reference, ['incident_number', 'incident_code', 'incidentId', 'id']);
}

async function updateIncident(req: Request, reference: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.incidents);
  const found = await findIncident(req, reference);
  if (!found) throw Object.assign(new Error('incident_not_found'), { status: 404 });
  const current = incidentView(found);
  const id = String(current.id || reference);
  const merged = {
    ...current,
    ...patch,
    id,
    source: 'synapsecity',
    updated_at: new Date().toISOString(),
  };
  // Field-level redaction happens before the Tier-2 write: `city-incidents` is a
  // public projection, so reporter identity and internal comments must already
  // be absent from the payload Tier-2 ingests into SynapseLDS.
  const published = toPublishedIncident(merged);
  const updated = await client.records.update(dataset.id, id, published);
  await writeIncidentInternal(req, id, merged);
  const internal = toInternalIncident(merged);
  return incidentView(mergeIncidentInternal(recordData(updated), internal));
}

function incidentNumber(): string {
  const year = new Date().getUTCFullYear();
  return `INC-${year}-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

/**
 * Notification production.
 *
 * Every domain transition persists an in-app projection in `city-notifications`
 * (idempotent by `dedupe_key`) and, when external delivery is configured, sends
 * the same event through the Tier-2 notifications capability using a City
 * template. Per-channel receipts are stored on the projection; an unavailable
 * provider never makes the domain transition fail and is never reported as
 * delivered.
 */
const ensuredTemplates = new Set<string>();

function externalDeliveryEnabled(): boolean {
  const raw = (process.env.CITY_NOTIFY_EXTERNAL || process.env.SYNAPSEDX_NOTIFY_EXTERNAL || '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

async function operatorContact(client: CapabilitiesClient, userId: string): Promise<{ email?: string; phone?: string; push_token?: string } | null> {
  try {
    const dataset = await ensureDataset(client, DATASETS.users);
    let profile: Record<string, unknown> | null = null;
    try {
      profile = recordData(await client.records.get(dataset.id, userId));
    } catch (error) {
      if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    }
    if (!profile) {
      const page = await client.records.list(dataset.id, { limit: 500, offset: 0 });
      const needle = userId.toLowerCase();
      profile = page.items
        .map((item) => recordData(item))
        .find((row) => [row.id, row.username, row.email].some((value) => String(value || '').toLowerCase() === needle)) || null;
    }
    if (!profile) return null;
    const email = String(profile.email || '').trim();
    const phone = String(profile.phone || profile.phone_number || '').trim();
    const push = String(profile.push_token || profile.pushToken || '').trim();
    if (!email && !phone && !push) return null;
    return {
      ...(email ? { email } : {}),
      ...(phone ? { phone } : {}),
      ...(push ? { push_token: push } : {}),
    };
  } catch (error) {
    console.warn('[synapsecity] notification_recipient_lookup_failed', (error as Error).message);
    return null;
  }
}

async function ensureNotificationTemplate(client: CapabilitiesClient, type: NotificationType, channel: NotificationChannel): Promise<string> {
  const definition = templateDefinition(type);
  const id = `${definition.id}-${channel}`;
  if (ensuredTemplates.has(id)) return id;
  try {
    await client.notifications.getTemplate(id);
    ensuredTemplates.add(id);
    return id;
  } catch (error) {
    if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
  }
  try {
    await client.notifications.createTemplate({
      id,
      name: `${definition.name} (${channel})`,
      channel,
      subject: definition.subject,
      body: definition.body,
    });
  } catch (error) {
    // Another worker may have created it concurrently; a 409 is success for us.
    if (!(error instanceof CapabilitiesError) || error.status !== 409) throw error;
  }
  ensuredTemplates.add(id);
  return id;
}

function receiptFor(channel: NotificationChannel, record: Record<string, unknown> | undefined): DeliveryReceipt {
  const raw = String(record?.status || '').toLowerCase();
  const id = record?.id ? String(record.id) : undefined;
  const status: DeliveryReceipt['status'] =
    raw === 'delivered' ? 'delivered'
      : raw === 'sending' || raw === 'queued' ? 'queued'
        : raw === 'failed' || raw === 'dead' ? 'failed'
          : raw === 'cancelled' ? 'suppressed'
            : 'queued';
  return {
    status,
    channel,
    ...(id ? { notification_id: id } : {}),
    ...(record?.error ? { error: String(record.error) } : {}),
  };
}

async function deliverExternal(
  client: CapabilitiesClient,
  notification: ReturnType<typeof buildNotification>,
  channels: NotificationChannel[],
  contact: { email?: string; phone?: string; push_token?: string },
): Promise<Partial<Record<NotificationChannel, DeliveryReceipt>>> {
  const receipts: Partial<Record<NotificationChannel, DeliveryReceipt>> = {};
  for (const channel of channels) {
    const recipient = channel === 'email'
      ? { email: contact.email }
      : channel === 'sms'
        ? { phone: contact.phone }
        : { pushToken: contact.push_token };
    try {
      const template = await ensureNotificationTemplate(client, notification.type, channel);
      const result = await client.notifications.send({
        channel,
        recipient,
        template,
        variables: templateVariables(notification),
        priority: notification.severity === 'critical' ? 'urgent' : 'normal',
        idempotencyKey: `${notification.dedupe_key || notification.id}:${channel}`,
        data: {
          city_notification_id: notification.id,
          city_type: notification.type,
          ...(notification.entity_type ? { entity_type: notification.entity_type } : {}),
          ...(notification.entity_id ? { entity_id: notification.entity_id } : {}),
        },
      });
      receipts[channel] = receiptFor(channel, (result.notifications || [])[0] as unknown as Record<string, unknown> | undefined);
    } catch (error) {
      const status = error instanceof CapabilitiesError ? error.status : 0;
      const code = error instanceof CapabilitiesError ? String((error.body as Record<string, unknown> | undefined)?.error || '') : '';
      receipts[channel] = code.includes('notification_suppressed') || status === 409
        ? { status: 'suppressed', channel, detail: 'recipient_unsubscribed' }
        : status === 503
          ? { status: 'unsupported', channel, dependency: 'https://github.com/vku-open-source-2026/SynapseDX/issues/10', detail: 'notification_delivery_unavailable' }
          : { status: 'failed', channel, error: (error as Error).message };
      console.warn('[synapsecity] notification_delivery_failed', channel, (error as Error).message);
    }
  }
  return receipts;
}

async function pushNotification(req: Request, input: Parameters<typeof buildNotification>[0]): Promise<Record<string, unknown> | null> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.notifications);
  if (input.dedupe_key) {
    const existing = await listAllRecords(client, dataset.id, 2000);
    const duplicate = existing.find((record) => String(record.data.dedupe_key || '') === input.dedupe_key);
    if (duplicate) return null;
  }
  const contact = externalDeliveryEnabled() ? await operatorContact(client, input.user_id) : null;
  const channels = contact ? externalChannels(contact) : [];
  const pending = deliveryStatuses(Object.fromEntries(
    channels.map((channel) => [channel, { status: 'queued', channel } as DeliveryReceipt]),
  ) as Partial<Record<NotificationChannel, DeliveryReceipt>>);
  const notification = buildNotification({ ...input, recipient: contact || undefined }, new Date(), pending);
  if (channels.length && contact) {
    const receipts = await deliverExternal(client, notification, channels, contact);
    for (const [channel, receipt] of Object.entries(receipts)) {
      if (receipt) notification.delivery[channel] = receipt;
    }
    notification.updated_at = new Date().toISOString();
  }
  const created = await client.records.create(dataset.id, notification, { id: notification.id, publish: false });
  return recordData(created);
}

// ---------------------------------------------------------------------------
// Auth session shell
// ---------------------------------------------------------------------------
// The City product owns the /v1/auth namespace as a stateless session adapter.
// In `tier2` mode (default) credentials are verified by the Tier-2 auth
// capability, which proxies Tier-1 IAM. City stores no passwords and keeps the
// Tier-1 token inside the signed session. The demo shell is explicit and
// development-only. See identity.ts for the full design note.

const IDENTITY_DEPENDENCY = identityDependency();

const authRateLimit = rateLimit({
  name: 'auth',
  windowMs: Math.max(1000, Number(process.env.AUTH_RATE_WINDOW_MS || 300_000)),
  max: Math.max(1, Number(process.env.AUTH_RATE_LIMIT || 30)),
});

export function demoRole(): SessionPrincipal['role'] {
  // Demo role is operator configuration, never a request field.
  return normalizeRole(process.env.AUTH_DEMO_ROLE || 'admin', 'citizen');
}

function identityUnavailable(res: Response, status = 503, code = 'identity_not_configured', detail = 'Identity verification is unavailable.'): void {
  res.status(status).json({ error: code, detail, dependency: IDENTITY_DEPENDENCY });
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function findCityProfile(client: CapabilitiesClient, identity: { userId: string; email: string }): Promise<Record<string, unknown> | null> {
  try {
    const dataset = await ensureDataset(client, DATASETS.users);
    try {
      return recordData(await client.records.get(dataset.id, identity.userId));
    } catch (error) {
      if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    }
    const page = await client.records.list(dataset.id, { limit: 500, offset: 0 });
    const email = identity.email.toLowerCase();
    return page.items
      .map((item) => recordData(item))
      .find((row) => String(row.email || '').toLowerCase() === email) || null;
  } catch (error) {
    // A missing operator profile store must not turn identity verification into
    // an outage; the default role is citizen, never admin.
    console.warn('[synapsecity] operator_profile_lookup_failed', (error as Error).message);
    return null;
  }
}

function sessionForVerifiedIdentity(identity: Tier2Session['identity'], role: SessionPrincipal['role'], tokens: Tier2Session, profile?: Record<string, unknown> | null) {
  const username = String(profile?.username || identity.email || identity.userId);
  return issueSession({
    sub: identity.userId,
    username,
    email: identity.email || `${username}@synapsecity.local`,
    full_name: String(profile?.full_name || identity.displayName || username),
    ...(profile?.phone ? { phone: String(profile.phone) } : {}),
    role,
    permissions: permissionsForRole(role),
    auth_source: 'tier2',
    ...(tokens.token ? { tier2_token: tokens.token } : {}),
    ...(tokens.refreshToken ? { tier2_refresh_token: tokens.refreshToken } : {}),
  });
}

// Tier-3 auth surface is retired: every /v1/auth request is answered with
// 410 workspace_moved before rate limiting, credential handling or session
// code. Work interfaces live in the Tier-2 DX workspace.
app.use('/v1/auth', workspaceMovedMiddleware('city'));

app.post('/v1/auth/login', authRateLimit, async (req, res) => {
  const body = objectBody(req.body);
  const usernameOrEmail = String(body.email || body.username || '').trim();
  const password = String(body.password || '');
  if (!usernameOrEmail) return res.status(400).json({ error: 'email_required' });
  if (!password.trim()) return res.status(400).json({ error: 'password_required' });

  if (demoAuthAllowed()) {
    // `body.role` is intentionally ignored: a caller cannot choose its role.
    const principal = principalFromInput({
      username: usernameOrEmail,
      email: typeof body.email === 'string' ? body.email : undefined,
      full_name: typeof body.full_name === 'string' ? body.full_name : undefined,
      phone: typeof body.phone === 'string' ? body.phone : undefined,
    }, demoRole());
    return res.json(issueSession({ ...principal, demo: true, auth_source: 'demo' }));
  }

  if (!isEmail(usernameOrEmail)) {
    return res.status(400).json({ error: 'email_required', detail: 'Tier-2 identity requires an email address.' });
  }
  const client = capabilitiesFromRequest(req);
  try {
    const tokens = await tier2Login(client, {
      email: usernameOrEmail,
      password,
      ...(typeof body.org_slug === 'string' ? { orgSlug: body.org_slug } : {}),
    });
    const profile = await findCityProfile(client, tokens.identity);
    const role = roleForIdentity(tokens.identity, profile);
    res.json(sessionForVerifiedIdentity(tokens.identity, role, tokens, profile));
  } catch (error) {
    const mapped = authErrorStatus(error);
    identityUnavailable(res, mapped.status, mapped.code, mapped.detail);
  }
});

app.post('/v1/auth/register', authRateLimit, async (req, res) => {
  const body = objectBody(req.body);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  const fullName = String(body.full_name || body.display_name || '').trim();
  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!isEmail(email)) return res.status(400).json({ error: 'email_invalid' });
  if (fullName && !String(body.username || '').trim() && fullName.length > 200) return res.status(400).json({ error: 'full_name_too_long' });
  if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });

  if (demoAuthAllowed()) {
    // Self-registration never grants an operator role. Passwords are not stored.
    const principal = principalFromInput({ username: String(body.username || email), email, full_name: fullName || email, phone: typeof body.phone === 'string' ? body.phone : undefined }, 'citizen');
    return res.status(201).json(issueSession({ ...principal, role: 'citizen', permissions: permissionsForRole('citizen'), demo: true, auth_source: 'demo' }));
  }

  const client = capabilitiesFromRequest(req);
  try {
    const tokens = await tier2Register(client, {
      email,
      password,
      ...(fullName ? { displayName: fullName } : {}),
      ...(typeof body.org_slug === 'string' ? { orgSlug: body.org_slug } : {}),
    });
    // A self-registered identity is always a citizen; operator roles are only
    // assigned by a City administrator through /v1/users.
    const session = sessionForVerifiedIdentity(tokens.identity, 'citizen', tokens, { username: fullName || email });
    res.status(201).json(session);
  } catch (error) {
    const mapped = authErrorStatus(error);
    identityUnavailable(res, mapped.status, mapped.code, mapped.detail);
  }
});

app.post('/v1/auth/refresh', authRateLimit, async (req, res) => {
  const body = objectBody(req.body);
  const token = String(body.refresh_token || '');
  const principal = token ? verifyToken(token, 'refresh') : null;
  if (!principal) return res.status(401).json({ error: 'invalid_refresh_token' });
  if (principal.demo && !demoAuthAllowed()) return identityUnavailable(res);

  if (principal.auth_source === 'tier2') {
    if (!principal.tier2_refresh_token) return res.status(401).json({ error: 'invalid_refresh_token', detail: 'no_tier2_refresh_token' });
    const client = capabilitiesFromRequest(req);
    try {
      const rotated = await client.auth.refresh(principal.tier2_refresh_token) as unknown as Record<string, unknown>;
      const accessToken = String(rotated.accessToken || rotated.access_token || '');
      const refreshToken = String(rotated.refreshToken || rotated.refresh_token || principal.tier2_refresh_token);
      return res.json(issueSession({
        sub: principal.sub,
        username: principal.username,
        email: principal.email,
        full_name: principal.full_name,
        ...(principal.phone ? { phone: principal.phone } : {}),
        role: principal.role,
        permissions: permissionsForRole(principal.role),
        auth_source: 'tier2',
        ...(accessToken ? { tier2_token: accessToken } : {}),
        tier2_refresh_token: refreshToken,
      }));
    } catch (error) {
      const mapped = authErrorStatus(error);
      return identityUnavailable(res, mapped.status === 401 ? 401 : 503, mapped.status === 401 ? 'invalid_refresh_token' : mapped.code, mapped.detail);
    }
  }

  res.json(issueSession({
    sub: principal.sub,
    username: principal.username,
    email: principal.email,
    full_name: principal.full_name,
    ...(principal.phone ? { phone: principal.phone } : {}),
    role: principal.role,
    permissions: permissionsForRole(principal.role),
    auth_source: principal.auth_source || (principal.demo ? 'demo' : undefined),
    demo: principal.demo === true,
    ...(principal.tier2_token ? { tier2_token: principal.tier2_token } : {}),
    ...(principal.tier2_refresh_token ? { tier2_refresh_token: principal.tier2_refresh_token } : {}),
  }));
});

app.post('/v1/auth/logout', async (req, res) => {
  const principal = sessionFromRequest(req);
  const body = req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  const refresh = String(body.refresh_token || '');
  const refreshPrincipal = refresh ? verifyToken(refresh, 'refresh') : null;
  if (principal) revokeSession(principal);
  if (refreshPrincipal) revokeSession(refreshPrincipal);
  const tier2Refresh = refreshPrincipal?.tier2_refresh_token || principal?.tier2_refresh_token;
  if (tier2Refresh) {
    // Best-effort Tier-1 session revocation; City still invalidates its own jti.
    await capabilitiesFromRequest(req).auth.logout(tier2Refresh).catch(() => undefined);
  }
  res.status(204).end();
});

app.post('/v1/auth/change-password', requireSession, async (req, res) => {
  const body = objectBody(req.body);
  const currentPassword = String(body.current_password || '');
  const newPassword = String(body.new_password || '');
  if (!currentPassword.trim() || !newPassword.trim()) {
    return res.status(400).json({ error: 'current_and_new_password_required' });
  }
  const principal = (req as AuthedRequest).session as SessionPrincipal;
  if (principal.auth_source !== 'tier2' || !principal.tier2_token) {
    return identityUnavailable(res, 503, 'identity_not_configured', 'Password changes require the Tier-2 identity capability.');
  }
  try {
    await capabilitiesFromRequest(req).auth.changePassword(currentPassword, newPassword);
    res.status(204).end();
  } catch (error) {
    const mapped = authErrorStatus(error);
    identityUnavailable(res, mapped.status, mapped.code, mapped.detail);
  }
});

app.get('/v1/auth/me', requireSession, (req, res) => {
  res.json(sessionUser((req as AuthedRequest).session as SessionPrincipal));
});

app.get('/v1/auth/verify', requireSession, (req, res) => {
  const principal = (req as AuthedRequest).session as SessionPrincipal;
  res.json({
    valid: true,
    user_id: principal.sub,
    username: principal.username,
    role: principal.role,
    permissions: principal.permissions,
    identity_source: principal.auth_source || (principal.demo ? 'demo' : 'legacy'),
  });
});

// ---------------------------------------------------------------------------
// Service metadata
// ---------------------------------------------------------------------------

function capabilityStatus(): Record<string, unknown> {
  return {
    datasets: { status: 'available', transport: 'synapsedx' },
    records: { status: 'available', transport: 'synapsedx' },
    files: filesCapabilityStatus(),
    ai: {
      status: 'available',
      transport: 'synapsedx',
      detail: 'Tier-2 exposes ai.status/ai.chat; GET /v1/ai/status reports provider health and failures.',
    },
    notifications: notificationCapabilityStatus(externalDeliveryEnabled()),
    identity: identityCapabilityStatus(),
    geo: geoCoderStatus(),
    jobs: {
      status: 'not_used',
      detail: 'City report generation is synchronous and bounded (aggregate rows from City datasets); the Tier-2 runner contract is documented but not simulated.',
    },
  };
}

app.get('/health', async (req, res) => {
  try {
    const tier2 = await capabilitiesFromRequest(req).health();
    res.json({ status: 'ok', service: 'synapsecity', tier: 3, tier2, tier2Url: TIER2_URL, capabilities: capabilityStatus() });
  } catch (error) {
    res.status(503).json({
      status: 'degraded',
      service: 'synapsecity',
      tier: 3,
      tier2Url: TIER2_URL,
      dependency: { name: 'synapsedx', status: 'unavailable', error: (error as Error).message },
      capabilities: capabilityStatus(),
    });
  }
});

app.get('/ready', async (req, res) => {
  try {
    const tier2 = await capabilitiesFromRequest(req).health();
    res.json({ status: 'ready', service: 'synapsecity', tier: 3, tier2, tier2Url: TIER2_URL, capabilities: capabilityStatus() });
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      service: 'synapsecity',
      tier: 3,
      tier2Url: TIER2_URL,
      dependency: { name: 'synapsedx', status: 'unavailable', error: (error as Error).message },
      capabilities: capabilityStatus(),
    });
  }
});

app.get('/metrics', (req, res) => {
  const token = (process.env.METRICS_TOKEN || '').trim();
  if (token && req.header('x-metrics-token') !== token && req.header('authorization') !== `Bearer ${token}`) {
    return res.status(401).json({ error: 'metrics_token_required' });
  }
  res.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
});

app.get('/v1/city', (_req, res) => res.json({
  service: 'synapsecity',
  product: 'synapsecity',
  tier: 3,
  version: '0.1.0',
  domain: 'infrastructure',
  publicUrl: PUBLIC_URL,
  features: CITY_FEATURES,
  notOwned: NOT_OWNED,
  datasets: Object.values(DATASETS).map((dataset) => dataset.id),
  dependency: TIER2_URL,
  capabilities: capabilityStatus(),
  authorization: {
    operatorNamespaces: 'require a signed City session',
    anonymousNamespaces: ['/health', '/ready', '/v1/city', '/v1/auth/*', '/v1/public/*', '/v1/map/*'],
    permissionMatrix: '/v1/city?include=permissions, or README "Authorization matrix"',
  },
}));

// ---------------------------------------------------------------------------
// Operator authorization boundary
// ---------------------------------------------------------------------------
// Deny by default: every /v1 namespace except the explicit anonymous surface
// requires a valid signed session and the action permission derived from its
// role. Public citizen reporting and map tiles stay anonymous.

function isAnonymousV1Path(rawPath: string): boolean {
  const path = normalizedPath(rawPath);
  return within(path, '/v1/auth')
    || within(path, '/v1/city')
    || within(path, '/v1/public')
    || within(path, '/v1/map')
    // Public assistant on the citizen map: status + chat are rate-limited and
    // proxied with the deployment's Tier-2 service credential (no user data).
    || path === '/v1/ai/status'
    || path === '/v1/ai/chat';
}

function operatorPermission(method: string, rawPath: string): Permission | 'authenticated' {
  const path = normalizedPath(rawPath);
  const read = method === 'GET' || method === 'HEAD';
  if (within(path, '/v1/users')) {
    if (within(path, '/v1/users/me')) return 'authenticated';
    return read ? 'users:read' : 'users:admin';
  }
  if (within(path, '/v1/assets')) return read ? 'assets:read' : 'assets:write';
  if (within(path, '/v1/incidents')) {
    if (path.endsWith('/verify')) return 'incidents:verify';
    return read ? 'incidents:read' : 'incidents:write';
  }
  if (within(path, '/v1/maintenance') || within(path, '/v1/preventive-maintenance')) {
    return read ? 'maintenance:read' : 'maintenance:write';
  }
  if (within(path, '/v1/iot')) return read ? 'iot:read' : 'iot:write';
  if (within(path, '/v1/alerts')) return read ? 'alerts:read' : 'alerts:write';
  if (within(path, '/v1/budgets')) {
    if (path.endsWith('/approve')) return 'budgets:approve';
    return read ? 'budgets:read' : 'budgets:write';
  }
  if (within(path, '/v1/reports')) {
    if (path.endsWith('/generate')) return 'reports:generate';
    return read ? 'reports:read' : 'reports:write';
  }
  if (within(path, '/v1/notifications')) {
    // Preferences are self-service: a technician may manage their own delivery
    // channels without the notification-producer permission.
    if (within(path, '/v1/notifications/preferences')) return 'notifications:read';
    // Reading/marking one's own notifications is a read operation; creating a
    // notification requires the write permission.
    if (read || path.endsWith('/read') || path.endsWith('/mark-all-read')) return 'notifications:read';
    return 'notifications:write';
  }
  if (within(path, '/v1/files')) return read ? 'files:read' : 'files:write';
  if (within(path, '/v1/geofences')) return read ? 'geofences:read' : 'geofences:write';
  if (within(path, '/v1/geo')) return 'geo:read';
  if (within(path, '/v1/ingest')) return 'ingest:write';
  if (within(path, '/v1/ai')) return 'ai:use';
  // Unknown operator path: still authenticate, then the /v1 fallback answers 404.
  return 'authenticated';
}

const OPERATOR_PREFIXES: readonly string[] = [
  '/v1/assets',
  '/v1/incidents',
  '/v1/maintenance',
  '/v1/preventive-maintenance',
  '/v1/iot',
  '/v1/alerts',
  '/v1/budgets',
  '/v1/reports',
  '/v1/notifications',
  '/v1/files',
  '/v1/users',
  '/v1/geofences',
  '/v1/geo',
  '/v1/ingest',
  '/v1/ai',
];

function isOperatorV1Path(rawPath: string): boolean {
  const path = normalizedPath(rawPath);
  return OPERATOR_PREFIXES.some((prefix) => within(path, prefix));
}

app.use('/v1', (req, res, next) => {
  if (isAnonymousV1Path(req.originalUrl)) return next();
  if (!isOperatorV1Path(req.originalUrl)) return next();
  const principal = sessionFromRequest(req);
  if (!principal) return res.status(401).json({ error: 'unauthorized', detail: 'authentication_required' });
  (req as AuthedRequest).session = principal;
  const permission = operatorPermission(req.method, req.originalUrl);
  if (!hasPermission(principal, permission)) {
    return res.status(403).json({ error: 'forbidden', detail: `${permission}_required`, role: principal.role });
  }
  next();
});

// ---------------------------------------------------------------------------
// Files: Tier-2 files capability adapter
// ---------------------------------------------------------------------------
// Binary content lives in Tier-1 object storage through the Tier-2 files
// capability. City stores only metadata (`city-files`) and a stable reference
// on the owning record. No `data:` URL is ever persisted.

interface CityFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  checksumSha256?: string;
  owner: string;
  public: boolean;
  entity_type?: string;
  entity_id?: string;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
}

function fileView(record: Record<string, unknown>): Record<string, unknown> {
  const owner = String(record.owner || '');
  const isPublic = record.public === true;
  const id = String(record.id || '');
  return {
    ...record,
    file_id: id,
    filename: record.filename || record.file_name,
    content_type: record.contentType || record.content_type,
    checksum_sha256: record.checksumSha256 || record.checksum_sha256,
    download_url: cityFileUrl(id, { public: isPublic }),
    file_url: cityFileUrl(id, { public: isPublic }),
    owner,
  };
}

function requesterCanUseFile(principal: SessionPrincipal | null | undefined, record: Record<string, unknown>): boolean {
  if (record.public === true) return true;
  if (!principal) return false;
  if (principal.role === 'admin' || principal.role === 'manager') return true;
  const owner = String(record.owner || '').toLowerCase();
  return Boolean(owner) && [principal.sub, principal.username].map((value) => String(value).toLowerCase()).includes(owner);
}

async function fileDataset(client: CapabilitiesClient): Promise<Dataset> {
  return ensureDataset(client, DATASETS.files);
}

async function getFileMetadata(client: CapabilitiesClient, id: string): Promise<Record<string, unknown> | null> {
  try {
    const dataset = await fileDataset(client);
    return recordData(await client.records.get(dataset.id, id));
  } catch (error) {
    if (error instanceof CapabilitiesError && error.status === 404) return null;
    throw error;
  }
}

async function saveFileMetadata(req: Request, file: CityFile): Promise<Record<string, unknown>> {
  const client = capabilitiesFromRequest(req);
  const dataset = await fileDataset(client);
  try {
    return recordData(await client.records.create(dataset.id, file, { id: file.id, publish: false }));
  } catch (error) {
    if (!(error instanceof CapabilitiesError) || (error.status !== 409 && error.status !== 400)) throw error;
    return recordData(await client.records.update(dataset.id, file.id, file));
  }
}

function decodeFilenameHeader(req: Request): string {
  const raw = String(req.header('x-file-name') || req.header('x-filename') || '').trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** Validate and upload a binary body through the Tier-2 files capability. */
async function uploadFileBytes(
  req: Request,
  options: {
    filename: string;
    contentType: string;
    bytes: Buffer;
    owner: string;
    public?: boolean;
    entityType?: string;
    entityId?: string;
    allowlist?: readonly string[];
    maxBytes?: number;
    checksumSha256?: string;
  },
): Promise<Record<string, unknown>> {
  const validated = validateUpload({
    filename: options.filename,
    contentType: options.contentType,
    size: options.bytes.length,
    allowlist: options.allowlist,
    maxBytes: options.maxBytes,
  });
  const actualChecksum = checksumOf(options.bytes);
  const expected = normalizeChecksum(options.checksumSha256);
  if (expected && expected !== actualChecksum) {
    throw Object.assign(new Error('checksum_mismatch'), { status: 400, actualChecksum });
  }
  const id = randomUUID();
  const client = capabilitiesFromRequest(req);
  const dataset = await fileDataset(client);
  const ticket = await client.files.upload({
    id,
    filename: validated.filename,
    contentType: validated.contentType,
    size: validated.size,
    checksumSha256: actualChecksum,
    datasetId: dataset.id,
    recordId: id,
    content: options.bytes,
  }).catch((error) => {
    if (error instanceof CapabilitiesError && error.status === 413) {
      throw Object.assign(new Error('file_too_large'), { status: 413 });
    }
    throw error;
  });
  const uploaded = ticket as unknown as Record<string, unknown>;
  const now = new Date().toISOString();
  return saveFileMetadata(req, {
    id: String(uploaded.id || id),
    filename: String(uploaded.filename || validated.filename),
    contentType: String(uploaded.contentType || validated.contentType),
    size: Number(uploaded.size ?? options.bytes.length),
    checksumSha256: String(uploaded.checksumSha256 || actualChecksum),
    owner: options.owner,
    public: options.public === true,
    ...(options.entityType ? { entity_type: options.entityType } : {}),
    ...(options.entityId ? { entity_id: options.entityId } : {}),
    created_at: now,
    updated_at: now,
    source: 'synapsecity',
    storage: 'tier2-files',
  });
}

/**
 * Resolve an attachment reference. A bare id (or `file_id`) is resolved against
 * `city-files`; a legacy absolute HTTPS URL is accepted as an external
 * reference; a `data:` URL is rejected.
 */
async function attachmentFromBody(
  req: Request,
  body: Record<string, unknown>,
  fallbackName = 'attachment',
  kind: 'photo' | 'document' = 'document',
  options: { publicUrl?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (body.content_base64 !== undefined || body.file_content !== undefined || body.content !== undefined) {
    // Binary content never travels inside a City record; use POST /v1/files/upload.
    throw Object.assign(new Error('raw_upload_not_accepted'), {
      status: 415,
      detail: 'Upload bytes with POST /v1/files/upload and send the returned file id.',
    });
  }
  const allowlist: readonly string[] = kind === 'photo' ? IMAGE_MIME_TYPES : DOCUMENT_MIME_TYPES;
  const principal = sessionFromRequest(req);
  const reference = String(body.file_id || body.fileId || body.file_url || body.url || body.photo || '').trim();
  if (!reference) throw Object.assign(new Error('file_reference_required'), { status: 400 });
  if (isDataUrl(reference)) throw Object.assign(new Error('data_url_not_supported'), { status: 415 });

  const isFileId = body.file_id !== undefined || body.fileId !== undefined || looksLikeFileId(reference);
  if (isFileId) {
    const client = capabilitiesFromRequest(req);
    let record = await getFileMetadata(client, String(body.file_id || body.fileId || reference));
    if (!record) throw Object.assign(new Error('file_not_found'), { status: 404 });
    if (!requesterCanUseFile(principal, record)) throw Object.assign(new Error('file_not_found'), { status: 404 });
    const contentType = String(record.contentType || record.content_type || '');
    if (!allowlist.includes(contentType)) throw Object.assign(new Error('unsupported_file_type'), { status: 415, allowed: allowlist });
    if (options.publicUrl === true && record.public !== true) {
      // A photo attached to a published incident must be readable by anonymous
      // visitors; only the owning operator can make that promotion.
      record = { ...record, public: true, updated_at: new Date().toISOString() };
      await saveFileMetadata(req, record as unknown as CityFile);
    }
    const id = String(record.id);
    return {
      file_id: id,
      file_name: String(body.file_name || body.name || record.filename || fallbackName),
      file_url: cityFileUrl(id, { public: options.publicUrl === true || record.public === true }),
      file_type: contentType,
      size: Number(record.size) || 0,
      checksum_sha256: String(record.checksumSha256 || record.checksum_sha256 || ''),
      uploaded_by: principal?.sub || String(record.owner || 'system'),
      uploaded_at: String(body.uploaded_at || new Date().toISOString()),
      ...(body.document_type !== undefined ? { document_type: String(body.document_type) } : {}),
      ...(body.is_public !== undefined ? { is_public: Boolean(body.is_public) } : {}),
      ...(body.version !== undefined ? { version: Number(body.version) } : {}),
    };
  }

  // Legacy external reference: it must already be an absolute HTTPS URL.
  const fileUrl = assertStoredFileReference(reference, { field: 'file_url', mimeTypes: allowlist });
  const fileType = assertMimeType(body.file_type || body.type, allowlist);
  return {
    file_name: String(body.file_name || body.name || fallbackName),
    file_url: fileUrl,
    file_type: fileType,
    uploaded_by: principal?.sub || 'system',
    uploaded_at: String(body.uploaded_at || new Date().toISOString()),
    ...(body.document_type !== undefined ? { document_type: String(body.document_type) } : {}),
    ...(body.is_public !== undefined ? { is_public: Boolean(body.is_public) } : {}),
    ...(body.version !== undefined ? { version: Number(body.version) } : {}),
  };
}

/** Resolve a list of photo references (file ids or legacy HTTPS URLs) to URLs. */
async function resolvePhotos(req: Request, values: unknown[], options: { publicUrl?: boolean } = {}): Promise<Array<{ url: string; attachment: Record<string, unknown> }>> {
  const resolved: Array<{ url: string; attachment: Record<string, unknown> }> = [];
  for (const [index, value] of values.entries()) {
    const body = typeof value === 'string' ? { file_url: value } : (value && typeof value === 'object' ? value as Record<string, unknown> : {});
    if (isDataUrl(String(body.file_url || body.url || body.photo || ''))) {
      throw Object.assign(new Error('data_url_not_supported'), { status: 415 });
    }
    const attachment = await attachmentFromBody(req, body, `photo-${index + 1}`, 'photo', options);
    resolved.push({ url: String(attachment.file_url), attachment });
  }
  return resolved;
}

app.get('/v1/files/quota', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const quota = await client.files.quota();
    res.json({ ...quota, cityMaxFileBytes: fileMaxBytes(), allowedTypes: UPLOAD_MIME_TYPES });
  } catch (error) { next(error); }
});

app.get('/v1/files', async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const client = capabilitiesFromRequest(req);
    const dataset = await fileDataset(client);
    const rows = (await listAllRecords(client, dataset.id, 5000))
      .map((record) => recordData(record))
      .filter((record) => requesterCanUseFile(principal, record));
    const filters = queryFilters(req);
    const filtered = rows.filter((row) => matchesFilters(row, filters));
    sendPage(res, filtered.map(fileView), req);
  } catch (error) { next(error); }
});

app.post('/v1/files', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    if (body.is_public === true && !['admin', 'manager'].includes(principal.role)) {
      return res.status(403).json({ error: 'public_file_forbidden', detail: 'Only an administrator or manager may create a public file.' });
    }
    const validated = validateUpload({
      filename: body.filename || body.file_name,
      contentType: body.content_type || body.contentType || body.file_type,
      size: body.size,
    });
    const id = randomUUID();
    const client = capabilitiesFromRequest(req);
    const dataset = await fileDataset(client);
    const ticket = await client.files.create({
      id,
      filename: validated.filename,
      contentType: validated.contentType,
      size: validated.size,
      ...(body.checksum_sha256 || body.checksumSha256 ? { checksumSha256: normalizeChecksum(body.checksum_sha256 || body.checksumSha256) } : {}),
      datasetId: dataset.id,
      recordId: id,
    });
    const now = new Date().toISOString();
    const saved = await saveFileMetadata(req, {
      id,
      filename: validated.filename,
      contentType: validated.contentType,
      size: validated.size,
      ...(body.checksum_sha256 || body.checksumSha256 ? { checksumSha256: normalizeChecksum(body.checksum_sha256 || body.checksumSha256) } : {}),
      owner: principal.sub,
      public: body.is_public === true,
      ...(body.entity_type ? { entity_type: String(body.entity_type) } : {}),
      ...(body.entity_id ? { entity_id: String(body.entity_id) } : {}),
      created_at: now,
      updated_at: now,
      source: 'synapsecity',
      storage: 'tier2-files',
    });
    let presigned: Record<string, unknown> | null = null;
    try {
      const signed = await client.files.presign(id, { method: 'PUT', expiresIn: 900 });
      presigned = { method: signed.method, url: signed.url, expires_in: (signed as unknown as Record<string, unknown>).expiresIn ?? 900 };
    } catch (error) {
      if (!(error instanceof CapabilitiesError) || error.status !== 501) throw error;
      // Filesystem backends cannot presign; the City proxy upload URL is used instead.
    }
    res.status(201).json({
      ...fileView(saved),
      upload: {
        method: 'PUT',
        url: `${PUBLIC_URL}/v1/files/${encodeURIComponent(id)}/content`,
        contentType: validated.contentType,
        ...(presigned ? { presigned } : {}),
        ...(ticket.upload ? { tier2: ticket.upload } : {}),
      },
    });
  } catch (error) { next(error); }
});

app.post('/v1/files/upload', uploadRaw, async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) {
      return res.status(400).json({ error: 'binary_body_required', detail: 'Send the raw file bytes with the file content type and X-File-Name.' });
    }
    const filename = decodeFilenameHeader(req);
    if (!filename) return res.status(400).json({ error: 'x_file_name_required' });
    const wantsPublic = req.header('x-file-visibility') === 'public';
    if (wantsPublic && !['admin', 'manager'].includes(principal.role)) {
      return res.status(403).json({ error: 'public_file_forbidden', detail: 'Only an administrator or manager may create a public file.' });
    }
    const contentType = String(req.header('content-type') || '').split(';')[0].trim();
    const saved = await uploadFileBytes(req, {
      filename,
      contentType,
      bytes,
      owner: principal.sub,
      ...(wantsPublic ? { public: true } : {}),
      ...(req.header('x-entity-type') ? { entityType: String(req.header('x-entity-type')) } : {}),
      ...(req.header('x-entity-id') ? { entityId: String(req.header('x-entity-id')) } : {}),
      ...(req.header('x-checksum-sha256') ? { checksumSha256: String(req.header('x-checksum-sha256')) } : {}),
    });
    res.status(201).json(fileView(saved));
  } catch (error) { next(error); }
});

app.put('/v1/files/:id/content', uploadRaw, async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const client = capabilitiesFromRequest(req);
    const record = await getFileMetadata(client, String(req.params.id));
    if (!record || !requesterCanUseFile(principal, record)) return res.status(404).json({ error: 'file_not_found' });
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) return res.status(400).json({ error: 'binary_body_required' });
    const contentType = String(req.header('content-type') || record.contentType || '').split(';')[0].trim();
    const checksum = checksumOf(bytes);
    const expected = normalizeChecksum(req.header('x-checksum-sha256'));
    if (expected && expected !== checksum) return res.status(400).json({ error: 'checksum_mismatch' });
    await client.files.uploadBytes(String(record.id), bytes, { contentType, checksumSha256: checksum });
    const saved = await saveFileMetadata(req, {
      ...(record as unknown as CityFile),
      id: String(record.id),
      contentType,
      size: bytes.length,
      checksumSha256: checksum,
      updated_at: new Date().toISOString(),
    });
    res.json(fileView(saved));
  } catch (error) { next(error); }
});

app.get('/v1/files/:id', async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const record = await getFileMetadata(capabilitiesFromRequest(req), String(req.params.id));
    if (!record || !requesterCanUseFile(principal, record)) return res.status(404).json({ error: 'file_not_found' });
    res.json(fileView(record));
  } catch (error) { next(error); }
});

app.get('/v1/files/:id/content', async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const client = capabilitiesFromRequest(req);
    const record = await getFileMetadata(client, String(req.params.id));
    if (!record || !requesterCanUseFile(principal, record)) return res.status(404).json({ error: 'file_not_found' });
    const download = await client.files.download(String(record.id));
    res.setHeader('content-type', String(download.contentType || record.contentType || 'application/octet-stream'));
    res.setHeader('content-length', String(download.data.length));
    res.setHeader('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(String(record.filename || 'file'))}`);
    if (download.checksumSha256 || record.checksumSha256) res.setHeader('x-checksum-sha256', String(download.checksumSha256 || record.checksumSha256));
    res.setHeader('cache-control', record.public === true ? 'public, max-age=300' : 'private, no-store');
    res.send(Buffer.from(download.data));
  } catch (error) { next(error); }
});

app.post('/v1/files/:id/presign', async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const client = capabilitiesFromRequest(req);
    const record = await getFileMetadata(client, String(req.params.id));
    if (!record || !requesterCanUseFile(principal, record)) return res.status(404).json({ error: 'file_not_found' });
    const body = privateInput(req);
    const method = ['GET', 'HEAD', 'PUT', 'DELETE'].includes(String(body.method || 'GET').toUpperCase())
      ? String(body.method || 'GET').toUpperCase() as 'GET' | 'HEAD' | 'PUT' | 'DELETE'
      : 'GET';
    const expiresIn = Number(body.expires_in ?? body.expiresIn ?? 900);
    const signed = await client.files.presign(String(record.id), { method, expiresIn });
    res.setHeader('cache-control', 'no-store');
    res.json({ file_id: String(record.id), method: signed.method || method, url: signed.url, expires_in: (signed as unknown as Record<string, unknown>).expiresIn ?? expiresIn });
  } catch (error) { next(error); }
});

app.post('/v1/files/:id/complete', async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const client = capabilitiesFromRequest(req);
    const record = await getFileMetadata(client, String(req.params.id));
    if (!record || !requesterCanUseFile(principal, record)) return res.status(404).json({ error: 'file_not_found' });
    const body = privateInput(req);
    const completed = await client.files.complete(String(record.id), body.size !== undefined ? { size: Number(body.size) } : {});
    const saved = await saveFileMetadata(req, {
      ...(record as unknown as CityFile),
      id: String(record.id),
      size: Number(completed.size ?? record.size) || 0,
      contentType: String(completed.contentType || record.contentType),
      ...(completed.checksumSha256 ? { checksumSha256: completed.checksumSha256 } : {}),
      updated_at: new Date().toISOString(),
    });
    res.json(fileView(saved));
  } catch (error) { next(error); }
});

app.delete('/v1/files/:id', async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const client = capabilitiesFromRequest(req);
    const record = await getFileMetadata(client, String(req.params.id));
    if (!record || !requesterCanUseFile(principal, record)) return res.status(404).json({ error: 'file_not_found' });
    await client.files.delete(String(record.id)).catch((error) => {
      if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    });
    const dataset = await fileDataset(client);
    await client.records.delete(dataset.id, String(record.id)).catch((error) => {
      if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    });
    res.status(204).end();
  } catch (error) { next(error); }
});

// Anonymous public file routes live in the public-reporting section below so
// they share its rate limiter and Turnstile policy.



app.get('/v1/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const rows = (await listAllRecords(client, dataset.id)).map((record) => assetView(record.data));
    const filters = queryFilters(req);
    const filtered = rows.filter((asset) => matchesFilters(asset, filters));
    sendPage(res, filtered, req);
  } catch (error) { next(error); }
});

app.post('/v1/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const body = privateInput(req);
    const name = requiredString(body, 'name');
    const assetCode = String(body.asset_code || body.feature_code || body.assetCode || randomUUID());
    const geometryInput = body.geometry;
    if (geometryInput !== undefined) {
      const geometry = geometryInput as { type?: unknown; coordinates?: unknown };
      if (!geometry || typeof geometry !== 'object' || typeof geometry.type !== 'string' || !Array.isArray(geometry.coordinates)) {
        return res.status(400).json({ error: 'geometry_must_be_geojson' });
      }
    }
    const geometry = geometryInput && typeof geometryInput === 'object' ? geometryInput : { type: 'Point', coordinates: [0, 0] };
    const asset = {
      assetId: String(body.assetId || assetCode),
      asset_code: assetCode,
      name,
      assetType: String(body.assetType || body.feature_type || 'infrastructure'),
      feature_type: String(body.feature_type || body.assetType || 'infrastructure'),
      feature_code: String(body.feature_code || assetCode),
      status: String(body.status || 'active'),
      ...(body.category !== undefined ? { category: String(body.category) } : {}),
      ...(body.condition !== undefined ? { condition: String(body.condition) } : {}),
      ...(body.lifecycle_stage !== undefined ? { lifecycle_stage: String(body.lifecycle_stage) } : {}),
      ...(geometry ? { geometry } : {}),
      ...(body.location !== undefined ? { location: body.location } : { location: { geometry } }),
      ...(body.specifications && typeof body.specifications === 'object' ? { specifications: body.specifications } : {}),
      ...(body.properties && typeof body.properties === 'object' ? { properties: body.properties } : {}),
      ...(body.municipality !== undefined ? { municipality: String(body.municipality) } : {}),
      ...(body.owner !== undefined ? { owner: String(body.owner) } : {}),
      ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata } : {}),
      public_visible: body.public_visible === false ? false : true,
      source: 'synapsecity', sourceVersion: '1.0.0',
    };
    const created = await client.records.create(dataset.id, asset, { id: String(body.id || assetCode), publish: true });
    res.status(201).json(assetView(created));
  } catch (error) { next(error); }
});

app.get('/v1/assets/:id', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const asset = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!asset) return res.status(404).json({ error: 'asset_not_found' });
    res.json(assetView(asset));
  } catch (error) { next(error); }
});

async function patchAsset(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = privateInput(req);
    if (body.name !== undefined && !String(body.name).trim()) throw Object.assign(new Error('name_must_not_be_empty'), { status: 400 });
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return void res.status(404).json({ error: 'asset_not_found' });
    res.json(await updateAsset(req, String(existing.id), body));
  } catch (error) { next(error); }
}

app.patch('/v1/assets/:id', patchAsset);
app.put('/v1/assets/:id', patchAsset);

app.delete('/v1/assets/:id', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    // Tier-2 keeps an auditable record; deletion is a City-owned soft delete.
    // `public_visible:false` plus the decommissioned status keeps the asset out
    // of every public projection even if a reader ignores one signal.
    await updateAsset(req, String(existing.id), { deleted_at: new Date().toISOString(), status: 'decommissioned', lifecycle_status: 'decommissioned', public_visible: false });
    res.status(204).end();
  } catch (error) { next(error); }
});

app.post('/v1/assets/:id/photos', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const values: unknown[] = Array.isArray(body.photos)
      ? body.photos
      : (Array.isArray(body.file_ids) ? body.file_ids : (body.file_id ? [body.file_id] : (body.file_url ? [body.file_url] : [])));
    if (values.length === 0) return res.status(400).json({ error: 'photos_required' });
    if (values.length > 20) return res.status(413).json({ error: 'too_many_photos', max: 20 });
    const resolved = await resolvePhotos(req, values);
    const currentPhotos = Array.isArray(existing.photos) ? existing.photos.map(String) : [];
    const currentAttachments = Array.isArray(existing.attachments) ? existing.attachments as Record<string, unknown>[] : [];
    res.json(await updateAsset(req, String(existing.id), {
      photos: [...currentPhotos, ...resolved.map((entry) => entry.url)],
      attachments: [...currentAttachments, ...resolved.map((entry) => entry.attachment)],
    }));
  } catch (error) { next(error); }
});

app.post('/v1/assets/:id/attachments', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const attachment = await attachmentFromBody(req, body, 'attachment', 'document');
    const current = Array.isArray(existing.attachments) ? existing.attachments as Record<string, unknown>[] : [];
    res.status(201).json(await updateAsset(req, String(existing.id), { attachments: [...current, attachment] }));
  } catch (error) { next(error); }
});

app.delete('/v1/assets/:id/attachments/:url', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const target = decodeURIComponent(req.params.url);
    const current = Array.isArray(existing.attachments) ? existing.attachments as Record<string, unknown>[] : [];
    await updateAsset(req, String(existing.id), {
      attachments: current.filter((attachment) => String(attachment.file_url) !== target && String(attachment.file_name) !== target),
      photos: (Array.isArray(existing.photos) ? existing.photos as string[] : []).filter((url) => String(url) !== target),
    });
    // Delete the object when the reference is a City-managed file, so storage
    // does not retain an orphan after the operator removes the attachment.
    const fileId = fileIdFromReference(target);
    if (fileId && /\/v1\/(public\/)?files\//.test(target)) {
      await client.files.delete(fileId).catch((error) => {
        if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
      });
      const filesDataset = await fileDataset(client);
      await client.records.delete(filesDataset.id, fileId).catch((error) => {
        if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
      });
    }
    res.status(204).end();
  } catch (error) { next(error); }
});

app.get('/v1/assets/:id/documents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    res.json(Array.isArray(existing.attachments) ? existing.attachments : []);
  } catch (error) { next(error); }
});

app.post('/v1/assets/:id/documents', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const attachment = await attachmentFromBody(req, body, 'document', 'document');
    const current = Array.isArray(existing.attachments) ? existing.attachments as Record<string, unknown>[] : [];
    await updateAsset(req, String(existing.id), { attachments: [...current, attachment] });
    res.status(201).json(attachment);
  } catch (error) { next(error); }
});

const LIFECYCLE_TO_ASSET_STATUS: Record<string, string> = {
  operational: 'active',
  under_repair: 'maintenance',
  damaged: 'maintenance',
  decommissioned: 'decommissioned',
};

app.put('/v1/assets/:id/lifecycle-status', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const status = String(body.lifecycle_status || '');
    if (!LIFECYCLE_TO_ASSET_STATUS[status]) return res.status(400).json({ error: 'invalid_lifecycle_status' });
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const lifecycle = (existing.lifecycle && typeof existing.lifecycle === 'object' ? existing.lifecycle : {}) as Record<string, unknown>;
    res.json(await updateAsset(req, String(existing.id), {
      lifecycle: { ...lifecycle, lifecycle_status: status },
      lifecycle_stage: status,
      status: LIFECYCLE_TO_ASSET_STATUS[status],
    }));
  } catch (error) { next(error); }
});

function healthScore(asset: Record<string, unknown>, openIncidents: number): Record<string, unknown> {
  const conditionScores: Record<string, number> = { excellent: 95, good: 85, fair: 70, poor: 45, critical: 20 };
  const statusScores: Record<string, number> = { active: 100, operational: 100, maintenance: 60, under_repair: 60, damaged: 35, inactive: 25, decommissioned: 0 };
  const condition = conditionScores[String(asset.condition || '').toLowerCase()] ?? 75;
  const lifecycle = (asset.lifecycle && typeof asset.lifecycle === 'object' ? asset.lifecycle : {}) as Record<string, unknown>;
  const status = statusScores[String(lifecycle.lifecycle_status || asset.status || '').toLowerCase()] ?? 75;
  const lastMaintenance = Date.parse(String(lifecycle.last_maintenance_date || ''));
  const daysSinceMaintenance = Number.isFinite(lastMaintenance) ? Math.floor((Date.now() - lastMaintenance) / 86_400_000) : null;
  const maintenance = lifecycle.maintenance_overdue === true ? 30 : daysSinceMaintenance === null ? 75 : Math.max(20, 100 - Math.floor(daysSinceMaintenance / 30) * 5);
  const incidents = Math.max(0, 100 - Math.max(0, openIncidents) * 15);
  const commissioned = Date.parse(String(lifecycle.commissioned_date || ''));
  const designed = Number(lifecycle.designed_lifespan_years);
  let age = 75;
  if (Number.isFinite(commissioned) && Number.isFinite(designed) && designed > 0) {
    const years = (Date.now() - commissioned) / (365.25 * 86_400_000);
    age = Math.max(0, Math.round(100 - (years / designed) * 100));
  }
  const overall = Math.round(condition * 0.3 + status * 0.2 + maintenance * 0.25 + incidents * 0.15 + age * 0.1);
  const health_status = overall >= 80 ? 'excellent' : overall >= 60 ? 'good' : overall >= 40 ? 'fair' : 'poor';
  return {
    health_score: overall,
    health_status,
    breakdown: {
      condition_score: Math.round(condition),
      status_score: Math.round(status),
      maintenance_score: Math.round(maintenance),
      incident_score: Math.round(incidents),
      age_score: Math.round(age),
    },
  };
}

async function assetRiskResult(req: Request, assetId: string): Promise<ReturnType<typeof scoreAssetRisk> | null> {
  const c = capabilitiesFromRequest(req);
  const assetsDataset = await ensureDataset(c, DATASETS.assets);
  const assetRecord = await findRecord(c, assetsDataset.id, assetId, ['asset_code', 'feature_code', 'assetId', 'id']);
  if (!assetRecord) return null;
  const asset = assetView(assetRecord);
  const [incidentsDataset, maintenanceDataset, sensorsDataset, readingsDataset] = await Promise.all([
    ensureDataset(c, DATASETS.incidents), ensureDataset(c, DATASETS.maintenance),
    ensureDataset(c, DATASETS.sensors), ensureDataset(c, DATASETS.sensorData),
  ]);
  const [incidentRecords, maintenanceRecords, sensorRecords, readingRecords] = await Promise.all([
    listAllRecords(c, incidentsDataset.id), listAllRecords(c, maintenanceDataset.id),
    listAllRecords(c, sensorsDataset.id), listAllRecords(c, readingsDataset.id),
  ]);
  const key = String(assetRecord.id || assetId);
  const code = String(asset.asset_code || asset.feature_code || '');
  const incidents = incidentRecords.map((row) => recordData(row.data))
    .filter((row) => [row.asset_id, row.assetId, row.asset_code].some((value) => value && (String(value) === key || String(value) === code)));
  const maintenance = maintenanceRecords.map((row) => recordData(row.data))
    .filter((row) => [row.asset_id, row.assetId].some((value) => value && (String(value) === key || String(value) === code)));
  const sensorIds = new Set(sensorRecords.map((row) => recordData(row.data))
    .filter((row) => [row.asset_id, row.assetId].some((value) => value && (String(value) === key || String(value) === code)))
    .map((row) => String(row.id || row.sensor_id || '')));
  const sensors: RiskSensorReading[] = readingRecords.map((row) => recordData(row.data))
    .filter((row) => sensorIds.size === 0 || sensorIds.has(String(row.sensor_id || row.sensorId || '')))
    .map((row) => ({
      metric: row.metric ? String(row.metric) : undefined,
      value: row.value === undefined ? undefined : Number(row.value),
      unit: row.unit ? String(row.unit) : undefined,
      min: row.min === undefined ? undefined : Number(row.min),
      max: row.max === undefined ? undefined : Number(row.max),
      observed_at: row.observed_at ? String(row.observed_at) : row.timestamp ? String(row.timestamp) : undefined,
    }));
  return scoreAssetRisk({ asset: { ...asset, id: key }, incidents, maintenance, sensors });
}

app.put('/v1/assets/:id/criticality', async (req, res, next) => {
  try {
    const input = objectBody(req.body);
    const criticality = {
      service_impact: Math.max(1, Math.min(5, Number(input.service_impact ?? 3))),
      population_served: Math.max(0, Number(input.population_served ?? 0)),
      redundancy: Math.max(1, Math.min(5, Number(input.redundancy ?? 3))),
      safety_impact: Math.max(1, Math.min(5, Number(input.safety_impact ?? 3))),
    };
    const existing = await findRecord(capabilitiesFromRequest(req), (await ensureDataset(capabilitiesFromRequest(req), DATASETS.assets)).id, req.params.id, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const updated = await updateAsset(req, req.params.id, { criticality });
    res.json({ asset: updated, criticality });
  } catch (error) { next(error); }
});

app.get('/v1/assets/:id/risk', async (req, res, next) => {
  try {
    const result = await assetRiskResult(req, req.params.id);
    if (!result) return res.status(404).json({ error: 'asset_not_found' });
    res.json(result);
  } catch (error) { next(error); }
});

app.get('/v1/risk/top', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 100);
    const c = capabilitiesFromRequest(req);
    const assets = await listAllRecords(c, (await ensureDataset(c, DATASETS.assets)).id);
    const results = [] as ReturnType<typeof scoreAssetRisk>[];
    for (const asset of assets.slice(0, 500)) {
      const result = await assetRiskResult(req, String(asset.id));
      if (result) results.push(result);
    }
    res.json({ items: rankAssetsByRisk(results).slice(0, limit), total: results.length });
  } catch (error) { next(error); }
});

app.post('/v1/assets/:id/risk/work-order', async (req, res, next) => {
  try {
    const risk = await assetRiskResult(req, req.params.id);
    if (!risk) return res.status(404).json({ error: 'asset_not_found' });
    const input = objectBody(req.body);
    const approvalId = String(input.approval_id || input.approvalId || '');
    const actor = hitlActor(req);
    if (hitlRequired() && !approvalId) {
      const approval = await createApproval(req, {
        title: `Predictive maintenance for ${risk.asset_id}`,
        module: 'city.maintenance', action: 'maintenance.approve', entityType: 'asset', entityId: String(req.params.id),
        payload: { risk_score: risk.score, band: risk.band, confidence: risk.confidence, factors: risk.factors },
        requester: actor,
      });
      return res.status(202).json({ approval, hitl_required: true, risk });
    }
    if (approvalId) await assertApproved(req, approvalId, { entityId: String(req.params.id), action: 'maintenance.approve', actor });
    const workOrder = await genericWrite(req, 'maintenance', {
      title: String(input.title || `Predictive maintenance: ${risk.asset_id}`),
      asset_id: String(req.params.id), type: 'preventive', source: 'predictive-risk',
      priority: risk.band === 'critical' ? 'critical' : risk.band === 'high' ? 'high' : 'medium',
      status: approvalId ? 'scheduled' : 'recommended',
      risk_score: risk.score, risk_band: risk.band, risk_confidence: risk.confidence,
      risk_factors: risk.factors, risk_flags: risk.flags, data_freshness: risk.data_freshness,
      ...(approvalId ? { approval_id: approvalId, approved_by: actor } : {}),
      scheduled_date: String(input.scheduled_date || new Date(Date.now() + 7 * 86_400_000).toISOString()),
    });
    res.status(201).json({ work_order: workOrder, risk });
  } catch (error) { next(error); }
});

app.get('/v1/assets/:id/health-score', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const incidentDataset = await ensureDataset(client, DATASETS.incidents);
    const incidents = await client.records.list(incidentDataset.id, { limit: 500, offset: 0 });
    const assetId = String(existing.id || req.params.id);
    const open = incidents.items.map(recordData).filter((incident) =>
      String(incident.asset_id || incident.assetId || '') === assetId && !['resolved', 'closed'].includes(String(incident.status || ''))).length;
    res.json(healthScore(assetView(existing), open));
  } catch (error) { next(error); }
});

async function loadReportContext(req: Request, assetId?: string): Promise<{ context: Parameters<typeof generateReport>[2]; asset: Record<string, unknown> | null }> {
  const client = capabilitiesFromRequest(req);
  const assetsDataset = await ensureDataset(client, DATASETS.assets);
  const incidentsDataset = await ensureDataset(client, DATASETS.incidents);
  const maintenanceDataset = await ensureDataset(client, DATASETS.maintenance);
  const assets = (await listAllRecords(client, assetsDataset.id)).map((record) => assetView(record.data));
  const incidents = (await listAllRecords(client, incidentsDataset.id)).map((record) => incidentView(record.data));
  const maintenance = (await listAllRecords(client, maintenanceDataset.id)).map((record) => recordData(record.data));
  const asset = assetId ? assets.find((row) => String(row.id) === assetId || String(row.asset_code) === assetId) || null : null;
  return { context: { asset, assets, incidents, maintenance }, asset };
}

async function createReportRecord(req: Request, body: Record<string, unknown>, assetId?: string): Promise<Record<string, unknown>> {
  const reportType = normalizeReportType(body.report_type || body.type);
  const format = normalizeReportFormat(body.format);
  const filters = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)
    ? body.filters as Record<string, unknown>
    : {};
  if (assetId) filters.asset_id = assetId;
  const { context, asset } = await loadReportContext(req, assetId);
  if (assetId && !asset) throw Object.assign(new Error('asset_not_found'), { status: 404 });
  const artifact = generateReport(reportType, format, context, filters);
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.reports);
  const id = String(body.id || randomUUID());
  const record = {
    id,
    report_code: String(body.report_code || `RPT-${id.slice(0, 8).toUpperCase()}`),
    ...(asset ? { asset_id: String(asset.id), asset_code: asset.asset_code } : {}),
    report_type: reportType,
    type: reportType,
    format,
    filters,
    parameters: filters,
    status: 'completed',
    generated_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    content_type: artifact.contentType,
    content_sha256: artifact.sha256,
    row_count: artifact.rowCount,
    content: artifact.content,
    download_url: `${PUBLIC_URL}/v1/reports/${id}/download`,
    file_url: `${PUBLIC_URL}/v1/reports/${id}/download`,
    source: 'synapsecity',
  };
  const created = await client.records.create(dataset.id, record, { id, publish: false }).catch(async (error) => {
    if (error instanceof CapabilitiesError && (error.status === 400 || error.status === 409)) {
      return client.records.update(dataset.id, id, record);
    }
    throw error;
  });
  const createdRecord = recordData(created);
  const principal = sessionFromRequest(req);
  if (principal) {
    await pushNotification(req, {
      user_id: principal.sub,
      type: 'report_ready',
      title: `Report ${String(record.report_code)} is ready`,
      message: `${rowCountLabel(artifact.rowCount)} in ${format.toUpperCase()} format`,
      severity: 'info',
      link: '/admin/reports',
      entity_type: 'report',
      entity_id: id,
      dedupe_key: dedupeKey('report_ready', id, principal.sub),
    }).catch((error) => console.warn('[synapsecity] notification_write_failed', (error as Error).message));
  }
  return createdRecord;
}

function rowCountLabel(count: number): string {
  return `${count} row${count === 1 ? '' : 's'}`;
}

app.post('/v1/assets/:id/reports', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const assetDataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, assetDataset.id, req.params.id, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const report = await createReportRecord(req, body, String(existing.id));
    res.status(201).json({ report_id: report.id, report_url: report.download_url, row_count: report.row_count, format: report.format });
  } catch (error) { next(error); }
});

// Lightweight preventive-maintenance views stored on the asset record. The
// full work-order lifecycle lives in city-maintenance; these routes keep the
// retained asset tab from calling an unknown endpoint.
app.get('/v1/assets/:id/preventive-maintenance', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    res.json(existing.preventive_maintenance_plan || null);
  } catch (error) { next(error); }
});

app.get('/v1/assets/:id/preventive-maintenance/:view', async (req, res, next) => {
  try {
    const view = String(req.params.view).toLowerCase();
    if (!['tasks', 'upcoming', 'overdue'].includes(view)) return res.status(404).json({ error: 'preventive_view_not_found' });
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const plan = (existing.preventive_maintenance_plan || null) as PreventivePlan | null;
    const maintenanceDataset = await ensureDataset(client, DATASETS.maintenance);
    const assetIds = new Set([String(existing.id), String(existing.asset_code || '')].filter(Boolean));
    const workOrders = (await listAllRecords(client, maintenanceDataset.id))
      .map((record) => recordData(record.data))
      .filter((order) => assetIds.has(String(order.asset_id || order.assetId || '')));
    const tasks = filterPreventiveTasks(derivePreventiveTasks(plan, workOrders), view as 'tasks' | 'upcoming' | 'overdue');
    sendPage(res, tasks, req);
  } catch (error) { next(error); }
});

app.post('/v1/preventive-maintenance', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const assetId = String(body.asset_id || '');
    if (!assetId) return res.status(400).json({ error: 'asset_id_required' });
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, assetId, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const cycle = Number(body.cycle_days) || 180;
    const now = new Date();
    const plan = {
      id: randomUUID(),
      asset_id: String(existing.id),
      cycle_days: cycle,
      cycle_description: String(body.cycle_description || `Every ${cycle} days`),
      warning_days: Number(body.warning_days) || 7,
      responsible_team: String(body.responsible_team || ''),
      last_maintenance_date: existing.lifecycle && (existing.lifecycle as Record<string, unknown>).last_maintenance_date ? (existing.lifecycle as Record<string, unknown>).last_maintenance_date : now.toISOString(),
      next_maintenance_date: new Date(now.getTime() + cycle * 86_400_000).toISOString(),
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    await updateAsset(req, String(existing.id), { preventive_maintenance_plan: plan });
    res.status(201).json(plan);
  } catch (error) { next(error); }
});

app.put('/v1/preventive-maintenance/:planId', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const page = await client.records.list(dataset.id, { limit: 500, offset: 0 });
    const asset = page.items.map(assetView).find((row) => {
      const plan = row.preventive_maintenance_plan as Record<string, unknown> | undefined;
      return plan && String(plan.id) === req.params.planId;
    });
    if (!asset) return res.status(404).json({ error: 'preventive_plan_not_found' });
    const currentPlan = (asset.preventive_maintenance_plan || {}) as Record<string, unknown>;
    const plan = {
      ...currentPlan,
      ...body,
      id: req.params.planId,
      asset_id: asset.id,
      updated_at: new Date().toISOString(),
    };
    await updateAsset(req, String(asset.id), { preventive_maintenance_plan: plan });
    res.json(plan);
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

app.get('/v1/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const rows = (await listAllRecords(client, dataset.id)).map((record) => incidentView(record.data));
    const filters = queryFilters(req);
    const filtered = rows.filter((incident) => matchesFilters(incident, filters));
    sendPage(res, filtered, req);
  } catch (error) { next(error); }
});

app.post('/v1/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const body = privateInput(req);
    const incidentId = String(body.incidentId || randomUUID());
    const number = String(body.incident_number || body.incident_code || incidentNumber());
    const photoValues: unknown[] = Array.isArray(body.photos)
      ? body.photos
      : (Array.isArray(body.file_ids) ? body.file_ids : (body.file_id ? [body.file_id] : []));
    const photos = photoValues.length ? (await resolvePhotos(req, photoValues, { publicUrl: body.public_visible !== false })).map((entry) => entry.url) : [];
    const incident = {
      incidentId,
      incident_number: number,
      incident_code: number,
      title: requiredString(body, 'title'),
      description: String(body.description || ''),
      category: requiredString(body, 'category'),
      severity: String(body.severity || 'medium'),
      status: String(body.status || 'open'),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.asset_id !== undefined ? { asset_id: String(body.asset_id) } : {}),
      ...(body.assetId !== undefined && body.asset_id === undefined ? { asset_id: String(body.assetId) } : {}),
      ...(body.reported_by !== undefined ? { reported_by: String(body.reported_by) } : {}),
      ...(body.reporter_type !== undefined ? { reporter_type: String(body.reporter_type) } : {}),
      ...(body.contact_info !== undefined ? { contact_info: body.contact_info } : {}),
      ...(photos.length ? { photos } : {}),
      occurredAt: String(body.occurredAt || new Date().toISOString()),
      reported_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      upvotes: 0,
      comments: [],
      public_visible: body.public_visible === false ? false : true,
      source: 'synapsecity', sourceVersion: '1.0.0',
    };
    const published = toPublishedIncident(incident);
    const created = await client.records.create(dataset.id, published, { id: incidentId, publish: published.public_visible !== false });
    await writeIncidentInternal(req, incidentId, incident);
    res.status(201).json(incidentView(mergeIncidentInternal(recordData(created), toInternalIncident(incident))));
  } catch (error) { next(error); }
});

app.get('/v1/incidents/:id', async (req, res, next) => {
  try {
    const incident = await findIncident(req, req.params.id);
    if (!incident) return res.status(404).json({ error: 'incident_not_found' });
    res.json(incidentView(incident));
  } catch (error) { next(error); }
});

async function patchIncident(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const body = privateInput(req);
    const id = String(req.params.id);
    const existing = await findIncident(req, id);
    if (!existing) return void res.status(404).json({ error: 'incident_not_found' });
    res.json(await updateIncident(req, id, body));
  } catch (error) { next(error); }
}

app.patch('/v1/incidents/:id', patchIncident);
app.put('/v1/incidents/:id', patchIncident);

function sessionCommentAuthor(req: Request): { user_id?: string; user_name: string } {
  const principal = sessionFromRequest(req);
  return principal
    ? { user_id: principal.sub, user_name: principal.full_name || principal.username }
    : { user_name: 'anonymous' };
}

app.post('/v1/incidents/:id/acknowledge', async (req, res, next) => {
  try {
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    res.json(await updateIncident(req, req.params.id, { status: 'acknowledged', acknowledged_at: new Date().toISOString() }));
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/assign', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const assignedTo = String(body.assigned_to || req.query.assigned_to || '').trim();
    if (!assignedTo) return res.status(400).json({ error: 'assigned_to_required' });
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    const updated = await updateIncident(req, req.params.id, { assigned_to: assignedTo, status: 'assigned', assigned_at: new Date().toISOString() });
    await pushNotification(req, {
      user_id: assignedTo,
      type: 'incident_assigned',
      title: `Incident ${String(updated.incident_number || updated.id)} assigned to you`,
      message: String(updated.title || ''),
      severity: String(updated.severity || 'info') === 'critical' ? 'critical' : 'warning',
      link: `/admin/incidents/${String(updated.id)}`,
      entity_type: 'incident',
      entity_id: String(updated.id),
      dedupe_key: dedupeKey('incident_assigned', String(updated.id), assignedTo),
    }).catch((error) => console.warn('[synapsecity] notification_write_failed', (error as Error).message));
    res.json(updated);
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/resolve', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const notes = String(body.resolution_notes || req.query.resolution_notes || '');
    const type = String(body.resolution_type || req.query.resolution_type || 'fixed');
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    const updated = await updateIncident(req, req.params.id, { status: 'resolved', resolution_notes: notes, resolution_type: type, resolved_at: new Date().toISOString() });
    const assignee = String(updated.assigned_to || '').trim();
    if (assignee) {
      await pushNotification(req, {
        user_id: assignee,
        type: 'incident_resolved',
        title: `Incident ${String(updated.incident_number || updated.id)} resolved`,
        message: notes || String(updated.title || ''),
        severity: 'info',
        link: `/admin/incidents/${String(updated.id)}`,
        entity_type: 'incident',
        entity_id: String(updated.id),
        dedupe_key: dedupeKey('incident_resolved', String(updated.id), assignee),
      }).catch((error) => console.warn('[synapsecity] notification_write_failed', (error as Error).message));
    }
    res.json(updated);
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/comments', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const text = String(body.comment || '').trim();
    if (!text) return res.status(400).json({ error: 'comment_required' });
    const existing = await findIncident(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'incident_not_found' });
    const comments = Array.isArray(existing.comments) ? existing.comments as Record<string, unknown>[] : [];
    const comment = {
      id: randomUUID(),
      comment: text,
      ...sessionCommentAuthor(req),
      is_internal: body.is_internal === true,
      posted_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    };
    res.json(await updateIncident(req, req.params.id, { comments: [...comments, comment] }));
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/upvote', async (req, res, next) => {
  try {
    const existing = await findIncident(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'incident_not_found' });
    res.json(await updateIncident(req, req.params.id, { upvotes: (Number(existing.upvotes) || 0) + 1 }));
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/create-maintenance', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const existing = await findIncident(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'incident_not_found' });
    const technicianId = String(body.technician_id || req.query.technician_id || '');
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.maintenance);
    const maintenanceId = randomUUID();
    const maintenance = {
      id: maintenanceId,
      asset_id: existing.asset_id,
      incident_id: existing.id,
      title: `Incident ${existing.incident_number || existing.id}: ${existing.title || ''}`.trim(),
      description: existing.description || '',
      status: 'scheduled',
      priority: existing.severity || 'medium',
      type: 'corrective',
      ...(technicianId ? { assigned_to: technicianId, technician: technicianId } : {}),
      scheduled_date: new Date().toISOString(),
      created_at: new Date().toISOString(),
      source: 'synapsecity',
    };
    await client.records.create(dataset.id, maintenance, { id: maintenanceId, publish: false });
    await updateIncident(req, req.params.id, { maintenance_record_id: maintenanceId, status: 'in_progress' });
    res.status(201).json({ incident_id: existing.id, maintenance_id: maintenanceId, message: 'maintenance_created' });
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/close', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const notes = String(body.notes || req.query.notes || '');
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    res.json(await updateIncident(req, req.params.id, { status: 'closed', closed_at: new Date().toISOString(), ...(notes ? { resolution_notes: notes } : {}) }));
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/reject', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const reason = String(body.reason || req.query.reason || '');
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    res.json(await updateIncident(req, req.params.id, { status: 'closed', resolution_type: 'not_an_issue', resolution_notes: reason, resolved_at: new Date().toISOString() }));
  } catch (error) { next(error); }
});

app.get('/v1/hitl/approvals', async (req, res, next) => {
  try {
    const items = await listPendingApprovals(req, req.query.module ? String(req.query.module) : undefined);
    const now = Date.now();
    res.json({ items: items.map((item) => ({ ...item, escalated: !!item.dueAt && Date.parse(item.dueAt) < now })), total: items.length });
  } catch (error) { next(error); }
});

app.post('/v1/hitl/approvals/:id/decide', async (req, res, next) => {
  try {
    const input = objectBody(req.body);
    const decision = String(input.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'invalid_decision' });
    const approval = await decideApproval(req, req.params.id, decision as 'approve' | 'reject', input.note ? String(input.note) : undefined);
    res.json({ approval });
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/cost-approval', async (req, res, next) => {
  try {
    const incident = await findIncident(req, req.params.id);
    if (!incident) return res.status(404).json({ error: 'incident_not_found' });
    const actor = hitlActor(req);
    const approval = await createApproval(req, {
      title: `Incident cost approval: ${String(incident.title || incident.id || req.params.id)}`,
      module: 'city.incident', action: 'city.cost.approve',
      entityType: 'incident', entityId: String(req.params.id),
      payload: { cost: incident.cost ?? incident.estimated_cost ?? null, severity: incident.severity ?? null },
      requester: actor,
    });
    res.status(202).json({ approval, hitl_required: true });
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/approve-cost', async (req, res, next) => {
  try {
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    const input = objectBody(req.body);
    const approvalId = String(input.approval_id || input.approvalId || '');
    if (hitlRequired() || approvalId) {
      if (!approvalId) return res.status(428).json({ error: 'approval_required', message: 'create a cost approval first' });
      const actor = hitlActor(req);
      const approval = await assertApproved(req, approvalId, { entityId: String(req.params.id), action: 'city.cost.approve', actor });
      return res.json(await updateIncident(req, req.params.id, {
        cost_status: 'approved', cost_approved_at: new Date().toISOString(),
        cost_approval_id: approvalId, cost_approved_by: actor, cost_approval_roles: approval.approverRoles,
      }));
    }
    res.json(await updateIncident(req, req.params.id, { cost_status: 'approved', cost_approved_at: new Date().toISOString() }));
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/verify', async (req, res, next) => {
  try {
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    res.json(await updateIncident(req, req.params.id, {
      ai_verification_status: 'verified',
      ai_confidence_score: 1,
      ai_verification_reason: 'verified_by_city_operator',
      ai_verified_at: new Date().toISOString(),
    }));
  } catch (error) { next(error); }
});

// Duplicate detection is a City-owned workflow, but this deployment does not
// bundle an ML matcher. Returning an explicit empty result keeps the UI honest
// instead of inventing duplicate pairs.
app.post('/v1/incidents/:id/check-duplicates', async (req, res, next) => {
  try {
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    res.json([]);
  } catch (error) { next(error); }
});

app.get('/v1/incidents/:id/merge-suggestions', async (req, res, next) => {
  try {
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    res.json([]);
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/merge', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const duplicateIds = Array.isArray(body.duplicate_ids) ? body.duplicate_ids.map(String) : [];
    if (duplicateIds.length === 0) return res.status(400).json({ error: 'duplicate_ids_required' });
    const primary = await findIncident(req, req.params.id);
    if (!primary) return res.status(404).json({ error: 'incident_not_found' });
    for (const duplicateId of duplicateIds) {
      const duplicate = await findIncident(req, duplicateId);
      if (duplicate) {
        await updateIncident(req, duplicateId, {
          status: 'closed',
          resolution_type: 'duplicate',
          merged_into: primary.id,
          resolution_notes: String(body.merge_notes || `Merged into ${primary.incident_number || primary.id}`),
        });
      }
    }
    const merged = Array.isArray(primary.merged_reporter_ids) ? primary.merged_reporter_ids.map(String) : [];
    const updated = await updateIncident(req, req.params.id, { merged_reporter_ids: Array.from(new Set([...merged, ...duplicateIds])) });
    res.json(updated);
  } catch (error) { next(error); }
});

app.post('/v1/incidents/merge-suggestions/:suggestionId/approve', (_req, res) => {
  res.status(404).json({ error: 'merge_suggestion_not_found' });
});
app.post('/v1/incidents/merge-suggestions/:suggestionId/reject', (_req, res) => {
  res.status(404).json({ error: 'merge_suggestion_not_found' });
});

app.get('/v1/incidents/:id/related', async (req, res, next) => {
  try {
    const existing = await findIncident(req, req.params.id);
    if (!existing) return res.status(404).json({ error: 'incident_not_found' });
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const page = await client.records.list(dataset.id, { limit: 500, offset: 0 });
    const assetId = String(existing.asset_id || existing.assetId || '');
    const related = page.items
      .map(incidentView)
      .filter((incident) => String(incident.id) !== String(existing.id))
      .filter((incident) => (assetId && String(incident.asset_id || '') === assetId) || (Array.isArray(existing.merged_reporter_ids) && (existing.merged_reporter_ids as string[]).includes(String(incident.id))))
      .slice(0, 20);
    res.json(related);
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Generic Tier-2 record adapters for the remaining City modules
// ---------------------------------------------------------------------------
// SynapseCity owns the route and validation vocabulary while SynapseDX owns
// persistence, publication and queueing.

type GenericKey = keyof typeof DATASETS;
function genericSpec(key: GenericKey) { return DATASETS[key]; }
function genericBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
}
async function genericList(req: Request, key: GenericKey): Promise<Record<string, unknown>[]> {
  const c = capabilitiesFromRequest(req);
  const spec = genericSpec(key);
  const rows = (await listAllRecords(c, (await ensureDataset(c, spec)).id)).map((record) => recordData(record.data));
  const filters = queryFilters(req);
  return rows.filter((row) => matchesFilters(row, filters));
}
async function genericGet(req: Request, key: GenericKey, id: string): Promise<Record<string, unknown>> {
  const c = capabilitiesFromRequest(req);
  return recordData(await c.records.get((await ensureDataset(c, genericSpec(key))).id, id));
}
async function genericWrite(req: Request, key: GenericKey, input: Record<string, unknown>, id?: string): Promise<Record<string, unknown>> {
  const c = capabilitiesFromRequest(req);
  const spec = genericSpec(key);
  const dataset = await ensureDataset(c, spec);
  const recordId = id || String(input.id || randomUUID());
  const data = sanitizeUser({ ...input, id: recordId, created_at: input.created_at || new Date().toISOString(), updated_at: new Date().toISOString() });
  try {
    return recordData(await c.records.create(dataset.id, data, { id: recordId, publish: spec.public === true }));
  } catch (error) {
    if (error instanceof CapabilitiesError && (error.status === 400 || error.status === 409)) return recordData(await c.records.update(dataset.id, recordId, data));
    throw error;
  }
}
async function genericUpdate(req: Request, key: GenericKey, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = sanitizeUser(await genericGet(req, key, id));
  const c = capabilitiesFromRequest(req);
  return recordData(await c.records.update((await ensureDataset(c, genericSpec(key))).id, id, sanitizeUser({ ...current, ...patch, id, updated_at: new Date().toISOString() })));
}

interface GenericOptions {
  view?: (record: Record<string, unknown>) => Record<string, unknown>;
  reserved?: readonly string[];
  /** Restrict which rows a role may list (for example technician assignments). */
  scope?: (req: Request, rows: Record<string, unknown>[]) => Record<string, unknown>[];
  /** Restrict single-record reads; a denied row is reported as not found. */
  rowAllowed?: (req: Request, row: Record<string, unknown>) => boolean;
}

function installGenericCrud(prefix: string, key: GenericKey, options: GenericOptions = {}): void {
  const view = options.view || ((record: Record<string, unknown>) => record);
  const reserved = new Set((options.reserved || []).map((value) => value.toLowerCase()));
  const isReserved = (id: string) => reserved.has(String(id).toLowerCase());
  app.get(prefix, async (req, res, next) => {
    try {
      const rows = await genericList(req, key);
      const scoped = options.scope ? options.scope(req, rows) : rows;
      sendPage(res, scoped.map(view), req);
    } catch (error) { next(error); }
  });
  app.get(`${prefix}/:id`, async (req, res, next) => {
    if (isReserved(req.params.id)) return next();
    try {
      const row = await genericGet(req, key, req.params.id);
      if (options.rowAllowed && !options.rowAllowed(req, row)) return res.status(404).json({ error: 'not_found', product: PRODUCT });
      res.json(view(row));
    } catch (error) { next(error); }
  });
  app.post(prefix, async (req, res, next) => { try { res.status(201).json(view(await genericWrite(req, key, genericBody(req)))); } catch (error) { next(error); } });
  app.put(`${prefix}/:id`, async (req, res, next) => {
    if (isReserved(req.params.id)) return next();
    try { res.json(view(await genericUpdate(req, key, req.params.id, genericBody(req)))); } catch (error) { next(error); }
  });
}

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

/**
 * A technician only sees their own work orders. Admin/manager see everything.
 * Identity comes from the signed session, never from a query parameter.
 */
function maintenanceScope(req: Request, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const principal = (req as AuthedRequest).session || sessionFromRequest(req);
  if (!principal || principal.role === 'admin' || principal.role === 'manager' || principal.role === 'volunteer') return rows;
  const identities = new Set([principal.sub, principal.username].map((value) => String(value).toLowerCase()));
  const requested = String(req.query.assigned_to || '').toLowerCase();
  return rows.filter((row) => {
    const assigned = String(row.assigned_to || row.technician || row.assigned_to_user_id || '').toLowerCase();
    if (!identities.has(assigned)) return false;
    return !requested || assigned === requested;
  });
}

function maintenanceRowAllowed(req: Request, row: Record<string, unknown>): boolean {
  const principal = (req as AuthedRequest).session || sessionFromRequest(req);
  if (!principal || principal.role === 'admin' || principal.role === 'manager' || principal.role === 'volunteer') return true;
  const identities = new Set([principal.sub, principal.username].map((value) => String(value).toLowerCase()));
  return identities.has(String(row.assigned_to || row.technician || '').toLowerCase());
}

// Specific routes are registered before the generic :id route, and the generic
// route also skips the reserved names. This prevents /upcoming and /asset/...
// from being parsed as a work-order id.
app.get('/v1/maintenance/upcoming', async (req, res, next) => {
  try {
    const days = numberParam(req.query.days, 7, 30);
    const horizon = Date.now() + days * 86_400_000;
    const scope = maintenanceScope(req, await genericList(req, 'maintenance'));
    const rows = scope.filter((row) => {
      const status = String(row.status || '').toLowerCase();
      if (['completed', 'cancelled', 'closed'].includes(status)) return false;
      const scheduled = Date.parse(String(row.scheduled_date || row.scheduledDate || ''));
      return !Number.isFinite(scheduled) || scheduled <= horizon;
    });
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});
app.get('/v1/maintenance/asset/:assetId', async (req, res, next) => {
  try {
    const rows = maintenanceScope(req, await genericList(req, 'maintenance'))
      .filter((row) => String(row.asset_id || row.assetId || '') === req.params.assetId);
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});
app.post('/v1/maintenance/:id/approval', async (req, res, next) => {
  try {
    const workOrder = await genericGet(req, 'maintenance', req.params.id);
    const actor = hitlActor(req);
    const approval = await createApproval(req, {
      title: `Maintenance approval: ${String(workOrder.title || workOrder.id || req.params.id)}`,
      module: 'city.maintenance', action: 'maintenance.approve',
      entityType: 'maintenance', entityId: String(req.params.id),
      payload: { priority: workOrder.priority ?? null, cost: workOrder.cost ?? null, asset_id: workOrder.asset_id ?? null },
      requester: actor,
    });
    res.status(202).json({ approval, hitl_required: true });
  } catch (error) { next(error); }
});

installGenericCrud('/v1/maintenance', 'maintenance', { reserved: ['upcoming', 'asset'], scope: maintenanceScope, rowAllowed: maintenanceRowAllowed });
for (const action of ['assign', 'start', 'complete', 'cancel', 'approve', 'reject']) {
  app.post(`/v1/maintenance/:id/${action}`, async (req, res, next) => {
    try {
      const body = Object.keys(genericBody(req)).length > 0 ? genericBody(req) : Object.fromEntries(Object.entries(req.query).map(([key, value]) => [key, String(value)]));
      if (action === 'approve' || action === 'reject') {
        const approvalId = String(body.approval_id || body.approvalId || '');
        if (hitlRequired() || approvalId) {
          if (!approvalId) return res.status(428).json({ error: 'approval_required', message: 'create a maintenance approval first' });
          const actor = hitlActor(req);
          const approval = await assertApproved(req, approvalId, { entityId: String(req.params.id), action: 'maintenance.approve', actor });
          body.approval_id = approvalId;
          body.approved_by = actor;
          body.approval_roles = approval.approverRoles;
        }
      }
      const updated = await genericUpdate(req, 'maintenance', req.params.id, {
        ...body,
        ...(action === 'start' ? { status: 'in_progress' } : {}),
        ...(action === 'complete' ? { status: 'completed', completed_at: new Date().toISOString() } : {}),
        ...(action === 'cancel' ? { status: 'cancelled' } : {}),
        ...(action === 'approve' ? { approval_status: 'approved' } : {}),
        ...(action === 'reject' ? { approval_status: 'rejected' } : {}),
      });
      if (action === 'assign') {
        const assignee = String(updated.assigned_to || updated.technician || '').trim();
        if (assignee) {
          await pushNotification(req, {
            user_id: assignee,
            type: 'maintenance_assigned',
            title: `Work order ${String(updated.id)} assigned to you`,
            message: String(updated.title || ''),
            severity: String(updated.priority || '') === 'high' ? 'warning' : 'info',
            link: `/technician/maintenance/${String(updated.id)}`,
            entity_type: 'maintenance',
            entity_id: String(updated.id),
            dedupe_key: dedupeKey('maintenance_assigned', String(updated.id), assignee),
          }).catch((error) => console.warn('[synapsecity] notification_write_failed', (error as Error).message));
        }
      }
      if (action === 'complete') {
        const assignee = String(updated.assigned_to || updated.technician || '').trim();
        if (assignee) {
          await pushNotification(req, {
            user_id: assignee,
            type: 'maintenance_completed',
            title: `Work order ${String(updated.id)} completed`,
            message: String(updated.title || ''),
            severity: 'info',
            link: `/technician/maintenance/${String(updated.id)}`,
            entity_type: 'maintenance',
            entity_id: String(updated.id),
            dedupe_key: dedupeKey('maintenance_completed', String(updated.id), assignee),
          }).catch((error) => console.warn('[synapsecity] notification_write_failed', (error as Error).message));
        }
      }
      res.json(updated);
    } catch (error) { next(error); }
  });
}
app.post('/v1/maintenance/:id/photos', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const current = await genericGet(req, 'maintenance', req.params.id);
    const attachments = Array.isArray(current.attachments) ? current.attachments as Record<string, unknown>[] : [];
    const values: unknown[] = Array.isArray(body.attachments)
      ? body.attachments
      : (Array.isArray(body.photos) ? body.photos : (body.file_id ? [body.file_id] : []));
    const photos: Record<string, unknown>[] = [];
    for (const [index, value] of values.entries()) {
      const entry = typeof value === 'string' ? { file_url: value } : (value as Record<string, unknown>);
      photos.push(await attachmentFromBody(req, entry, `photo-${index + 1}`, 'photo'));
    }
    if (photos.length === 0) return res.status(400).json({ error: 'photos_required' });
    res.json(await genericUpdate(req, 'maintenance', req.params.id, { attachments: [...attachments, ...photos] }));
  } catch (error) { next(error); }
});

// IoT metadata and readings share two Tier-2 datasets.
function readingValue(reading: Record<string, unknown>, metric?: string): number | null {
  if (metric) {
    const readings = reading.readings && typeof reading.readings === 'object' ? reading.readings as Record<string, unknown> : {};
    const measurements = reading.measurements && typeof reading.measurements === 'object' ? reading.measurements as Record<string, unknown> : {};
    const candidate = Number(reading[metric] ?? readings[metric] ?? measurements[metric]);
    return Number.isFinite(candidate) ? candidate : null;
  }
  for (const key of ['value', 'reading', 'measurement']) {
    const candidate = Number(reading[key]);
    if (reading[key] !== undefined && Number.isFinite(candidate)) return candidate;
  }
  const readings = reading.readings && typeof reading.readings === 'object' ? reading.readings as Record<string, unknown> : {};
  for (const value of Object.values(readings)) {
    const candidate = Number(value);
    if (Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function readingWhere(sensorId: string, hours?: number): Record<string, unknown> {
  return {
    sensor_id: sensorId,
    ...(hours ? { timestamp: { gte: new Date(Date.now() - hours * 3_600_000).toISOString() } } : {}),
  };
}

function sensorStatus(sensor: Record<string, unknown>, latestReading?: Record<string, unknown>): string {
  const declared = String(sensor.status || '').toLowerCase();
  if (['inactive', 'decommissioned', 'maintenance'].includes(declared)) return declared;
  const lastSeen = Date.parse(String(latestReading?.timestamp || sensor.last_seen || sensor.lastSeen || ''));
  if (!Number.isFinite(lastSeen)) return 'unknown';
  const offlineAfterMs = Math.max(1, Number(process.env.IOT_OFFLINE_THRESHOLD_MINUTES || 15)) * 60_000;
  return Date.now() - lastSeen <= offlineAfterMs ? 'online' : 'offline';
}

installGenericCrud('/v1/iot/sensors', 'sensors');
app.delete('/v1/iot/sensors/:id', async (req, res, next) => { try { await genericUpdate(req, 'sensors', req.params.id, { status: 'inactive', deleted_at: new Date().toISOString() }); res.status(204).end(); } catch (error) { next(error); } });

app.get('/v1/iot/sensors/:id/data', async (req, res, next) => {
  try {
    const hours = req.query.hours !== undefined ? numberParam(req.query.hours, 24, 24 * 365) : undefined;
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.sensorData);
    const page = await queryRecords(client, dataset.id, readingWhere(req.params.id, hours), {
      limit: numberParam(req.query.limit, 100, 500),
      offset: numberParam(req.query.offset ?? req.query.skip, 0, 1_000_000),
      orderBy: { field: 'timestamp', direction: 'desc' },
    });
    res.setHeader('x-total-count', String(page.total));
    res.json(page.items);
  } catch (error) { next(error); }
});
// Console alias: the chart client requests /readings.
app.get('/v1/iot/sensors/:id/readings', async (req, res, next) => {
  try {
    const hours = req.query.hours !== undefined ? numberParam(req.query.hours, 24, 24 * 365) : undefined;
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.sensorData);
    const page = await queryRecords(client, dataset.id, readingWhere(req.params.id, hours), {
      limit: numberParam(req.query.limit, 100, 500),
      offset: numberParam(req.query.offset ?? req.query.skip, 0, 1_000_000),
      orderBy: { field: 'timestamp', direction: 'desc' },
    });
    res.setHeader('x-total-count', String(page.total));
    res.json({ readings: page.items, total: page.total, sensor_id: req.params.id });
  } catch (error) { next(error); }
});
app.post('/v1/iot/sensors/:id/data', async (req, res, next) => { try { res.status(201).json(await genericWrite(req, 'sensorData', { ...genericBody(req), sensor_id: req.params.id })); } catch (error) { next(error); } });
app.post('/v1/iot/sensors/batch-ingest', async (req, res, next) => { try { const values: Record<string, unknown>[] = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.readings) ? req.body.readings : []); res.status(201).json(await Promise.all(values.map((row) => genericWrite(req, 'sensorData', row)))); } catch (error) { next(error); } });
app.get('/v1/iot/sensors/:id/status', async (req, res, next) => {
  try {
    const sensor = await genericGet(req, 'sensors', req.params.id);
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.sensorData);
    const page = await queryRecords(client, dataset.id, { sensor_id: req.params.id }, {
      limit: 1,
      orderBy: { field: 'timestamp', direction: 'desc' },
    });
    res.json({ ...sensor, status: sensorStatus(sensor, page.items[0]), last_reading_at: page.items[0]?.timestamp || null });
  } catch (error) { next(error); }
});
app.get('/v1/iot/sensors/:id/statistics', async (req, res, next) => {
  try {
    const sensor = await genericGet(req, 'sensors', req.params.id);
    const metric = req.query.metric ? String(req.query.metric) : undefined;
    const hours = req.query.hours !== undefined ? numberParam(req.query.hours, 24, 24 * 365) : undefined;
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.sensorData);
    const readings = await queryAllRecords(client, dataset.id, readingWhere(req.params.id, hours), {
      maxRecords: 5000,
      orderBy: { field: 'timestamp', direction: 'desc' },
    });
    const values = readings.map((reading) => readingValue(reading, metric)).filter((value): value is number => value !== null);
    const sum = values.reduce((total, value) => total + value, 0);
    res.json({
      sensor_id: req.params.id,
      metric: metric || 'value',
      count: values.length,
      min: values.length ? Math.min(...values) : null,
      max: values.length ? Math.max(...values) : null,
      average: values.length ? Math.round((sum / values.length) * 1000) / 1000 : null,
      latest: readings[0] ? { timestamp: readings[0].timestamp || readings[0].created_at || null, value: readingValue(readings[0], metric) } : null,
      unit: String(sensor.measurement_unit || sensor.unit || ''),
      window_hours: hours ?? null,
    });
  } catch (error) { next(error); }
});
app.get('/v1/iot/assets/:assetId/iot-data', async (req, res, next) => {
  try {
    const assetId = req.params.assetId;
    const hours = numberParam(req.query.hours, 24, 24 * 365);
    const client = capabilitiesFromRequest(req);
    const sensorsDataset = await ensureDataset(client, DATASETS.sensors);
    const readingsDataset = await ensureDataset(client, DATASETS.sensorData);
    const alertsDataset = await ensureDataset(client, DATASETS.alerts);
    const sensors = (await queryRecords(client, sensorsDataset.id, { asset_id: assetId }, { limit: 500 })).items;
    const sensorIds = sensors.map((sensor) => String(sensor.id));
    let readings: Array<Record<string, unknown>> = [];
    let totalReadings = 0;
    if (sensorIds.length > 0) {
      const page = await queryRecords(client, readingsDataset.id, {
        sensor_id: { in: sensorIds },
        timestamp: { gte: new Date(Date.now() - hours * 3_600_000).toISOString() },
      }, {
        limit: 500,
        orderBy: { field: 'timestamp', direction: 'desc' },
      });
      readings = page.items;
      totalReadings = page.total;
    }
    const activeAlerts = (await queryRecords(client, alertsDataset.id, { asset_id: assetId }, { limit: 500 })).items
      .filter((alert) => !['resolved', 'dismissed', 'closed'].includes(String(alert.status || '').toLowerCase()));
    res.json({
      asset_id: assetId,
      asset: { id: assetId, feature_type: String(sensors[0]?.feature_type || 'infrastructure'), feature_code: String(sensors[0]?.feature_code || assetId) },
      sensors: sensors.map((sensor) => ({ ...sensor, status: sensorStatus(sensor, readings.find((reading) => String(reading.sensor_id) === String(sensor.id))) })),
      readings,
      alerts: activeAlerts,
      summary: {
        total_sensors: sensors.length,
        total_readings: totalReadings,
        active_alerts: activeAlerts.length,
        offline_sensors: sensors.filter((sensor) => sensorStatus(sensor, readings.find((reading) => String(reading.sensor_id) === String(sensor.id))) === 'offline').length,
      },
      window_hours: hours,
    });
  } catch (error) { next(error); }
});

async function notifyOperators(req: Request, type: NotificationType, title: string, message: string, severity: 'info' | 'warning' | 'critical', entityType: string, entityId: string): Promise<void> {
  try {
    const users = (await genericList(req, 'users')).filter((user) => ['admin', 'manager'].includes(String(user.role || '')));
    for (const user of users) {
      const userId = String(user.id || user.username || '');
      if (!userId) continue;
      await pushNotification(req, {
        user_id: userId,
        type,
        title,
        message,
        severity,
        link: `/admin/alerts/${entityId}`,
        entity_type: entityType,
        entity_id: entityId,
        dedupe_key: dedupeKey(type, entityId, userId),
      });
    }
  } catch (error) {
    console.warn('[synapsecity] operator_notification_failed', (error as Error).message);
  }
}

// Register the alert producer before the generic CRUD so a raised critical alert
// notifies the on-call operators.
app.post('/v1/alerts', async (req, res, next) => {
  try {
    const created = await genericWrite(req, 'alerts', genericBody(req));
    const severity = String(created.severity || '').toLowerCase();
    if (['critical', 'high'].includes(severity)) {
      await notifyOperators(req, 'alert_raised', `Alert: ${String(created.title || created.id)}`, String(created.description || ''), severity === 'critical' ? 'critical' : 'warning', 'alert', String(created.id));
    }
    res.status(201).json(created);
  } catch (error) { next(error); }
});

installGenericCrud('/v1/alerts', 'alerts');

app.post('/v1/alerts/:id/acknowledge', async (req, res, next) => {
  try {
    const body = genericBody(req);
    const current = await genericGet(req, 'alerts', req.params.id);
    let updated = await genericUpdate(req, 'alerts', req.params.id, {
      ...body,
      status: 'acknowledged',
      acknowledged_at: new Date().toISOString(),
    });
    const alert = { ...current, ...updated } as AlertForAutomation;
    if (shouldCreateMaintenance(alert)) {
      const client = capabilitiesFromRequest(req);
      const maintenanceDataset = await ensureDataset(client, DATASETS.maintenance);
      const existing = (await listAllRecords(client, maintenanceDataset.id))
        .find((record) => String(record.data.source_alert_id || '') === String(alert.id));
      let maintenanceId = existing ? String(existing.id) : '';
      if (!existing) {
        // Deterministic id + source_alert_id lookup makes retries idempotent.
        maintenanceId = `alert-${String(alert.id)}`;
        try {
          await client.records.create(maintenanceDataset.id, maintenanceFromAlert(alert), { id: maintenanceId, publish: false });
        } catch (error) {
          if (!(error instanceof CapabilitiesError) || (error.status !== 409 && error.status !== 400)) throw error;
        }
      }
      updated = await genericUpdate(req, 'alerts', req.params.id, {
        maintenance_id: maintenanceId,
        maintenance_created_at: new Date().toISOString(),
      });
    }
    res.json(updated);
  } catch (error) { next(error); }
});

for (const action of ['resolve', 'dismiss']) {
  app.post(`/v1/alerts/:id/${action}`, async (req, res, next) => {
    try {
      res.json(await genericUpdate(req, 'alerts', req.params.id, {
        ...genericBody(req),
        status: action === 'resolve' ? 'resolved' : 'dismissed',
        [`${action}d_at`]: new Date().toISOString(),
      }));
    } catch (error) { next(error); }
  });
}

installGenericCrud('/v1/budgets', 'budgets');
for (const action of ['submit', 'approve']) app.post(`/v1/budgets/:id/${action}`, async (req, res, next) => { try { res.json(await genericUpdate(req, 'budgets', req.params.id, { status: action === 'submit' ? 'submitted' : 'approved' })); } catch (error) { next(error); } });
app.get('/v1/budgets/:id/transactions', async (req, res, next) => { try { res.json((await genericList(req, 'transactions')).filter((row) => String(row.budget_id || '') === req.params.id)); } catch (error) { next(error); } });
app.post('/v1/budgets/:id/transactions', async (req, res, next) => { try { res.status(201).json(await genericWrite(req, 'transactions', { ...genericBody(req), budget_id: req.params.id })); } catch (error) { next(error); } });
app.post('/v1/budgets/transactions/:id/approval', async (req, res, next) => {
  try {
    const transaction = await genericGet(req, 'transactions', req.params.id);
    const actor = hitlActor(req);
    const approval = await createApproval(req, {
      title: `Budget transaction approval: ${String(transaction.description || transaction.id || req.params.id)}`,
      module: 'city.budget', action: 'budget.transaction.approve',
      entityType: 'budget_transaction', entityId: String(req.params.id),
      payload: { amount: transaction.amount ?? null, budget_id: transaction.budget_id ?? null },
      requester: actor,
    });
    res.status(202).json({ approval, hitl_required: true });
  } catch (error) { next(error); }
});
app.post('/v1/budgets/transactions/:id/approve', async (req, res, next) => {
  try {
    const input = objectBody(req.body);
    const approvalId = String(input.approval_id || input.approvalId || '');
    if (hitlRequired() || approvalId) {
      if (!approvalId) return res.status(428).json({ error: 'approval_required', message: 'create a transaction approval first' });
      const actor = hitlActor(req);
      const approval = await assertApproved(req, approvalId, { entityId: String(req.params.id), action: 'budget.transaction.approve', actor });
      return res.json(await genericUpdate(req, 'transactions', req.params.id, {
        status: 'approved', approved_at: new Date().toISOString(), approval_id: approvalId,
        approved_by: actor, approval_roles: approval.approverRoles,
      }));
    }
    res.json(await genericUpdate(req, 'transactions', req.params.id, { status: 'approved' }));
  } catch (error) { next(error); }
});

// Reports are City-owned artifacts: creation/generation stores real CSV/JSON
// bytes on the report record and download streams those bytes.
app.post('/v1/reports', async (req, res, next) => {
  try { res.status(201).json(await createReportRecord(req, genericBody(req))); } catch (error) { next(error); }
});
app.post('/v1/reports/:id/generate', async (req, res, next) => {
  try {
    const current = await genericGet(req, 'reports', req.params.id);
    const report = await createReportRecord(req, {
      report_type: current.report_type,
      format: current.format,
      filters: current.filters,
      id: req.params.id,
      report_code: current.report_code,
      asset_id: current.asset_id,
    });
    res.json(report);
  } catch (error) { next(error); }
});
app.get('/v1/reports/:id/download', async (req, res, next) => {
  try {
    const report = await genericGet(req, 'reports', req.params.id);
    if (report.status !== 'completed' || !report.content) {
      return res.status(409).json({ error: 'report_not_generated', detail: 'POST /v1/reports/:id/generate first.' });
    }
    const format = String(report.format || 'csv') === 'json' ? 'json' : 'csv';
    const filename = `${String(report.report_code || report.id)}.${format}`;
    res.setHeader('content-type', String(report.content_type || (format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8')));
    res.setHeader('content-disposition', `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
    res.setHeader('x-content-sha256', String(report.content_sha256 || ''));
    res.setHeader('x-report-row-count', String(report.row_count ?? ''));
    res.send(Buffer.from(String(report.content), 'utf8'));
  } catch (error) { next(error); }
});
function reportView(record: Record<string, unknown>): Record<string, unknown> {
  const { content: _content, ...rest } = record;
  return rest;
}
installGenericCrud('/v1/reports', 'reports', { view: reportView });

function notificationOwner(req: Request): SessionPrincipal | undefined {
  return (req as AuthedRequest).session || sessionFromRequest(req) || undefined;
}

function notificationIdentities(principal: SessionPrincipal): Set<string> {
  return new Set([String(principal.sub || '').toLowerCase(), String(principal.username || '').toLowerCase()]);
}

function isOwnNotification(row: Record<string, unknown>, principal: SessionPrincipal): boolean {
  return notificationIdentities(principal).has(String(row.user_id || '').toLowerCase());
}

app.get('/v1/notifications', async (req, res, next) => {
  try {
    const principal = notificationOwner(req) as SessionPrincipal;
    const all = req.query.all === 'true' && principal.role === 'admin';
    const rows = (await genericList(req, 'notifications'))
      .filter((row) => all || isOwnNotification(row, principal))
      .filter((row) => req.query.unread_only !== 'true' || (!row.read && !row.read_at))
      .sort((a, b) => Date.parse(String(b.created_at || '')) - Date.parse(String(a.created_at || '')));
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});
app.get('/v1/notifications/unread-count', async (req, res, next) => {
  try {
    const principal = notificationOwner(req) as SessionPrincipal;
    const all = req.query.all === 'true' && principal.role === 'admin';
    const rows = (await genericList(req, 'notifications')).filter((row) => all || isOwnNotification(row, principal));
    res.json({ unread_count: rows.filter((row) => !row.read && !row.read_at).length });
  } catch (error) { next(error); }
});
app.get('/v1/notifications/capabilities', (_req, res) => res.json(notificationCapabilityStatus(externalDeliveryEnabled())));
app.get('/v1/notifications/preferences', async (req, res, next) => {
  try {
    const principal = notificationOwner(req) as SessionPrincipal;
    const recipient = preferenceRecipient(principal.sub);
    const preference = await capabilitiesFromRequest(req).notifications.getPreference(recipient);
    res.json({ ...preference, recipient });
  } catch (error) { next(error); }
});
app.put('/v1/notifications/preferences', async (req, res, next) => {
  try {
    const principal = notificationOwner(req) as SessionPrincipal;
    const recipient = preferenceRecipient(principal.sub);
    const body = genericBody(req);
    const channels = Array.isArray(body.channels)
      ? body.channels.map(String).filter((channel) => ['email', 'sms', 'push', 'webhook', 'log'].includes(channel))
      : undefined;
    const preference = await capabilitiesFromRequest(req).notifications.setPreference(recipient, {
      ...(channels ? { channels: channels as NotificationChannel[] } : {}),
      ...(body.unsubscribed !== undefined ? { unsubscribed: Boolean(body.unsubscribed) } : {}),
    });
    res.json({ ...preference, recipient });
  } catch (error) { next(error); }
});
app.post('/v1/notifications', async (req, res, next) => {
  try {
    const body = genericBody(req);
    const created = await pushNotification(req, {
      user_id: String(body.user_id || ''),
      type: String(body.type || 'system') as NotificationType,
      title: String(body.title || ''),
      message: String(body.message || ''),
      severity: (['info', 'warning', 'critical'].includes(String(body.severity)) ? String(body.severity) : 'info') as 'info' | 'warning' | 'critical',
      ...(body.link ? { link: String(body.link) } : {}),
      ...(body.entity_type ? { entity_type: String(body.entity_type) } : {}),
      ...(body.entity_id ? { entity_id: String(body.entity_id) } : {}),
      ...(body.dedupe_key ? { dedupe_key: String(body.dedupe_key) } : {}),
    });
    if (!created) return res.status(409).json({ error: 'notification_duplicate', detail: 'A notification with this dedupe_key already exists.' });
    res.status(201).json(created);
  } catch (error) { next(error); }
});
app.get('/v1/notifications/:id/delivery', async (req, res, next) => {
  try {
    const principal = notificationOwner(req) as SessionPrincipal;
    const current = await genericGet(req, 'notifications', req.params.id);
    if (!isOwnNotification(current, principal) && principal.role !== 'admin') {
      return res.status(404).json({ error: 'notification_not_found' });
    }
    const stored = (current.delivery && typeof current.delivery === 'object' ? current.delivery : {}) as Record<string, DeliveryReceipt>;
    const client = capabilitiesFromRequest(req);
    const channels: Record<string, unknown> = { ...stored };
    for (const [channel, receipt] of Object.entries(stored)) {
      if (!receipt?.notification_id) continue;
      try {
        const status = await client.notifications.get(receipt.notification_id);
        channels[channel] = {
          ...receipt,
          status: status.status,
          attempts: status.attempts,
          ...(status.error ? { error: status.error } : {}),
          ...(status.deadReason ? { dead_reason: status.deadReason } : {}),
        };
      } catch (error) {
        if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
      }
    }
    res.json({ notification_id: String(current.id), delivery: channels });
  } catch (error) { next(error); }
});
app.post('/v1/notifications/:id/read', async (req, res, next) => {
  try {
    const principal = notificationOwner(req) as SessionPrincipal;
    const current = await genericGet(req, 'notifications', req.params.id);
    if (!isOwnNotification(current, principal) && principal.role !== 'admin') {
      return res.status(404).json({ error: 'notification_not_found' });
    }
    res.json(await genericUpdate(req, 'notifications', req.params.id, { read: true, read_at: new Date().toISOString() }));
  } catch (error) { next(error); }
});
app.post('/v1/notifications/mark-all-read', async (req, res, next) => {
  try {
    const principal = notificationOwner(req) as SessionPrincipal;
    const all = req.query.all === 'true' && principal.role === 'admin';
    const rows = (await genericList(req, 'notifications'))
      .filter((row) => (all || isOwnNotification(row, principal)) && !row.read && !row.read_at);
    await Promise.all(rows.map((row) => genericUpdate(req, 'notifications', String(row.id), { read: true, read_at: new Date().toISOString() })));
    res.json({ message: 'all_notifications_marked_read', updated: rows.length });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// City operators / users
// ---------------------------------------------------------------------------
// Operator administration is an internal City surface. Every request needs a
// valid session; all admin operations additionally require the admin role.
// Passwords are never accepted here: the auth shell / Tier-1 IAM owns them.

app.use('/v1/users', requireSession);

app.get('/v1/users/me', async (req, res, next) => {
  const principal = (req as AuthedRequest).session as SessionPrincipal;
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.users);
    const record = sanitizeUser(recordData(await client.records.get(dataset.id, principal.sub)));
    res.json(sanitizeUser({ ...sessionUser(principal), ...record, id: principal.sub, role: principal.role, permissions: principal.permissions }));
  } catch {
    // The token principal is authoritative; a missing/offline profile store
    // must not turn /users/me into a 404 or return another user's record.
    res.json(sessionUser(principal));
  }
});

app.put('/v1/users/me', async (req, res, next) => {
  try {
    const principal = (req as AuthedRequest).session as SessionPrincipal;
    const body = privateInput(req);
    if (containsPassword(body)) return res.status(400).json({ error: 'password_is_managed_by_auth_shell' });
    const patch = {
      id: principal.sub,
      username: principal.username,
      email: String(body.email || principal.email),
      full_name: String(body.full_name || principal.full_name),
      ...(body.phone !== undefined ? { phone: String(body.phone) } : {}),
      role: principal.role,
      status: 'active',
      updated_at: new Date().toISOString(),
    };
    const updated = sanitizeUser(recordData(await genericWrite(req, 'users', patch, principal.sub)));
    res.json(sanitizeUser({ ...sessionUser(principal), ...updated, id: principal.sub, role: principal.role, permissions: principal.permissions }));
  } catch (error) { next(error); }
});

function rejectPasswordBody(req: Request, res: Response, next: NextFunction): void {
  const body = privateInput(req);
  if (containsPassword(body)) {
    res.status(400).json({ error: 'password_is_managed_by_auth_shell', detail: 'The City auth shell never stores or forwards passwords.' });
    return;
  }
  next();
}

app.post('/v1/users', rejectPasswordBody);
app.put('/v1/users/:id', rejectPasswordBody);

app.get('/v1/users/technicians', async (req, res, next) => { try { res.json((await genericList(req, 'users')).filter((row) => row.role === 'technician').map(sanitizeUser)); } catch (error) { next(error); } });
app.get('/v1/users/volunteers', async (req, res, next) => { try { res.json((await genericList(req, 'users')).filter((row) => row.role === 'volunteer').map(sanitizeUser)); } catch (error) { next(error); } });

installGenericCrud('/v1/users', 'users', { view: sanitizeUser, reserved: ['me', 'technicians', 'volunteers'] });

app.delete('/v1/users/:id', async (req, res, next) => {
  try {
    const current = sanitizeUser(await genericGet(req, 'users', req.params.id));
    await genericUpdate(req, 'users', req.params.id, { ...current, status: 'inactive', deleted_at: new Date().toISOString() });
    res.status(204).end();
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Geofences, geo and map
// ---------------------------------------------------------------------------
async function allAssetRows(req: Request): Promise<Array<Record<string, unknown>>> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.assets);
  return (await listAllRecords(client, dataset.id)).map((record) => assetView(record.data));
}

function assetPoint(asset: Record<string, unknown>): { longitude: number; latitude: number } | null {
  const coordinates = coordinatesOf(asset);
  if (!Number.isFinite(coordinates.longitude) || !Number.isFinite(coordinates.latitude)) return null;
  if (coordinates.longitude === 0 && coordinates.latitude === 0) return null;
  return coordinates;
}

function locationPoint(location: unknown): { longitude: number; latitude: number } | null {
  if (!location || typeof location !== 'object') return null;
  const coordinates = (location as Record<string, unknown>).coordinates;
  if (!coordinates || typeof coordinates !== 'object') return null;
  const point = {
    longitude: Number((coordinates as Record<string, unknown>).longitude),
    latitude: Number((coordinates as Record<string, unknown>).latitude),
  };
  if (!Number.isFinite(point.longitude) || !Number.isFinite(point.latitude)) return null;
  if (point.longitude === 0 && point.latitude === 0) return null;
  return point;
}

installGenericCrud('/v1/geofences', 'geofences');
app.post('/v1/geofences/:id/test', async (req, res, next) => {
  try {
    const fence = await genericGet(req, 'geofences', req.params.id);
    const polygon = polygonCoordinates(fence.polygon || fence.geometry || fence.coordinates);
    const center = parsePoint({
      longitude: (fence.center as Record<string, unknown> | undefined)?.longitude ?? fence.center_longitude,
      latitude: (fence.center as Record<string, unknown> | undefined)?.latitude ?? fence.center_latitude,
    });
    const radius = Number(fence.radius_meters) || 0;
    const inFence = (point: { longitude: number; latitude: number } | null): boolean => {
      if (!point) return false;
      if (polygon) return pointInPolygon(point, polygon);
      if (center && radius > 0) return haversineMeters(point, center) <= radius;
      return false;
    };
    const assets = (await allAssetRows(req)).filter((asset) => inFence(assetPoint(asset)));
    const sensors = (await genericList(req, 'sensors')).filter((sensor) => inFence(assetPoint(sensor)));
    res.json({
      geofence_id: fence.id,
      matched_assets: assets.length,
      matched_sensors: sensors.length,
      asset_ids: assets.map((asset) => asset.id),
      sensor_ids: sensors.map((sensor) => sensor.id),
      geometry_type: polygon ? 'polygon' : center ? 'circle' : 'unconfigured',
    });
  } catch (error) { next(error); }
});

app.get('/v1/geo/assets/nearby', async (req, res, next) => {
  try {
    const center = parsePoint({ lng: req.query.lng, lat: req.query.lat, longitude: req.query.longitude, latitude: req.query.latitude });
    if (!center) return res.status(400).json({ error: 'coordinates_required', detail: 'Send lng and lat.' });
    const radius = numberParam(req.query.radius_meters, 1000, 50_000);
    const featureType = req.query.feature_type ? String(req.query.feature_type).toLowerCase() : null;
    const rows: Array<Record<string, unknown>> = (await allAssetRows(req))
      .map((asset) => ({ asset, point: assetPoint(asset) }))
      .filter((entry): entry is { asset: Record<string, unknown>; point: { longitude: number; latitude: number } } => entry.point !== null)
      .map((entry) => Object.assign({}, entry.asset, { distance_meters: Math.round(haversineMeters(entry.point, center) * 10) / 10 }) as Record<string, unknown>)
      .filter((asset) => Number(asset.distance_meters) <= radius)
      .filter((asset) => !featureType || String(asset.feature_type || '').toLowerCase() === featureType)
      .sort((a, b) => Number(a.distance_meters) - Number(b.distance_meters));
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});

app.get('/v1/geo/assets/within-bounds', async (req, res, next) => {
  try {
    const box = {
      minLng: Number(req.query.min_lng),
      minLat: Number(req.query.min_lat),
      maxLng: Number(req.query.max_lng),
      maxLat: Number(req.query.max_lat),
    };
    if (Object.values(box).some((value) => !Number.isFinite(value))) {
      return res.status(400).json({ error: 'bounds_required', detail: 'Send min_lng, min_lat, max_lng, max_lat.' });
    }
    const featureType = req.query.feature_type ? String(req.query.feature_type).toLowerCase() : null;
    const rows = (await allAssetRows(req))
      .filter((asset) => {
        const point = assetPoint(asset);
        return point !== null && pointInBoundingBox(point, box);
      })
      .filter((asset) => !featureType || String(asset.feature_type || '').toLowerCase() === featureType);
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});

app.post('/v1/geo/assets/within-polygon', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const polygon = polygonCoordinates(body.polygon || body.coordinates || body.geometry);
    if (!polygon) return res.status(400).json({ error: 'polygon_required', detail: 'Send a GeoJSON Polygon or a coordinate ring.' });
    const featureType = body.feature_type ? String(body.feature_type).toLowerCase() : null;
    const rows = (await allAssetRows(req))
      .filter((asset) => {
        const point = assetPoint(asset);
        return point !== null && pointInPolygon(point, polygon);
      })
      .filter((asset) => !featureType || String(asset.feature_type || '').toLowerCase() === featureType);
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});

app.get('/v1/geo/search-address', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json([]);
    const hits = await tier2Autocomplete(capabilitiesFromRequest(req), query, 5);
    res.json(hits.map((hit) => ({
      address: hit.address,
      coordinates: hit.coordinates,
      city: hit.city,
      country: hit.country,
      ...(hit.id ? { ref_id: hit.id } : {}),
      provider: 'synapsedx',
    })));
  } catch (error) { next(error); }
});
app.post('/v1/geo/geocode', async (req, res, next) => {
  try {
    const text = String(privateInput(req).address || '').trim();
    if (!text) return res.status(400).json({ error: 'address_required' });
    const hit = await tier2Geocode(capabilitiesFromRequest(req), text);
    if (!hit) return res.status(404).json({ error: 'address_not_found' });
    res.json({
      coordinates: hit.coordinates,
      geojson: { type: 'Point', coordinates: [hit.coordinates.longitude, hit.coordinates.latitude] },
      display_name: hit.address || text,
      provider: 'synapsedx',
    });
  } catch (error) { next(error); }
});
app.post('/v1/geo/reverse-geocode', async (req, res, next) => {
  try {
    const input = privateInput(req);
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'coordinates_required' });
    const hit = await tier2Reverse(capabilitiesFromRequest(req), latitude, longitude);
    if (!hit) return res.status(404).json({ error: 'address_not_found' });
    res.json({ address: hit.address, city: hit.city, country: hit.country, provider: 'synapsedx' });
  } catch (error) { next(error); }
});

app.get('/v1/geo/assets/:id/distance-to', async (req, res, next) => {
  try {
    const target = parsePoint({ lng: req.query.lng, lat: req.query.lat, longitude: req.query.longitude, latitude: req.query.latitude });
    if (!target) return res.status(400).json({ error: 'coordinates_required' });
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const asset = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!asset) return res.status(404).json({ error: 'asset_not_found' });
    const origin = assetPoint(assetView(asset));
    if (!origin) return res.status(422).json({ error: 'asset_has_no_coordinates' });
    const distance = Math.round(haversineMeters(origin, target) * 10) / 10;
    res.json({
      asset_id: String(asset.id || req.params.id),
      distance_meters: distance,
      duration_seconds: estimatedDurationSeconds(distance),
      mode: 'straight_line_estimate',
      speed_kmh: 30,
    });
  } catch (error) { next(error); }
});

/**
 * GIS coverage analysis and population-weighted prioritisation. City-owned:
 * uses City assets/incidents plus population figures supplied by the operator.
 */
app.post('/v1/geo/coverage', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const areas = Array.isArray(body.areas) ? body.areas as CoverageAreaInput[] : [];
    if (areas.length === 0) return res.status(400).json({ error: 'areas_required', detail: 'Send { areas: [{ name, population, bbox|polygon, asset_types }] }.' });
    for (const area of areas) {
      if (!area || typeof area !== 'object' || !area.name) return res.status(400).json({ error: 'area_name_required' });
      if (!area.bbox && !area.polygon) return res.status(400).json({ error: 'area_geometry_required', area: area.name });
      if (!Number.isFinite(Number(area.population))) return res.status(400).json({ error: 'area_population_required', area: area.name });
      if (area.polygon && !polygonCoordinates(area.polygon)) return res.status(400).json({ error: 'area_polygon_invalid', area: area.name });
      if (area.bbox && Object.values(area.bbox).some((value) => !Number.isFinite(Number(value)))) return res.status(400).json({ error: 'area_bbox_invalid', area: area.name });
    }
    const assets: CoverageAsset[] = (await allAssetRows(req)).map((asset) => ({
      id: String(asset.id),
      feature_type: String(asset.feature_type || 'infrastructure'),
      point: assetPoint(asset),
    }));
    const incidents: CoverageIncident[] = (await genericList(req, 'incidents')).map((incident) => ({
      id: String(incident.id),
      status: String(incident.status || ''),
      point: assetPoint(incident) || locationPoint(incident.location),
      reported_at: incident.reported_at ? String(incident.reported_at) : undefined,
    }));
    const report = analyseCoverage({
      areas,
      assets,
      incidents,
      serviceRadiusMeters: body.service_radius_meters !== undefined ? Number(body.service_radius_meters) : undefined,
      targetPopulationPerAsset: body.target_population_per_asset !== undefined ? Number(body.target_population_per_asset) : undefined,
    });
    res.json(report);
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// CSV / data ingest
// ---------------------------------------------------------------------------

app.post('/v1/ingest/csv', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const filename = String(body.filename || 'upload.csv');
    const content = String(body.content || '');
    if (!content.trim()) return res.status(400).json({ error: 'content_required', detail: 'Send { filename, content } where content is the CSV text.' });
    const parsed = parseCsv(content);
    const missing = missingColumns(parsed.headers);
    if (missing.length > 0) return res.status(400).json({ error: 'missing_columns', missing });
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const errors: Array<{ row: number; message: string }> = [];
    let created = 0;
    // Build the asset rows first, then persist them through the Tier-2 bulk
    // endpoint in chunks of 100. A 1,000-row contribution import used to make
    // 1,000 sequential Tier-2 calls; batching keeps the import inside the
    // public gateway timeout and makes daily contribution sync practical.
    const entries: Array<{ id: string; data: Record<string, unknown>; publish: true }> = [];
    const rowNumbers: number[] = [];
    let skipped = 0;
    const isDuplicateFailure = (failure: { code?: string; message?: string }): boolean =>
      /already_exists|record_already_exists|duplicate/i.test(`${failure.code || ''} ${failure.message || ''}`);
    for (const [index, row] of parsed.rows.entries()) {
      const latitude = Number(row.latitude);
      const longitude = Number(row.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        errors.push({ row: index + 2, message: 'latitude_and_longitude_must_be_numeric' });
        continue;
      }
      if (!row.asset_code || !row.name || !row.feature_type || !row.feature_code) {
        errors.push({ row: index + 2, message: 'required_value_missing' });
        continue;
      }
      let properties: Record<string, unknown> = {};
      if (row.properties) {
        try {
          const parsedProperties = JSON.parse(row.properties);
          properties = parsedProperties && typeof parsedProperties === 'object' && !Array.isArray(parsedProperties) ? parsedProperties : {};
        } catch {
          errors.push({ row: index + 2, message: 'properties_must_be_valid_json' });
          continue;
        }
      }
      // Optional GeoJSON geometry column. Points can still be sent as
      // latitude/longitude; lines and polygons keep their real geometry.
      let geometry: Record<string, unknown> = { type: 'Point', coordinates: [longitude, latitude] };
      if (row.geometry) {
        try {
          const parsedGeometry = JSON.parse(row.geometry);
          if (!parsedGeometry || typeof parsedGeometry !== 'object' || typeof parsedGeometry.type !== 'string' || !Array.isArray(parsedGeometry.coordinates)) {
            errors.push({ row: index + 2, message: 'geometry_must_be_geojson' });
            continue;
          }
          geometry = parsedGeometry;
        } catch {
          errors.push({ row: index + 2, message: 'geometry_must_be_valid_json' });
          continue;
        }
      }
      entries.push({
        id: row.asset_code,
        publish: true,
        data: {
          assetId: row.asset_code,
          asset_code: row.asset_code,
          name: row.name,
          feature_type: row.feature_type,
          feature_code: row.feature_code,
          category: row.category || row.feature_type,
          status: row.status || 'active',
          geometry,
          location: { address: row.address || '', coordinates: { longitude, latitude } },
          properties,
          source: 'synapsecity-ingest',
          sourceVersion: '1.0.0',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      });
      rowNumbers.push(index + 2);
    }
    // Idempotent daily sync: skip assets the dataset already has instead of
    // sending duplicate ids through the Tier-2 bulk endpoint.
    const existingIds = new Set(
      (await listAllRecords(client, dataset.id)).map((record) => String(record.id)),
    );
    const fresh: typeof entries = [];
    const freshRowNumbers: number[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      if (existingIds.has(entries[i].id)) continue;
      fresh.push(entries[i]);
      freshRowNumbers.push(rowNumbers[i]);
    }
    skipped += entries.length - fresh.length;
    // Tier-2 bulk writes one record at a time internally, so a 100-record
    // request can exceed the 20s SDK timeout. Use small chunks with bounded
    // concurrency: a 200-row import finishes in a few waves while keeping the
    // public request below the edge/workflow timeout.
    const CHUNK = 25;
    const CONCURRENCY = 4;
    let cursor = 0;
    const runChunk = async (offset: number, chunk: typeof fresh): Promise<void> => {
      try {
        const result = await client.records.bulkCreate(dataset.id, chunk);
        created += result.created.length;
        for (const failure of result.errors) {
          if (isDuplicateFailure(failure)) {
            skipped += 1;
            continue;
          }
          const absolute = offset + Number(failure.index || 0);
          errors.push({ row: freshRowNumbers[absolute] ?? absolute + 2, message: failure.message || 'asset_create_failed' });
        }
      } catch (error) {
        // A wholly duplicate chunk returns 400. Treat it as an idempotent skip
        // so a retried daily sync can still acknowledge the batch.
        const bodyErrors = (error as { body?: { errors?: Array<{ index?: number; code?: string; message?: string }> } })?.body?.errors;
        if (Array.isArray(bodyErrors) && bodyErrors.length > 0) {
          for (const failure of bodyErrors) {
            if (isDuplicateFailure(failure)) {
              skipped += 1;
              continue;
            }
            const absolute = offset + Number(failure.index || 0);
            errors.push({ row: freshRowNumbers[absolute] ?? absolute + 2, message: failure.message || 'asset_create_failed' });
          }
          return;
        }
        const message = error instanceof Error ? error.message : 'asset_bulk_create_failed';
        for (let i = 0; i < chunk.length; i += 1) {
          errors.push({ row: freshRowNumbers[offset + i] ?? offset + i + 2, message });
        }
      }
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        const offset = cursor;
        cursor += CHUNK;
        if (offset >= fresh.length) return;
        await runChunk(offset, fresh.slice(offset, offset + CHUNK));
      }
    };
    const workerCount = Math.min(CONCURRENCY, Math.max(1, Math.ceil(fresh.length / CHUNK)));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const job = await genericWrite(req, 'ingest', {
      filename,
      status: 'completed',
      accepted: parsed.rows.length,
      created,
      skipped,
      failed: errors.length,
      errors: errors.slice(0, 50),
      completed_at: new Date().toISOString(),
    });
    // A completely failed batch must not look like a successful sync: the
    // workflow only acknowledges features after a 2xx response.
    const allFailed = created === 0 && skipped === 0 && errors.length > 0;
    res.status(allFailed ? 502 : 202).json({
      message: `Ingested ${created} of ${parsed.rows.length} asset rows (${skipped} already present)`,
      job_id: job.id,
      accepted: parsed.rows.length,
      created,
      skipped,
      errors,
    });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Public reporting and public lookup
// ---------------------------------------------------------------------------
// The public surface is anonymous by design: read-only projections of published
// assets/incidents, plus citizen report creation. It never reads the private
// maintenance dataset directly; the maintenance summary below only exposes
// aggregate, completed work-order facts.

const publicReportRateLimit = rateLimit({
  name: 'public-report',
  windowMs: Math.max(1000, Number(process.env.PUBLIC_RATE_WINDOW_MS || 600_000)),
  max: Math.max(1, Number(process.env.PUBLIC_RATE_LIMIT || 40)),
});

async function enforceTurnstile(req: Request, res: Response): Promise<boolean> {
  const result = await verifyTurnstile(req);
  if (result.ok) return true;
  const unavailable = result.error === 'turnstile_unavailable' || result.error === 'turnstile_not_configured';
  res.status(unavailable ? 503 : 403).json({ error: result.error || 'turnstile_failed', dependency: 'cloudflare-turnstile' });
  return false;
}

// Anonymous report uploads: bounded by the public rate limit + Turnstile, and
// restricted to image types. Files are forced public and served back only
// through /v1/public/files/:id/content.
app.post('/v1/public/files', publicReportRateLimit, uploadRaw, async (req, res, next) => {
  try {
    if (!(await enforceTurnstile(req, res))) return;
    const bytes = Buffer.isBuffer(req.body) ? req.body : null;
    if (!bytes || bytes.length === 0) return res.status(400).json({ error: 'binary_body_required' });
    const filename = decodeFilenameHeader(req);
    if (!filename) return res.status(400).json({ error: 'x_file_name_required' });
    const contentType = String(req.header('content-type') || '').split(';')[0].trim();
    const saved = await uploadFileBytes(req, {
      filename,
      contentType,
      bytes,
      owner: 'anonymous',
      public: true,
      entityType: 'incident',
      allowlist: IMAGE_MIME_TYPES,
      maxBytes: fileMaxBytesFor('photo'),
      ...(req.header('x-checksum-sha256') ? { checksumSha256: String(req.header('x-checksum-sha256')) } : {}),
    });
    res.status(201).json(fileView(saved));
  } catch (error) { next(error); }
});

app.get('/v1/public/files/:id/content', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const record = await getFileMetadata(client, String(req.params.id));
    if (!record || record.public !== true) return res.status(404).json({ error: 'file_not_found' });
    const download = await client.files.download(String(record.id));
    res.setHeader('content-type', String(download.contentType || record.contentType || 'application/octet-stream'));
    res.setHeader('content-length', String(download.data.length));
    res.setHeader('cache-control', 'public, max-age=300');
    if (download.checksumSha256 || record.checksumSha256) res.setHeader('x-checksum-sha256', String(download.checksumSha256 || record.checksumSha256));
    res.send(Buffer.from(download.data));
  } catch (error) { next(error); }
});

app.get('/v1/public/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const includeInactive = ['true', '1'].includes(String(req.query.include_inactive || '').toLowerCase());
    const rows = (await listAllRecords(client, dataset.id))
      .map((record) => record.data)
      .filter((asset) => assetIsPublic(asset, { includeInactive }))
      .map(publicAssetView);
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});

app.get('/v1/public/assets/:code/qr-code', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const asset = await findRecord(client, dataset.id, req.params.code, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!asset || !assetIsPublic(asset, { includeInactive: true })) return res.status(404).json({ error: 'asset_not_found' });
    const view = publicAssetView(asset);
    res.json({ asset_code: view.asset_code, qr_code: view.qr_code, url: view.public_url });
  } catch (error) { next(error); }
});

app.get('/v1/public/assets/:code/maintenance-summary', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const assetDataset = await ensureDataset(client, DATASETS.assets);
    const asset = await findRecord(client, assetDataset.id, req.params.code, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!asset || !assetIsPublic(asset, { includeInactive: true })) return res.status(404).json({ error: 'asset_not_found' });
    const maintenanceDataset = await ensureDataset(client, DATASETS.maintenance);
    const assetIds = new Set([String(asset.id), String(asset.asset_code || '')].filter(Boolean));
    const orders = (await listAllRecords(client, maintenanceDataset.id))
      .map((record) => recordData(record.data))
      .filter((order) => assetIds.has(String(order.asset_id || order.assetId || '')));
    const completed = orders
      .filter((order) => String(order.status || '').toLowerCase() === 'completed')
      .sort((a, b) => Date.parse(String(b.completed_at || b.scheduled_date || '')) - Date.parse(String(a.completed_at || a.scheduled_date || '')));
    res.json({
      asset_code: String(asset.asset_code || asset.id),
      work_order_count: orders.length,
      completed_count: completed.length,
      last_completed_at: completed[0] ? String(completed[0].completed_at || completed[0].scheduled_date || '') : null,
      last_maintenance_type: completed[0] ? String(completed[0].type || completed[0].maintenance_type || '') : null,
    });
  } catch (error) { next(error); }
});

app.get('/v1/public/assets/:code', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const asset = await findRecord(client, dataset.id, req.params.code, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!asset || !assetIsPublic(asset, { includeInactive: true })) return res.status(404).json({ error: 'asset_not_found' });
    res.json(publicAssetView(asset));
  } catch (error) { next(error); }
});

app.get('/v1/public/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const rows = (await listAllRecords(client, dataset.id))
      .map((record) => record.data)
      .filter(incidentIsPubliclyVisible)
      .map(publicIncidentView);
    sendPage(res, rows, req);
  } catch (error) { next(error); }
});

app.post('/v1/public/incidents', publicReportRateLimit, async (req, res, next) => {
  try {
    if (!(await enforceTurnstile(req, res))) return;
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const body = privateInput(req);
    const incidentId = randomUUID();
    const number = incidentNumber();
    const photoValues: unknown[] = Array.isArray(body.photos)
      ? body.photos
      : (Array.isArray(body.file_ids) ? body.file_ids : (body.file_id ? [body.file_id] : []));
    if (photoValues.length > 10) return res.status(413).json({ error: 'too_many_photos', max: 10 });
    const photos = photoValues.length
      ? (await resolvePhotos(req, photoValues, { publicUrl: true })).map((entry) => entry.url)
      : [];
    // Reporter contact details are written only to the private sidecar; the
    // public projection record never contains them.
    const contact = body.contact_info && typeof body.contact_info === 'object' ? body.contact_info as Record<string, unknown> : null;
    const incident = {
      incidentId,
      incident_number: number,
      incident_code: number,
      title: requiredString(body, 'title'),
      description: requiredString(body, 'description'),
      category: String(body.category || 'other'),
      severity: String(body.severity || 'medium'),
      status: 'reported',
      reporter_type: 'citizen',
      reported_by: 'anonymous',
      reported_via: 'web',
      public_visible: true,
      ...(body.asset_id !== undefined ? { asset_id: String(body.asset_id) } : {}),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(photos.length ? { photos } : {}),
      ...(contact ? { contact_info: { name: contact.name || '', phone_number: contact.phone_number || '', id_card_verified: Boolean(contact.id_card_number) } } : {}),
      reported_at: new Date().toISOString(),
      occurredAt: String(body.occurredAt || new Date().toISOString()),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      upvotes: 0,
      comments: [],
      source: 'synapsecity-public',
      sourceVersion: '1.0.0',
    };
    const published = toPublishedIncident(incident);
    // Anonymous reports stay out of the open-data publication. Even if a
    // Tier-2 defect republished the record, it contains no contact PII.
    await client.records.create(dataset.id, published, { id: incidentId, publish: false });
    await writeIncidentInternal(req, incidentId, incident);
    await notifyOperators(req, 'incident_reported', `New citizen report: ${String(published.title || incidentId)}`, String(published.description || ''), String(published.severity || '') === 'critical' ? 'critical' : 'info', 'incident', incidentId).catch((error) => console.warn('[synapsecity] operator_notification_failed', (error as Error).message));
    res.status(201).json(publicIncidentView({ id: incidentId, data: published }));
  } catch (error) { next(error); }
});

app.post('/v1/public/incidents/:incidentId/photos', publicReportRateLimit, async (req, res, next) => {
  try {
    const body = privateInput(req);
    const photoValues: unknown[] = Array.isArray(body.photos)
      ? body.photos
      : (Array.isArray(body.file_ids) ? body.file_ids : (body.file_id ? [body.file_id] : []));
    if (photoValues.length === 0) return res.status(400).json({ error: 'photos_required', detail: 'Send file ids returned by POST /v1/public/files.' });
    const photos = (await resolvePhotos(req, photoValues, { publicUrl: true })).map((entry) => entry.url);
    const existing = await findPublicIncident(req, String(req.params.incidentId));
    if (!existing || !incidentIsPubliclyVisible(existing)) return res.status(404).json({ error: 'incident_not_found' });
    const current = Array.isArray(existing.photos) ? existing.photos.map(String) : [];
    const updated = await updateIncident(req, String(req.params.incidentId), { photos: [...current, ...photos] });
    res.json(publicIncidentView(updated));
  } catch (error) { next(error); }
});

app.get('/v1/public/incidents/:incidentId', async (req, res, next) => {
  try {
    const incident = await findPublicIncident(req, req.params.incidentId);
    if (!incident || !incidentIsPubliclyVisible(incident)) return res.status(404).json({ error: 'incident_not_found' });
    res.json(publicIncidentView(incident));
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// AI and map capability instances
// ---------------------------------------------------------------------------
app.get('/v1/map/config', (_req, res) => res.json({ provider: 'synapsedx', tileUrl: '/v1/map/tiles/{z}/{x}/{y}.png', attribution: '&copy; VIETMAP', maxZoom: 20, maxNativeZoom: 20, style: 'tm' }));
app.get('/v1/map/tiles/:z/:x/:y.png', async (req, res, next) => { try { await proxyTier2Tile(Number(req.params.z), Number(req.params.x), Number(req.params.y), res); } catch (error) { next(error); } });
app.get('/v1/map/status', (_req, res) => res.json({ provider: 'synapsedx', configured: tier2MapConfigured(), service: 'synapsecity' }));

// Public assistant: anonymous visitors get a strict per-IP budget; signed-in
// operators share the same limiter (the session still scopes upstream calls).
const publicAiRateLimit = rateLimit({
  name: 'public-ai',
  windowMs: Math.max(1000, Number(process.env.PUBLIC_AI_RATE_WINDOW_MS || 60_000)),
  max: Math.max(1, Number(process.env.PUBLIC_AI_RATE_LIMIT || 20)),
});

// AI is answered by the Tier-2 capability. When the deployment/provider does
// not expose it the endpoint returns a typed 503 instead of canned text.
app.get('/v1/ai/status', publicAiRateLimit, async (req, res, next) => {
  try {
    const status = await aiStatus(capabilitiesFromRequest(req));
    res.status(status.status === 'unavailable' ? 503 : 200).json(status);
  } catch (error) { next(error); }
});
app.post('/v1/ai/chat', publicAiRateLimit, async (req, res, next) => {
  try {
    const body = privateInput(req);
    const message = String(body.message || '').trim();
    if (!message) return res.status(400).json({ error: 'message_required' });
    const result = await aiChat(capabilitiesFromRequest(req), message, {
      ...(body.asset_id ? { asset_id: body.asset_id } : {}),
      ...(body.context && typeof body.context === 'object' ? { context: body.context } : {}),
    });
    res.json(result);
  } catch (error) { next(error); }
});

// Final /v1 fallback: unknown namespaces are not part of the City contract and
// are rejected locally instead of being mistaken for a City collection. The
// normalized check also catches an encoded `v1` prefix.
app.use((req, res, next) => {
  const path = normalizedPath(req.originalUrl);
  if (path !== '/v1' && !path.startsWith('/v1/')) return next();
  res.status(404).json({ error: 'not_found', product: PRODUCT });
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(error?.status || (error instanceof CapabilitiesError ? error.status : 500) || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error?.message || 'internal_error',
    ...(error?.dependency ? { dependency: error.dependency } : {}),
    ...(error?.code && error.code !== error.message ? { code: error.code } : {}),
    ...(error instanceof CapabilitiesError && error.body ? { upstream: error.body } : {}),
  });
});

export function createServer() { return app; }

if (require.main === module) {
  if (process.env.NODE_ENV === 'production' && process.env.REQUIRE_TURNSTILE !== 'true') {
    console.warn('[synapsecity] REQUIRE_TURNSTILE is not enabled; anonymous reports rely on the Tier-2 Turnstile adapter when configured.');
  }
  app.listen(PORT, () => console.log(`[synapsecity] Tier-3 API listening on :${PORT}; Tier-2=${TIER2_URL}`));
}
