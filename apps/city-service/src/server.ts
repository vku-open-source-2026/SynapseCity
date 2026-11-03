// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CapabilitiesError, CapabilitiesClient } from '@synapsedx/capabilities';
import { DATASETS, TIER2_URL, capabilitiesFromRequest, ensureDataset, objectBody, requiredString } from './domain';
import { proxyVietMapTile, vietMapAutocomplete, vietMapConfigured, vietMapGeocode, vietMapPlace, vietMapReverse, vietMapTileStyle } from './vietmap';
import {
  AuthedRequest,
  SessionPrincipal,
  containsPassword,
  issueSession,
  permissionsForRole,
  principalFromInput,
  requireAdmin,
  requireSession,
  sanitizeUser,
  sessionFromRequest,
  sessionUser,
  verifyToken,
} from './auth';
import { missingColumns, parseCsv } from './csv';

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
// CSV uploads are sent as JSON text (the DataIngest screen reads the file in
// the browser), and photos/documents are sent as metadata or data URLs. A
// larger JSON limit keeps the demo console functional without a multipart
// parser or blob store.
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN || 'https://synapsecity.sbs';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
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

function publicAssetView(row: any): Record<string, unknown> {
  const asset = assetView(row);
  const location = (asset.location || {}) as Record<string, unknown>;
  const coordinates = coordinatesOf(asset);
  const assetCode = String(asset.asset_code || asset.id || '');
  const url = `${PUBLIC_URL}/asset/${encodeURIComponent(assetCode)}`;
  return {
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
}

function publicIncidentView(row: any): Record<string, unknown> {
  const incident = incidentView(row);
  const comments = (incident.comments as Array<Record<string, unknown>>).filter((comment) => comment.is_internal !== true);
  const { contact_info: _contactInfo, ...rest } = incident;
  return {
    ...rest,
    comments,
    // Public lookups never expose reporter contact details or internal notes.
    reporter_type: 'citizen',
    public_visible: incident.public_visible !== false,
  };
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

async function findIncident(req: Request, reference: string): Promise<Record<string, unknown> | null> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.incidents);
  return findRecord(client, dataset.id, reference, ['incident_number', 'incident_code', 'incidentId', 'id']);
}

async function updateIncident(req: Request, reference: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = capabilitiesFromRequest(req);
  const dataset = await ensureDataset(client, DATASETS.incidents);
  const current = incidentView(await findIncident(req, reference));
  const id = String(current.id || reference);
  const updated = await client.records.update(dataset.id, id, {
    ...current,
    ...patch,
    id,
    source: 'synapsecity',
    updated_at: new Date().toISOString(),
  });
  return incidentView(updated);
}

