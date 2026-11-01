// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CapabilitiesError } from '@synapsedx/capabilities';
import { DATASETS, TIER2_URL, capabilitiesFromRequest, ensureDataset, objectBody, requiredString } from './domain';
import { proxyVietMapTile, vietMapAutocomplete, vietMapConfigured, vietMapGeocode, vietMapPlace, vietMapReverse, vietMapTileStyle } from './vietmap';

const app = express();
const PORT = Number(process.env.PORT || 8083);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN || 'https://synapsecity.sbs';
  res.setHeader('access-control-allow-origin', origin);
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});
app.use((_req, res, next) => {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'DENY');
  next();
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
    incident_code: data.incident_code || data.incidentId || data.id,
    incident_number: data.incident_number || data.incidentId || data.id,
    asset_id: data.asset_id || data.assetId,
    reporter_type: data.reporter_type || 'admin',
    upvotes: data.upvotes || 0,
    comments: data.comments || [],
    reported_at: data.reported_at || data.occurredAt || data.created_at,
    created_at: data.created_at,
    updated_at: data.updated_at || data.created_at,
  };
}

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
  service: 'synapsecity', tier: 3, version: '0.1.0',
  domain: 'infrastructure',
  datasets: Object.values(DATASETS).map((dataset) => dataset.id),
  dependency: TIER2_URL,
}));

app.get('/v1/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const page = await client.records.list(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset, 0, 1_000_000) });
    res.json(page.items.map(assetView));
  } catch (error) { next(error); }
});

app.post('/v1/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const body = privateInput(req);
    const name = requiredString(body, 'name');
    const asset = {
      assetId: String(body.assetId || randomUUID()), name,
      assetType: requiredString(body, 'assetType'),
      status: String(body.status || 'active'),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.municipality !== undefined ? { municipality: String(body.municipality) } : {}),
      ...(body.owner !== undefined ? { owner: String(body.owner) } : {}),
      ...(body.metadata && typeof body.metadata === 'object' ? { metadata: body.metadata } : {}),
      source: 'synapsecity', sourceVersion: '1.0.0',
    };
    const created = await client.records.create(dataset.id, asset, { id: asset.assetId, publish: true });
    res.status(201).json(assetView(created));
  } catch (error) { next(error); }
});

app.get('/v1/assets/:id', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    res.json(assetView(await client.records.get(dataset.id, req.params.id)));
  } catch (error) { next(error); }
});

app.patch('/v1/assets/:id', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const body = privateInput(req);
    if (body.name !== undefined && !String(body.name).trim()) throw Object.assign(new Error('name_must_not_be_empty'), { status: 400 });
    const updated = await client.records.update(dataset.id, req.params.id, { ...body, source: 'synapsecity', updatedBy: 'domain-api' });
    res.json(assetView(updated));
  } catch (error) { next(error); }
});

app.get('/v1/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const page = await client.records.list(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset, 0, 1_000_000) });
    res.json(page.items.map(incidentView));
  } catch (error) { next(error); }
});

app.post('/v1/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    const body = privateInput(req);
    const incident = {
      incidentId: String(body.incidentId || randomUUID()),
      title: requiredString(body, 'title'),
      category: requiredString(body, 'category'),
      severity: String(body.severity || 'medium'),
      status: String(body.status || 'open'),
      ...(body.description !== undefined ? { description: String(body.description) } : {}),
      ...(body.location !== undefined ? { location: body.location } : {}),
      ...(body.assetId !== undefined ? { assetId: String(body.assetId) } : {}),
      occurredAt: String(body.occurredAt || new Date().toISOString()),
      source: 'synapsecity', sourceVersion: '1.0.0',
    };
    res.status(201).json(incidentView(await client.records.create(dataset.id, incident, { id: incident.incidentId, publish: true })));
  } catch (error) { next(error); }
});

// The remaining OpenInfra domain modules use the same Tier-2 records contract.
// They are deliberately thin domain adapters: SynapseCity owns the route and
// validation vocabulary while SynapseDX owns persistence, publication and
// queueing.
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
  const data = { ...input, id: recordId, created_at: input.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
  try { return recordData(await c.records.create(dataset.id, data, { id: recordId, publish: true })); }
  catch (error) {
    if (error instanceof CapabilitiesError && (error.status === 400 || error.status === 409)) return recordData(await c.records.update(dataset.id, recordId, data));
    throw error;
  }
}
async function genericUpdate(req: Request, key: GenericKey, id: string, patch: Record<string, unknown>): Promise<Record<string, unknown>> {
  const current = await genericGet(req, key, id);
  const c = capabilitiesFromRequest(req);
  return recordData(await c.records.update((await ensureDataset(c, genericSpec(key))).id, id, { ...current, ...patch, id, updated_at: new Date().toISOString() }));
}
function installGenericCrud(prefix: string, key: GenericKey): void {
  app.get(prefix, async (req, res, next) => { try { res.json(await genericList(req, key)); } catch (error) { next(error); } });
  app.get(`${prefix}/:id`, async (req, res, next) => { try { res.json(await genericGet(req, key, req.params.id)); } catch (error) { next(error); } });
  app.post(prefix, async (req, res, next) => { try { res.status(201).json(await genericWrite(req, key, genericBody(req))); } catch (error) { next(error); } });
  app.put(`${prefix}/:id`, async (req, res, next) => { try { res.json(await genericUpdate(req, key, req.params.id, genericBody(req))); } catch (error) { next(error); } });
}

