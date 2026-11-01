import express, { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { CapabilitiesError } from '@synapsedx/capabilities';
import { DATASETS, TIER2_URL, capabilitiesFromRequest, ensureDataset, objectBody, requiredString } from './domain';

const app = express();
const PORT = Number(process.env.PORT || 8083);
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  const origin = process.env.CORS_ORIGIN || '*';
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
    res.json(page);
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
    res.status(201).json(created);
  } catch (error) { next(error); }
});

app.get('/v1/assets/:id', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    res.json(await client.records.get(dataset.id, req.params.id));
  } catch (error) { next(error); }
});

app.patch('/v1/assets/:id', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.assets);
    const body = privateInput(req);
    if (body.name !== undefined && !String(body.name).trim()) throw Object.assign(new Error('name_must_not_be_empty'), { status: 400 });
    const updated = await client.records.update(dataset.id, req.params.id, { ...body, source: 'synapsecity', updatedBy: 'domain-api' });
    res.json(updated);
  } catch (error) { next(error); }
});

app.get('/v1/incidents', async (req, res, next) => {
  try {
    const client = capabilitiesFromRequest(req);
    const dataset = await ensureDataset(client, DATASETS.incidents);
    res.json(await client.records.list(dataset.id, { limit: numberParam(req.query.limit, 100, 500), offset: numberParam(req.query.offset, 0, 1_000_000) }));
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
    res.status(201).json(await client.records.create(dataset.id, incident, { id: incident.incidentId, publish: true }));
  } catch (error) { next(error); }
});

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