function incidentNumber(): string {
  const year = new Date().getUTCFullYear();
  return `INC-${year}-${randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Auth session shell
// ---------------------------------------------------------------------------
// The City product owns the /v1/auth namespace as a stateless session adapter.
// Credentials are deliberately not stored: production identity belongs to the
// Tier-1 IAM service. See auth.ts for the full design note.

app.post('/v1/auth/login', (req, res) => {
  const body = objectBody(req.body);
  const username = String(body.username || body.email || '').trim();
  const password = String(body.password || '');
  if (!username) return res.status(400).json({ error: 'username_required' });
  if (!password.trim()) return res.status(400).json({ error: 'password_required' });
  const principal = principalFromInput({
    username,
    email: typeof body.email === 'string' ? body.email : undefined,
    full_name: typeof body.full_name === 'string' ? body.full_name : undefined,
    phone: typeof body.phone === 'string' ? body.phone : undefined,
  }, 'admin');
  res.json(issueSession(principal));
});

app.post('/v1/auth/register', (req, res) => {
  const body = objectBody(req.body);
  const username = String(body.username || '').trim();
  const email = String(body.email || '').trim();
  const password = String(body.password || '');
  const fullName = String(body.full_name || '').trim();
  if (!username) return res.status(400).json({ error: 'username_required' });
  if (!email) return res.status(400).json({ error: 'email_required' });
  if (!fullName) return res.status(400).json({ error: 'full_name_required' });
  if (password.length < 6) return res.status(400).json({ error: 'password_too_short' });
  // Self-registration never grants an operator role. Passwords are not stored.
  const principal = principalFromInput({ username, email, full_name: fullName, phone: typeof body.phone === 'string' ? body.phone : undefined }, 'citizen');
  res.status(201).json(issueSession({ ...principal, role: 'citizen', permissions: permissionsForRole('citizen') }));
});

app.post('/v1/auth/refresh', (req, res) => {
  const body = objectBody(req.body);
  const token = String(body.refresh_token || '');
  const principal = token ? verifyToken(token, 'refresh') : null;
  if (!principal) return res.status(401).json({ error: 'invalid_refresh_token' });
  res.json(issueSession(principal));
});

app.post('/v1/auth/logout', (_req, res) => res.status(204).end());

app.post('/v1/auth/change-password', requireSession, (req, res) => {
  const body = objectBody(req.body);
  if (!String(body.current_password || '').trim() || !String(body.new_password || '').trim()) {
    return res.status(400).json({ error: 'current_and_new_password_required', detail: 'passwords_are_managed_by_the_identity_provider' });
  }
  // The City service never persists credentials. Delegated Tier-1 IAM owns the
  // password change. Returning 204 keeps the shared auth shell contract working
  // without creating a local password store.
  res.status(204).end();
});

app.get('/v1/auth/me', requireSession, (req, res) => {
  res.json(sessionUser((req as AuthedRequest).session as SessionPrincipal));
});

app.get('/v1/auth/verify', requireSession, (req, res) => {
  const principal = (req as AuthedRequest).session as SessionPrincipal;
  res.json({ valid: true, user_id: principal.sub, username: principal.username, role: principal.role, permissions: principal.permissions });
});

// ---------------------------------------------------------------------------
// Service metadata
// ---------------------------------------------------------------------------

app.get('/health', async (req, res, next) => {
  try {
    const tier2 = await capabilitiesFromRequest(req).health();
    res.json({ status: 'ok', service: 'synapsecity', tier: 3, tier2, tier2Url: TIER2_URL });
  } catch (error) { next(error); }
});

app.get('/ready', async (req, res, next) => {
  try {
    const tier2 = await capabilitiesFromRequest(req).health();
    res.json({ status: 'ready', service: 'synapsecity', tier: 3, tier2, tier2Url: TIER2_URL });
  } catch (error) { next(error); }
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
}));

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

app.get('/v1/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const page = await client.records.list(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset ?? req.query.skip, 0, 1_000_000) });
    let assets = page.items.map(assetView);
    for (const field of ['status', 'category', 'feature_type']) {
      const filter = req.query[field];
      if (filter) assets = assets.filter((asset) => String(asset[field] || '').toLowerCase() === String(filter).toLowerCase());
    }
    res.json(assets);
  } catch (error) { next(error); }
});

app.post('/v1/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const body = privateInput(req);
    const name = requiredString(body, 'name');
    const assetCode = String(body.asset_code || body.feature_code || body.assetCode || randomUUID());
    const geometry = body.geometry && typeof body.geometry === 'object' ? body.geometry : { type: 'Point', coordinates: [0, 0] };
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
    await updateAsset(req, String(existing.id), { deleted_at: new Date().toISOString(), status: 'decommissioned', lifecycle_status: 'decommissioned' });
    res.status(204).end();
  } catch (error) { next(error); }
});

function attachmentFromBody(body: Record<string, unknown>, fallbackName = 'attachment'): Record<string, unknown> {
  const fileUrl = String(body.file_url || body.url || body.photo || '');
  if (!fileUrl) throw Object.assign(new Error('file_url_required'), { status: 400 });
  return {
    file_name: String(body.file_name || body.name || fallbackName),
    file_url: fileUrl,
    file_type: String(body.file_type || body.type || 'application/octet-stream'),
    uploaded_by: String(body.uploaded_by || 'operator'),
    uploaded_at: String(body.uploaded_at || new Date().toISOString()),
    ...(body.document_type !== undefined ? { document_type: String(body.document_type) } : {}),
    ...(body.is_public !== undefined ? { is_public: Boolean(body.is_public) } : {}),
    ...(body.version !== undefined ? { version: Number(body.version) } : {}),
  };
}

app.post('/v1/assets/:id/photos', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const urls = Array.isArray(body.photos) ? body.photos.map(String) : (body.file_url ? [String(body.file_url)] : []);
    if (urls.length === 0) return res.status(400).json({ error: 'photos_required' });
    const currentPhotos = Array.isArray(existing.photos) ? existing.photos.map(String) : [];
    const currentAttachments = Array.isArray(existing.attachments) ? existing.attachments as Record<string, unknown>[] : [];
    const attachments = urls.map((url, index) => attachmentFromBody({ ...body, file_url: url, file_name: String(body.file_name || `photo-${index + 1}`), file_type: String(body.file_type || 'image/*') }, `photo-${index + 1}`));
    res.json(await updateAsset(req, String(existing.id), { photos: [...currentPhotos, ...urls], attachments: [...currentAttachments, ...attachments] }));
  } catch (error) { next(error); }
});

app.post('/v1/assets/:id/attachments', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const attachment = attachmentFromBody(body);
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
    const attachment = attachmentFromBody(body, 'document');
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

app.post('/v1/assets/:id/reports', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const client = capabilitiesFromRequest(req);
    const assetDataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, assetDataset.id, req.params.id, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    const reportDataset = await ensureDataset(client, DATASETS.reports);
    const reportId = randomUUID();
    const report = {
      id: reportId,
      report_code: `RPT-${reportId.slice(0, 8).toUpperCase()}`,
      asset_id: String(existing.id),
      asset_code: existing.asset_code,
      report_type: String(body.report_type || 'maintenance_summary'),
      format: String(body.format || 'json'),
      filters: body.filters && typeof body.filters === 'object' ? body.filters : {},
      status: 'generated',
      generated_at: new Date().toISOString(),
      source: 'synapsecity',
    };
    await client.records.create(reportDataset.id, report, { id: reportId, publish: false });
    res.status(201).json({ report_id: reportId, report_url: `${PUBLIC_URL}/v1/reports/${reportId}/download` });
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
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const existing = await findRecord(client, dataset.id, String(req.params.id), ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!existing) return res.status(404).json({ error: 'asset_not_found' });
    res.json([]);
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
    const page = await client.records.list(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset ?? req.query.skip, 0, 1_000_000) });
    let incidents = page.items.map(incidentView);
    for (const field of ['status', 'severity', 'asset_id', 'assigned_to', 'verification_status']) {
      const filter = req.query[field];
      if (!filter) continue;
      const key = field === 'asset_id' ? 'asset_id' : field;
      incidents = incidents.filter((incident) => String(incident[key] || '').toLowerCase() === String(filter).toLowerCase());
    }
    res.json(incidents);
  } catch (error) { next(error); }
});

app.post('/v1/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const body = privateInput(req);
    const incidentId = String(body.incidentId || randomUUID());
    const number = String(body.incident_number || body.incident_code || incidentNumber());
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
      ...(Array.isArray(body.photos) ? { photos: body.photos.map(String) } : {}),
      occurredAt: String(body.occurredAt || new Date().toISOString()),
      reported_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      upvotes: 0,
      comments: [],
      source: 'synapsecity', sourceVersion: '1.0.0',
    };
    res.status(201).json(incidentView(await client.records.create(dataset.id, incident, { id: incidentId, publish: true })));
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
    res.json(await updateIncident(req, req.params.id, { assigned_to: assignedTo, status: 'assigned', assigned_at: new Date().toISOString() }));
  } catch (error) { next(error); }
});

app.post('/v1/incidents/:id/resolve', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const notes = String(body.resolution_notes || req.query.resolution_notes || '');
    const type = String(body.resolution_type || req.query.resolution_type || 'fixed');
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
    res.json(await updateIncident(req, req.params.id, { status: 'resolved', resolution_notes: notes, resolution_type: type, resolved_at: new Date().toISOString() }));
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

app.post('/v1/incidents/:id/approve-cost', async (req, res, next) => {
  try {
    if (!(await findIncident(req, req.params.id))) return res.status(404).json({ error: 'incident_not_found' });
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
  const page = await c.records.list((await ensureDataset(c, genericSpec(key))).id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.skip ?? req.query.offset, 0, 1_000_000) });
  return page.items.map(recordData);
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
}

function installGenericCrud(prefix: string, key: GenericKey, options: GenericOptions = {}): void {
  const view = options.view || ((record: Record<string, unknown>) => record);
  const reserved = new Set((options.reserved || []).map((value) => value.toLowerCase()));
  const isReserved = (id: string) => reserved.has(String(id).toLowerCase());
  app.get(prefix, async (req, res, next) => { try { res.json((await genericList(req, key)).map(view)); } catch (error) { next(error); } });
  app.get(`${prefix}/:id`, async (req, res, next) => {
    if (isReserved(req.params.id)) return next();
    try { res.json(view(await genericGet(req, key, req.params.id))); } catch (error) { next(error); }
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

// Specific routes are registered before the generic :id route, and the generic
// route also skips the reserved names. This prevents /upcoming and /asset/...
// from being parsed as a work-order id.
app.get('/v1/maintenance/upcoming', async (req, res, next) => {
  try {
    const days = numberParam(req.query.days, 7, 30);
    const horizon = Date.now() + days * 86_400_000;
    const rows = await genericList(req, 'maintenance');
    res.json(rows.filter((row) => {
      const status = String(row.status || '').toLowerCase();
      if (['completed', 'cancelled', 'closed'].includes(status)) return false;
      const scheduled = Date.parse(String(row.scheduled_date || row.scheduledDate || ''));
      return !Number.isFinite(scheduled) || scheduled <= horizon;
    }));
  } catch (error) { next(error); }
});
app.get('/v1/maintenance/asset/:assetId', async (req, res, next) => {
  try {
    res.json((await genericList(req, 'maintenance')).filter((row) => String(row.asset_id || row.assetId || '') === req.params.assetId));
  } catch (error) { next(error); }
});
installGenericCrud('/v1/maintenance', 'maintenance', { reserved: ['upcoming', 'asset'] });
for (const action of ['assign', 'start', 'complete', 'cancel', 'approve', 'reject']) {
  app.post(`/v1/maintenance/:id/${action}`, async (req, res, next) => {
    try {
      const body = Object.keys(genericBody(req)).length > 0 ? genericBody(req) : Object.fromEntries(Object.entries(req.query).map(([key, value]) => [key, String(value)]));
      res.json(await genericUpdate(req, 'maintenance', req.params.id, {
        ...body,
        ...(action === 'start' ? { status: 'in_progress' } : {}),
        ...(action === 'complete' ? { status: 'completed', completed_at: new Date().toISOString() } : {}),
        ...(action === 'cancel' ? { status: 'cancelled' } : {}),
        ...(action === 'approve' ? { approval_status: 'approved' } : {}),
        ...(action === 'reject' ? { approval_status: 'rejected' } : {}),
      }));
    } catch (error) { next(error); }
  });
}
app.post('/v1/maintenance/:id/photos', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const current = await genericGet(req, 'maintenance', req.params.id);
    const attachments = Array.isArray(current.attachments) ? current.attachments as Record<string, unknown>[] : [];
    const photos = Array.isArray(body.attachments)
      ? body.attachments as Record<string, unknown>[]
      : (Array.isArray(body.photos) ? (body.photos as string[]).map((url, index) => attachmentFromBody({ file_url: url, file_name: String(body.file_name || `photo-${index + 1}`), file_type: String(body.file_type || 'image/*') })) : []);
    if (photos.length === 0) return res.status(400).json({ error: 'photos_required' });
    res.json(await genericUpdate(req, 'maintenance', req.params.id, { attachments: [...attachments, ...photos] }));
  } catch (error) { next(error); }
});

// IoT metadata and readings share two Tier-2 datasets.
installGenericCrud('/v1/iot/sensors', 'sensors');
app.delete('/v1/iot/sensors/:id', async (req, res, next) => { try { await genericUpdate(req, 'sensors', req.params.id, { status: 'inactive', deleted_at: new Date().toISOString() }); res.status(204).end(); } catch (error) { next(error); } });
app.get('/v1/iot/sensors/:id/data', async (req, res, next) => { try { res.json(await genericList(req, 'sensorData')); } catch (error) { next(error); } });
app.post('/v1/iot/sensors/:id/data', async (req, res, next) => { try { res.status(201).json(await genericWrite(req, 'sensorData', { ...genericBody(req), sensor_id: req.params.id })); } catch (error) { next(error); } });
app.post('/v1/iot/sensors/batch-ingest', async (req, res, next) => { try { const values: Record<string, unknown>[] = Array.isArray(req.body) ? req.body : (Array.isArray(req.body?.readings) ? req.body.readings : []); res.status(201).json(await Promise.all(values.map((row) => genericWrite(req, 'sensorData', row)))); } catch (error) { next(error); } });
app.get('/v1/iot/sensors/:id/status', async (req, res, next) => { try { const sensor = await genericGet(req, 'sensors', req.params.id); res.json({ ...sensor, status: sensor.status || 'online' }); } catch (error) { next(error); } });
app.get('/v1/iot/sensors/:id/statistics', async (req, res, next) => { try { const values = await genericList(req, 'sensorData'); res.json({ count: values.length, latest: values[0] || null, min: null, max: null, average: null }); } catch (error) { next(error); } });
app.get('/v1/iot/assets/:assetId/iot-data', async (req, res, next) => { try { res.json((await genericList(req, 'sensorData')).filter((row) => String(row.asset_id || '') === req.params.assetId)); } catch (error) { next(error); } });

installGenericCrud('/v1/alerts', 'alerts');
for (const action of ['acknowledge', 'resolve', 'dismiss']) app.post(`/v1/alerts/:id/${action}`, async (req, res, next) => { try { res.json(await genericUpdate(req, 'alerts', req.params.id, { ...genericBody(req), status: action === 'acknowledge' ? 'acknowledged' : action === 'resolve' ? 'resolved' : 'dismissed' })); } catch (error) { next(error); } });

installGenericCrud('/v1/budgets', 'budgets');
for (const action of ['submit', 'approve']) app.post(`/v1/budgets/:id/${action}`, async (req, res, next) => { try { res.json(await genericUpdate(req, 'budgets', req.params.id, { status: action === 'submit' ? 'submitted' : 'approved' })); } catch (error) { next(error); } });
app.get('/v1/budgets/:id/transactions', async (req, res, next) => { try { res.json((await genericList(req, 'transactions')).filter((row) => String(row.budget_id || '') === req.params.id)); } catch (error) { next(error); } });
app.post('/v1/budgets/:id/transactions', async (req, res, next) => { try { res.status(201).json(await genericWrite(req, 'transactions', { ...genericBody(req), budget_id: req.params.id })); } catch (error) { next(error); } });
app.post('/v1/budgets/transactions/:id/approve', async (req, res, next) => { try { res.json(await genericUpdate(req, 'transactions', req.params.id, { status: 'approved' })); } catch (error) { next(error); } });

installGenericCrud('/v1/reports', 'reports');
app.post('/v1/reports/:id/generate', async (req, res, next) => { try { res.json(await genericUpdate(req, 'reports', req.params.id, { status: 'generated', generated_at: new Date().toISOString() })); } catch (error) { next(error); } });
app.get('/v1/reports/:id/download', async (req, res, next) => { try { const report = await genericGet(req, 'reports', req.params.id); res.json({ file_url: report.file_url || null, report_code: report.report_code || report.id, format: report.format || 'json' }); } catch (error) { next(error); } });

app.get('/v1/notifications', async (req, res, next) => { try { res.json(await genericList(req, 'notifications')); } catch (error) { next(error); } });
app.get('/v1/notifications/unread-count', async (req, res, next) => { try { const rows = await genericList(req, 'notifications'); res.json({ unread_count: rows.filter((row) => !row.read_at && row.read !== true).length }); } catch (error) { next(error); } });
app.post('/v1/notifications/:id/read', async (req, res, next) => { try { res.json(await genericUpdate(req, 'notifications', req.params.id, { read: true, read_at: new Date().toISOString() })); } catch (error) { next(error); } });
app.post('/v1/notifications/mark-all-read', async (req, res, next) => { try { await Promise.all((await genericList(req, 'notifications')).map((row) => genericUpdate(req, 'notifications', String(row.id), { read: true, read_at: new Date().toISOString() }))); res.json({ message: 'all_notifications_marked_read' }); } catch (error) { next(error); } });

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

app.use('/v1/users', requireAdmin);

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
installGenericCrud('/v1/geofences', 'geofences');
app.post('/v1/geofences/:id/test', async (req, res, next) => { try { const fence = await genericGet(req, 'geofences', req.params.id); res.json({ matched_assets: 0, matched_sensors: 0, geofence_id: fence.id }); } catch (error) { next(error); } });
app.get('/v1/geo/assets/nearby', async (req, res, next) => { try { res.json(await genericList(req, 'assets')); } catch (error) { next(error); } });
app.get('/v1/geo/assets/within-bounds', async (req, res, next) => { try { res.json(await genericList(req, 'assets')); } catch (error) { next(error); } });
app.post('/v1/geo/assets/within-polygon', async (req, res, next) => { try { res.json(await genericList(req, 'assets')); } catch (error) { next(error); } });
app.get('/v1/geo/search-address', async (req, res, next) => {
  try {
    const query = String(req.query.q || '').trim();
    if (query.length < 2) return res.json([]);
    const suggestions = await vietMapAutocomplete(query);
    const enriched = await Promise.all(suggestions.slice(0, 5).map(async (item) => {
      const place = item.ref_id ? await vietMapPlace(item.ref_id).catch(() => null) : null;
      return { address: item.display || item.address || item.name || query, coordinates: { latitude: Number(place?.lat || 0), longitude: Number(place?.lng || 0) }, city: place?.city || '', country: 'Vietnam', ref_id: item.ref_id };
    }));
    res.json(enriched.filter((item) => item.coordinates.latitude !== 0 || item.coordinates.longitude !== 0));
  } catch (error) { next(error); }
});
app.post('/v1/geo/geocode', async (req, res, next) => {
  try {
    const text = String(privateInput(req).address || '').trim();
    if (!text) return res.status(400).json({ error: 'address_required' });
    const [match] = await vietMapGeocode(text);
    if (!match?.ref_id) return res.status(404).json({ error: 'address_not_found' });
    const place = await vietMapPlace(match.ref_id);
    if (!Number.isFinite(place.lat) || !Number.isFinite(place.lng)) return res.status(404).json({ error: 'coordinates_not_found' });
    res.json({ coordinates: { latitude: place.lat, longitude: place.lng }, geojson: { type: 'Point', coordinates: [place.lng, place.lat] }, display_name: place.display || match.display || text });
  } catch (error) { next(error); }
});
app.post('/v1/geo/reverse-geocode', async (req, res, next) => {
  try {
    const input = privateInput(req);
    const latitude = Number(input.latitude);
    const longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return res.status(400).json({ error: 'coordinates_required' });
    const [place] = await vietMapReverse(latitude, longitude);
    if (!place) return res.status(404).json({ error: 'address_not_found' });
    res.json({ address: place.display || place.address || '', city: place.city || '', country: 'Vietnam' });
  } catch (error) { next(error); }
});
app.get('/v1/geo/assets/:id/distance-to', (_req, res) => res.json({ distance_meters: 0, duration_seconds: 0 }));

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
      const asset = {
        assetId: row.asset_code,
        asset_code: row.asset_code,
        name: row.name,
        feature_type: row.feature_type,
        feature_code: row.feature_code,
        category: row.category || row.feature_type,
        status: row.status || 'active',
        geometry: { type: 'Point', coordinates: [longitude, latitude] },
        location: { address: row.address || '', coordinates: { longitude, latitude } },
        properties,
        source: 'synapsecity-ingest',
        sourceVersion: '1.0.0',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      try {
        await client.records.create(dataset.id, asset, { id: row.asset_code, publish: true });
        created += 1;
      } catch (error) {
        errors.push({ row: index + 2, message: error instanceof Error ? error.message : 'asset_create_failed' });
      }
    }
    const job = await genericWrite(req, 'ingest', {
      filename,
      status: 'completed',
      accepted: parsed.rows.length,
      created,
      failed: errors.length,
      errors: errors.slice(0, 50),
      completed_at: new Date().toISOString(),
    });
    res.status(202).json({
      message: `Ingested ${created} of ${parsed.rows.length} asset rows`,
      job_id: job.id,
      accepted: parsed.rows.length,
      created,
      errors,
    });
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// Public reporting and public lookup
// ---------------------------------------------------------------------------

app.get('/v1/public/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const page = await client.records.list(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset, 0, 1_000_000) });
    res.json(page.items.map(publicAssetView));
  } catch (error) { next(error); }
});

app.get('/v1/public/assets/:code/qr-code', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const asset = await findRecord(client, dataset.id, req.params.code, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!asset) return res.status(404).json({ error: 'asset_not_found' });
    const view = publicAssetView(asset);
    res.json({ asset_code: view.asset_code, qr_code: view.qr_code, url: view.public_url });
  } catch (error) { next(error); }
});

app.get('/v1/public/assets/:code', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const asset = await findRecord(client, dataset.id, req.params.code, ['asset_code', 'feature_code', 'assetId', 'id']);
    if (!asset) return res.status(404).json({ error: 'asset_not_found' });
    res.json(publicAssetView(asset));
  } catch (error) { next(error); }
});

app.get('/v1/public/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const page = await client.records.list(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset, 0, 1_000_000) });
    res.json(page.items.map(incidentView).filter((incident) => incident.public_visible !== false).map(publicIncidentView));
  } catch (error) { next(error); }
});

app.post('/v1/public/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const body = privateInput(req);
    const incidentId = randomUUID();
    const number = incidentNumber();
    // Reporter contact details are kept only on the internal record and never
    // published. The public projection strips them at read time.
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
      ...(Array.isArray(body.photos) ? { photos: body.photos.map(String) } : {}),
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
    // Anonymous reports stay out of the open-data publication because they can
    // contain citizen contact details; the public API serves the sanitized view.
    await client.records.create(dataset.id, incident, { id: incidentId, publish: false });
    res.status(201).json(publicIncidentView(incidentView({ id: incidentId, data: incident })));
  } catch (error) { next(error); }
});

app.post('/v1/public/incidents/:incidentId/photos', async (req, res, next) => {
  try {
    const body = privateInput(req);
    const photos = Array.isArray(body.photos) ? body.photos.map(String).filter(Boolean) : [];
    if (photos.length === 0) return res.status(400).json({ error: 'photos_required', detail: 'Send { photos: string[] } (data URLs or public URLs).' });
    const existing = await findIncident(req, req.params.incidentId);
    if (!existing) return res.status(404).json({ error: 'incident_not_found' });
    const current = Array.isArray(existing.photos) ? existing.photos.map(String) : [];
    const updated = await updateIncident(req, req.params.incidentId, { photos: [...current, ...photos] });
    res.json(publicIncidentView(updated));
  } catch (error) { next(error); }
});

app.get('/v1/public/incidents/:incidentId', async (req, res, next) => {
  try {
    const incident = await findIncident(req, req.params.incidentId);
    if (!incident || incident.public_visible === false) return res.status(404).json({ error: 'incident_not_found' });
    res.json(publicIncidentView(incident));
  } catch (error) { next(error); }
});

// ---------------------------------------------------------------------------
// AI and map capability instances
// ---------------------------------------------------------------------------
app.get('/v1/map/config', (_req, res) => res.json(vietMapConfigured() ? { provider: 'vietmap', tileUrl: '/v1/map/tiles/{z}/{x}/{y}.png', attribution: '&copy; VIETMAP', maxZoom: 20, maxNativeZoom: 20, style: vietMapTileStyle() } : { provider: 'openstreetmap', tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 20, maxNativeZoom: 19 }));
app.get('/v1/map/tiles/:z/:x/:y.png', async (req, res, next) => { try { await proxyVietMapTile(Number(req.params.z), Number(req.params.x), Number(req.params.y), res); } catch (error) { next(error); } });
app.get('/v1/map/status', (_req, res) => res.json({ provider: vietMapConfigured() ? 'vietmap' : 'openstreetmap', configured: vietMapConfigured(), service: 'synapsecity' }));
app.get('/v1/ai/status', (_req, res) => res.json({ status: 'ready', service: 'synapsecity-ai', dependency: 'synapseone' }));
app.post('/v1/ai/chat', (_req, res) => res.json({ message: 'SynapseCity AI capability is available through the platform.', citations: [] }));

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
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: error?.message || 'internal_error', ...(error instanceof CapabilitiesError && error.body ? { upstream: error.body } : {}) });
});

export function createServer() { return app; }

if (require.main === module) {
  app.listen(PORT, () => console.log(`[synapsecity] Tier-3 API listening on :${PORT}; Tier-2=${TIER2_URL}`));
}