installGenericCrud('/v1/maintenance', 'maintenance');
app.get('/v1/maintenance/upcoming', async (req, res, next) => { try { res.json(await genericList(req, 'maintenance')); } catch (error) { next(error); } });
app.get('/v1/maintenance/asset/:assetId', async (req, res, next) => { try { res.json((await genericList(req, 'maintenance')).filter((row) => String(row.asset_id || row.assetId || '') === req.params.assetId)); } catch (error) { next(error); } });
for (const action of ['assign', 'start', 'complete', 'cancel', 'photos']) {
  app.post(`/v1/maintenance/:id/${action}`, async (req, res, next) => { try { res.json(await genericUpdate(req, 'maintenance', req.params.id, { ...genericBody(req), ...(action === 'start' ? { status: 'in_progress' } : {}), ...(action === 'complete' ? { status: 'completed', completed_at: new Date().toISOString() } : {}), ...(action === 'cancel' ? { status: 'cancelled' } : {}) })); } catch (error) { next(error); } });
}

// IoT metadata and readings share two Tier-2 datasets.
installGenericCrud('/v1/iot/sensors', 'sensors');
app.delete('/v1/iot/sensors/:id', (_req, res) => res.status(204).end());
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

installGenericCrud('/v1/users', 'users');
app.get('/v1/users/me', async (req, res, next) => { try { const rows = await genericList(req, 'users'); res.json(rows[0] || { id: 'current-user', role: 'admin', status: 'active' }); } catch (error) { next(error); } });
app.get('/v1/users/technicians', async (req, res, next) => { try { res.json((await genericList(req, 'users')).filter((row) => row.role === 'technician')); } catch (error) { next(error); } });
app.get('/v1/users/volunteers', async (req, res, next) => { try { res.json((await genericList(req, 'users')).filter((row) => row.role === 'volunteer')); } catch (error) { next(error); } });

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
app.post('/v1/ingest/csv', async (req, res, next) => { try { res.status(202).json(await genericWrite(req, 'ingest', { ...genericBody(req), status: 'accepted', accepted_at: new Date().toISOString() })); } catch (error) { next(error); } });
app.get('/v1/map/config', (_req, res) => res.json(vietMapConfigured() ? { provider: 'vietmap', tileUrl: '/v1/map/tiles/{z}/{x}/{y}.png', attribution: '&copy; VIETMAP', maxZoom: 20, maxNativeZoom: 20, style: vietMapTileStyle() } : { provider: 'openstreetmap', tileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '&copy; OpenStreetMap contributors', maxZoom: 20, maxNativeZoom: 19 }));
app.get('/v1/map/tiles/:z/:x/:y.png', async (req, res, next) => { try { await proxyVietMapTile(Number(req.params.z), Number(req.params.x), Number(req.params.y), res); } catch (error) { next(error); } });
app.get('/v1/map/status', (_req, res) => res.json({ provider: vietMapConfigured() ? 'vietmap' : 'openstreetmap', configured: vietMapConfigured(), service: 'synapsecity' }));
app.get('/v1/ai/status', (_req, res) => res.json({ status: 'ready', service: 'synapsecity-ai', dependency: 'synapseone' }));
app.post('/v1/ai/chat', (_req, res) => res.json({ message: 'SynapseCity AI capability is available through the platform.', citations: [] }));

app.get('/v1/public/assets', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    res.json(await client.datasets.entities(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset, 0, 1_000_000) }));
  } catch (error) { next(error); }
});

app.get('/v1/public/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    res.json(await client.datasets.entities(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset, 0, 1_000_000) }));
  } catch (error) { next(error); }
});

app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = Number(error?.status || (error instanceof CapabilitiesError ? error.status : 500) || 500);
  res.status(status >= 400 && status < 600 ? status : 500).json({ error: error?.message || 'internal_error', ...(error instanceof CapabilitiesError && error.body ? { upstream: error.body } : {}) });
});

export function createServer() { return app; }

if (require.main === module) {
  app.listen(PORT, () => console.log(`[synapsecity] Tier-3 API listening on :${PORT}; Tier-2=${TIER2_URL}`));
}

