// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { permissionsForRole, signToken, type SessionRole } from './auth';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-test-session-secret';

type StoredRecord = { id: string; data: Record<string, unknown> };
const datasets = new Map<string, Record<string, unknown>>();
const records = new Map<string, Map<string, Record<string, unknown>>>();
const publishedDatasets: string[] = [];
const writeRequests: Array<{ method: string; path: string; body: unknown }> = [];

// The Tier-3 login surface is retired; operator tests sign their sessions
// directly instead of authenticating through /v1/auth (which answers 410).
function tokenFor(role: SessionRole, username = 'qa'): string {
  return signToken({
    sub: `user-${username}`,
    username,
    email: `${username}@example.com`,
    full_name: username,
    role,
    permissions: permissionsForRole(role),
    typ: 'access',
  });
}

function recordsFor(datasetId: string): Map<string, Record<string, unknown>> {
  if (!records.has(datasetId)) records.set(datasetId, new Map());
  return records.get(datasetId) as Map<string, Record<string, unknown>>;
}

function seed(datasetId: string, id: string, data: Record<string, unknown>): void {
  recordsFor(datasetId).set(id, { ...data, id });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

function send(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

let fake: Server;
let city: Server;
let baseUrl: string;
let accessToken = '';

before(async () => {
  fake = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url || '/', 'http://fake');
    const path = url.pathname;
    if (req.method !== 'GET') writeRequests.push({ method: req.method || 'GET', path, body });

    if (path === '/health') return send(res, 200, { status: 'ok', service: 'fake-tier2' });

    const parts = path.split('/').filter(Boolean);
    // v1/capabilities/datasets/:id/(publish|records|entities)(/:recordId)
    if (parts[0] === 'v1' && parts[1] === 'capabilities' && parts[2] === 'datasets') {
      const datasetId = decodeURIComponent(parts[3] || '');
      if (parts.length === 4 && req.method === 'GET') {
        const dataset = datasets.get(datasetId);
        return dataset ? send(res, 200, dataset) : send(res, 404, { error: 'dataset_not_found' });
      }
      if (parts.length === 3 && req.method === 'POST') {
        const input = (body || {}) as Record<string, unknown>;
        const id = String(input.slug || '');
        const dataset = { ...input, id, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        datasets.set(id, dataset);
        return send(res, 201, dataset);
      }
      if (parts.length === 5 && parts[4] === 'publish' && req.method === 'POST') {
        const dataset = datasets.get(datasetId) || { id: datasetId };
        datasets.set(datasetId, { ...dataset, status: 'published' });
        publishedDatasets.push(datasetId);
        return send(res, 200, datasets.get(datasetId));
      }
      if (parts.length === 5 && parts[4] === 'entities' && req.method === 'GET') {
        return send(res, 200, Array.from(recordsFor(datasetId).values()));
      }
      if (parts.length === 5 && parts[4] === 'records' && req.method === 'GET') {
        const items = Array.from(recordsFor(datasetId).entries()).map(([id, data]) => ({ id, data }));
        const limit = Number(url.searchParams.get('limit') || 100);
        const offset = Number(url.searchParams.get('offset') || 0);
        return send(res, 200, { items: items.slice(offset, offset + limit), total: items.length, limit, offset });
      }
      if (parts.length === 6 && parts[4] === 'records' && parts[5] === 'query' && req.method === 'POST') {
        const input = (body || {}) as { where?: unknown; orderBy?: unknown; limit?: number; offset?: number };
        const where = input.where as any;
        const matches = (data: Record<string, unknown>, node: any): boolean => {
          if (!node || typeof node !== 'object') return true;
          if (Array.isArray(node.and)) return node.and.every((entry: any) => matches(data, entry));
          if (Array.isArray(node.or)) return node.or.some((entry: any) => matches(data, entry));
          for (const [key, expected] of Object.entries(node)) {
            const actual = (data as Record<string, unknown>)[key];
            if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
              for (const [op, value] of Object.entries(expected as Record<string, unknown>)) {
                if (op === 'exists') { if ((actual !== undefined) !== Boolean(value)) return false; continue; }
                if (op === 'nin') { if (Array.isArray(value) && value.map(String).includes(String(actual ?? ''))) return false; continue; }
                if (op === 'in') { if (!(Array.isArray(value) && value.map(String).includes(String(actual ?? '')))) return false; continue; }
                if (String(actual ?? '') !== String(value ?? '')) return false;
              }
            } else if (String(actual ?? '') !== String(expected ?? '')) {
              return false;
            }
          }
          return true;
        };
        const filtered = Array.from(recordsFor(datasetId).entries())
          .map(([id, data]) => ({ id, data }))
          .filter(({ data }) => matches(data as Record<string, unknown>, where));
        const orderBy = typeof input.orderBy === 'string' ? input.orderBy : '';
        const [orderField, orderDirection] = orderBy.split(':');
        const ordered = orderField
          ? [...filtered].sort((a, b) => {
            const left = String((a.data as Record<string, unknown>)[orderField] ?? '');
            const right = String((b.data as Record<string, unknown>)[orderField] ?? '');
            if (left === right) return 0;
            return (left < right ? -1 : 1) * (orderDirection === 'desc' ? -1 : 1);
          })
          : filtered;
        const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 1000);
        const offset = Math.max(Number(input.offset) || 0, 0);
        return send(res, 200, { items: ordered.slice(offset, offset + limit), total: ordered.length, limit, offset });
      }
      if (parts.length === 6 && parts[4] === 'records' && parts[5] === 'bulk' && req.method === 'POST') {
        const input = (body || {}) as { records?: Array<{ id?: string; data?: Record<string, unknown> }> };
        const created: Array<{ id: string; data: Record<string, unknown> }> = [];
        const errors: Array<{ index: number; code: string; message: string }> = [];
        for (const [index, entry] of (input.records || []).entries()) {
          const id = String(entry.id || `record-${recordsFor(datasetId).size + 1}`);
          if (recordsFor(datasetId).has(id)) {
            errors.push({ index, code: 'record_already_exists', message: 'record exists' });
            continue;
          }
          const data = { ...(entry.data || {}), id };
          recordsFor(datasetId).set(id, data);
          created.push({ id, data });
        }
        return send(res, 201, { created, errors });
      }
      if (parts.length === 5 && parts[4] === 'records' && req.method === 'POST') {
        const input = (body || {}) as { id?: string; data?: Record<string, unknown> };
        const id = String(input.id || `record-${recordsFor(datasetId).size + 1}`);
        if (recordsFor(datasetId).has(id)) return send(res, 409, { error: 'record_exists' });
        const data = { ...(input.data || {}), id };
        recordsFor(datasetId).set(id, data);
        return send(res, 201, { id, data });
      }
      if (parts.length === 6 && parts[4] === 'records' && req.method === 'GET') {
        const recordId = decodeURIComponent(parts[5]);
        const data = recordsFor(datasetId).get(recordId);
        return data ? send(res, 200, { id: recordId, data }) : send(res, 404, { error: 'record_not_found' });
      }
      if (parts.length === 6 && parts[4] === 'records' && req.method === 'PATCH') {
        const recordId = decodeURIComponent(parts[5]);
        const input = (body || {}) as { data?: Record<string, unknown> };
        const data = { ...(input.data || {}), id: recordId };
        recordsFor(datasetId).set(recordId, data);
        return send(res, 200, { id: recordId, data });
      }
    }
    return send(res, 404, { error: 'not_found' });
  });
  await new Promise<void>((resolve, reject) => {
    fake.listen(0, '127.0.0.1', () => resolve());
    fake.once('error', reject);
  });
  process.env.SYNAPSEDX_BASE_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

  seed('city-users', 'someone-else', {
    id: 'someone-else', username: 'first-row', email: 'first@example.com', full_name: 'First Row',
    role: 'technician', status: 'active', password: 'must-never-leak',
  });
  seed('city-assets', 'asset-1', {
    id: 'asset-1', asset_code: 'ASSET-1', name: 'Main Street Lamp', feature_type: 'street_light',
    feature_code: 'den_duong', category: 'lighting', status: 'active',
    geometry: { type: 'Point', coordinates: [105.8342, 21.0278] },
    location: { address: 'Hanoi', coordinates: { longitude: 105.8342, latitude: 21.0278 } },
    condition: 'good',
  });
  seed('city-incidents', 'inc-1', {
    id: 'inc-1', incident_number: 'INC-2026-ABC123', incident_code: 'INC-2026-ABC123',
    title: 'Broken lamp', description: 'Lamp is dark', category: 'malfunction', severity: 'medium',
    status: 'reported', reporter_type: 'citizen', asset_id: 'asset-1', upvotes: 0, comments: [], photos: [],
    public_visible: true, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  seed('city-maintenance', 'maint-1', {
    id: 'maint-1', asset_id: 'asset-1', title: 'Scheduled inspection', status: 'scheduled',
    scheduled_date: new Date(Date.now() + 86_400_000).toISOString(),
  });

  const serviceModule = await import('./server');
  city = serviceModule.createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    city.once('listening', resolve);
    city.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(city.address() as AddressInfo).port}`;
});

after(async () => {
  for (const server of [city, fake]) {
    if (!server) continue;
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

async function request(path: string, init: RequestInit = {}, options: { anonymous?: boolean } = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const headers = new Headers(init.headers);
  if (!options.anonymous && accessToken && !headers.has('authorization')) {
    headers.set('authorization', `Bearer ${accessToken}`);
  }
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function json(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

test('the retired auth surface answers 410 workspace_moved for every path', async () => {
  const probes: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'POST', path: '/v1/auth/login', body: { username: 'qa', password: 'qa-secret' } },
    { method: 'POST', path: '/v1/auth/register', body: { username: 'citizen1', email: 'citizen@example.com', password: 'secret123', full_name: 'Citizen One', phone: '0900000000' } },
    { method: 'POST', path: '/v1/auth/refresh', body: { refresh_token: 'anything' } },
    { method: 'POST', path: '/v1/auth/logout', body: {} },
    { method: 'POST', path: '/v1/auth/change-password', body: { current_password: 'old', new_password: 'new-secret' } },
    { method: 'GET', path: '/v1/auth/me' },
    { method: 'GET', path: '/v1/auth/verify' },
    { method: 'DELETE', path: '/v1/auth/unknown' },
  ];
  for (const probe of probes) {
    const response = await request(probe.path, json(probe.method, probe.body));
    assert.equal(response.status, 410, `${probe.method} ${probe.path}`);
    assert.equal(response.body.error, 'workspace_moved');
    assert.equal(response.body.workspace_url, 'https://synapsedx.sbs/workspace');
    assert.equal(response.body.access_token, undefined, 'no session may be minted');
    assert.equal(response.body.refresh_token, undefined, 'no session may be minted');
  }
  // No credential may reach Tier-2 through the retired surface.
  assert.equal(JSON.stringify(writeRequests).includes('qa-secret'), false);
  assert.equal(JSON.stringify(writeRequests).includes('secret123'), false);
});

test('operator flows use a locally signed admin session', async () => {
  accessToken = tokenFor('admin', 'qa');
  const me = await request('/v1/users/me', json('GET', undefined, accessToken));
  assert.equal(me.status, 200);
  assert.equal(me.body.username, 'qa');
  assert.equal(me.body.id, 'user-qa');
});

test('/v1/users requires a session and returns 401, never 404', async () => {
  const list = await request('/v1/users', {}, { anonymous: true });
  assert.equal(list.status, 401);
  for (const path of ['/v1/users/me', '/v1/users/technicians', '/v1/users/volunteers']) {
    const response = await request(path, {}, { anonymous: true });
    assert.equal(response.status, 401, `${path} must be 401 without a session, not 404`);
  }
});

test('/v1/users/me returns the token principal, not the first dataset row', async () => {
  const response = await request('/v1/users/me', json('GET', undefined, accessToken));
  assert.equal(response.status, 200);
  assert.equal(response.body.username, 'qa');
  assert.equal(response.body.id, 'user-qa');
  assert.notEqual(response.body.username, 'first-row');
});

test('authorized operators can list users and password fields are stripped', async () => {
  const response = await request('/v1/users', json('GET', undefined, accessToken));
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body));
  assert.ok(response.body.some((user: Record<string, unknown>) => user.username === 'first-row'));
  assert.equal(JSON.stringify(response.body).includes('must-never-leak'), false);
});

test('POST /v1/users rejects a password and still works without one', async () => {
  const rejected = await request('/v1/users', json('POST', {
    username: 'qa2', email: 'qa2@example.com', password: 'secret', full_name: 'QA Two', role: 'technician',
  }, accessToken));
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error, 'password_is_managed_by_auth_shell');
  assert.equal(JSON.stringify(writeRequests).includes('"secret"'), false, 'rejected password must not be written to Tier-2');

  const created = await request('/v1/users', json('POST', {
    username: 'qa2', email: 'qa2@example.com', full_name: 'QA Two', role: 'technician',
  }, accessToken));
  assert.equal(created.status, 201);
  assert.equal(created.body.username, 'qa2');
  assert.equal('password' in created.body, false);

  const technicians = await request('/v1/users/technicians', json('GET', undefined, accessToken));
  assert.equal(technicians.status, 200);
  assert.ok(technicians.body.some((user: Record<string, unknown>) => user.username === 'qa2'));
  assert.equal(JSON.stringify(technicians.body).includes('must-never-leak'), false);

  const volunteers = await request('/v1/users/volunteers', json('GET', undefined, accessToken));
  assert.equal(volunteers.status, 200);
  assert.ok(Array.isArray(volunteers.body));
});

test('city-users is created private and never published', async () => {
  assert.equal(datasets.has('city-users'), true);
  assert.equal(datasets.get('city-users')?.public, false);
  assert.equal(publishedDatasets.includes('city-users'), false);
  assert.equal(datasets.get('city-users')?.status, 'draft');
});

test('profile update and user delete stay sanitized', async () => {
  const updated = await request('/v1/users/me', json('PUT', { full_name: 'QA Operator', email: 'qa@example.com' }, accessToken));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.full_name, 'QA Operator');

  const deleted = await request('/v1/users/someone-else', json('DELETE', undefined, accessToken));
  assert.equal(deleted.status, 204);
  const afterDelete = await request('/v1/users/someone-else', json('GET', undefined, accessToken));
  assert.equal(afterDelete.status, 200);
  assert.equal(afterDelete.body.status, 'inactive');
  assert.equal('password' in afterDelete.body, false);
});

test('public asset lookup and QR code routes work by asset code', async () => {
  const asset = await request('/v1/public/assets/ASSET-1');
  assert.equal(asset.status, 200);
  assert.equal(asset.body.asset_code, 'ASSET-1');
  assert.equal(asset.body.location.coordinates.latitude, 21.0278);
  assert.equal(typeof asset.body.qr_code, 'string');
  assert.match(asset.body.qr_code, /^https:\/\/synapsecity\.sbs\/asset\//);
  // Only public projection datasets are published.
  assert.equal(datasets.get('city-assets')?.public, true);
  assert.equal(publishedDatasets.includes('city-assets'), true);

  const qr = await request('/v1/public/assets/ASSET-1/qr-code');
  assert.equal(qr.status, 200);
  assert.equal(qr.body.asset_code, 'ASSET-1');
  assert.equal(typeof qr.body.url, 'string');

  const missing = await request('/v1/public/assets/UNKNOWN-ASSET');
  assert.equal(missing.status, 404);
});

test('anonymous public reporting creates a retrievable incident and accepts photos', async () => {
  const created = await request('/v1/public/incidents', json('POST', {
    title: 'Pothole on Main Street',
    description: 'A large pothole near the school',
    category: 'damage',
    severity: 'high',
    location: { address: 'Main Street' },
    contact_info: { name: 'Citizen', phone_number: '0900000000', id_card_number: '001234567890' },
  }));
  assert.equal(created.status, 201);
  assert.match(created.body.incident_number, /^INC-\d{4}-[A-Z0-9]{6}$/);
  assert.equal(created.body.reporter_type, 'citizen');
  assert.equal(created.body.status, 'reported');
  assert.equal(created.body.contact_info, undefined);
  assert.equal(JSON.stringify(created.body).includes('001234567890'), false);

  const number = created.body.incident_number;
  const lookup = await request(`/v1/public/incidents/${encodeURIComponent(number)}`);
  assert.equal(lookup.status, 200);
  assert.equal(lookup.body.title, 'Pothole on Main Street');
  // The report edit capability is returned once to the creator and never
  // appears in the public read projection.
  assert.equal(typeof created.body.edit_token, 'string');
  assert.equal(lookup.body.edit_token, undefined);

  // The incident id alone is not a capability: anonymous appends without the
  // edit token are rejected before any Tier-2 lookup.
  const denied = await request(`/v1/public/incidents/${created.body.id}/photos`, json('POST', {
    photos: ['https://files.synapsedx.sbs/incidents/photo-1.png'],
  }), { anonymous: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error, 'report_edit_token_required');

  // External URLs are rejected even with a valid token: anonymous reports
  // accept City public file ids only.
  const external = await request(`/v1/public/incidents/${created.body.id}/photos`, json('POST', {
    photos: ['https://files.synapsedx.sbs/incidents/photo-1.png'],
    edit_token: created.body.edit_token,
  }), { anonymous: true });
  assert.equal(external.status, 400);
  assert.equal(external.body.error, 'public_photo_file_id_required');

  // A follow-up upload stamps the file with the report it belongs to (the
  // X-Report-Id + edit-token upload path); the append then accepts it.
  seed('city-files', 'photo-file-1', {
    id: 'photo-file-1', filename: 'pothole.png', contentType: 'image/png', size: 12,
    checksumSha256: '0'.repeat(64), owner: 'anonymous', public: true,
    report_id: created.body.id,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    source: 'synapsecity', storage: 'tier2-files',
  });
  const photos = await request(`/v1/public/incidents/${created.body.id}/photos`, json('POST', {
    file_ids: ['photo-file-1'],
    edit_token: created.body.edit_token,
  }), { anonymous: true });
  assert.equal(photos.status, 200);
  assert.equal(photos.body.photos.length, 1);
  assert.match(photos.body.photos[0], /\/v1\/public\/files\/photo-file-1\/content$/);

  const list = await request('/v1/public/incidents');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body));
  assert.equal(JSON.stringify(list.body).includes('0900000000'), false);

  const missing = await request('/v1/public/incidents/DOES-NOT-EXIST');
  assert.equal(missing.status, 404);
});

test('incident detail and workflow routes operate on Tier-2 records', async () => {
  const detail = await request('/v1/incidents/inc-1');
  assert.equal(detail.status, 200);
  assert.equal(detail.body.title, 'Broken lamp');

  const byNumber = await request('/v1/incidents/INC-2026-ABC123');
  assert.equal(byNumber.status, 200);
  assert.equal(byNumber.body.id, 'inc-1');

  const upvoted = await request('/v1/incidents/inc-1/upvote', json('POST', {}, accessToken));
  assert.equal(upvoted.status, 200);
  assert.equal(upvoted.body.upvotes, 1);

  const commented = await request('/v1/incidents/inc-1/comments', json('POST', { comment: 'Inspector assigned', is_internal: true }, accessToken));
  assert.equal(commented.status, 200);
  assert.equal(commented.body.comments.length, 1);
  assert.equal(commented.body.comments[0].comment, 'Inspector assigned');

  const assigned = await request('/v1/incidents/inc-1/assign?assigned_to=tech-1', json('POST', {}, accessToken));
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.status, 'assigned');
  assert.equal(assigned.body.assigned_to, 'tech-1');

  const resolved = await request('/v1/incidents/inc-1/resolve?resolution_notes=fixed&resolution_type=fixed', json('POST', {}, accessToken));
  assert.equal(resolved.status, 200);
  assert.equal(resolved.body.status, 'resolved');
  assert.equal(resolved.body.resolution_notes, 'fixed');

  const maintenance = await request('/v1/incidents/inc-1/create-maintenance', json('POST', {}, accessToken));
  assert.equal(maintenance.status, 201);
  assert.equal(typeof maintenance.body.maintenance_id, 'string');

  const related = await request('/v1/incidents/inc-1/related');
  assert.equal(related.status, 200);
  assert.ok(Array.isArray(related.body));

  const unknown = await request('/v1/incidents/unknown-incident');
  assert.equal(unknown.status, 404);
  const unknownAction = await request('/v1/incidents/unknown-incident/upvote', json('POST', {}, accessToken));
  assert.equal(unknownAction.status, 404);
});

test('incident merge closes duplicates and records the merge on the primary', async () => {
  const duplicate = await request('/v1/incidents', json('POST', {
    title: 'Duplicate lamp report', category: 'malfunction', description: 'same lamp', asset_id: 'asset-1',
  }, accessToken));
  assert.equal(duplicate.status, 201);
  const duplicateId = duplicate.body.id;

  const merged = await request('/v1/incidents/inc-1/merge', json('POST', { duplicate_ids: [duplicateId], merge_notes: 'same asset' }, accessToken));
  assert.equal(merged.status, 200);
  assert.ok(merged.body.merged_reporter_ids.includes(duplicateId));

  const duplicateAfter = await request(`/v1/incidents/${duplicateId}`);
  assert.equal(duplicateAfter.body.resolution_type, 'duplicate');
  assert.equal(duplicateAfter.body.status, 'closed');

  const suggestions = await request('/v1/incidents/inc-1/merge-suggestions');
  assert.equal(suggestions.status, 200);
  assert.deepEqual(suggestions.body, []);
  const missingSuggestion = await request('/v1/incidents/merge-suggestions/nope/approve', json('POST', {}, accessToken));
  assert.equal(missingSuggestion.status, 404);
});

test('maintenance upcoming route is not shadowed by the generic :id route', async () => {
  const upcoming = await request('/v1/maintenance/upcoming');
  assert.equal(upcoming.status, 200);
  assert.ok(Array.isArray(upcoming.body));
  assert.ok(upcoming.body.some((order: Record<string, unknown>) => order.id === 'maint-1'));

  const assetOrders = await request('/v1/maintenance/asset/asset-1');
  assert.equal(assetOrders.status, 200);
  assert.ok(Array.isArray(assetOrders.body));

  const photos = await request('/v1/maintenance/maint-1/photos', json('POST', {
    attachments: [{ file_name: 'before.jpg', file_url: 'https://files.synapsedx.sbs/maintenance/before.jpg', file_type: 'image/jpeg' }],
  }, accessToken));
  assert.equal(photos.status, 200);
  assert.equal(photos.body.attachments.length, 1);
});

test('asset update, lifecycle, documents, health, reports and soft delete work', async () => {
  const updated = await request('/v1/assets/asset-1', json('PUT', { name: 'Main Street Lamp (updated)' }, accessToken));
  assert.equal(updated.status, 200);
  assert.equal(updated.body.name, 'Main Street Lamp (updated)');

  const lifecycle = await request('/v1/assets/asset-1/lifecycle-status', json('PUT', { lifecycle_status: 'under_repair' }, accessToken));
  assert.equal(lifecycle.status, 200);
  assert.equal(lifecycle.body.lifecycle.lifecycle_status, 'under_repair');

  const health = await request('/v1/assets/asset-1/health-score');
  assert.equal(health.status, 200);
  assert.equal(typeof health.body.health_score, 'number');
  assert.ok(health.body.breakdown.condition_score >= 0);

  const emptyDocuments = await request('/v1/assets/asset-1/documents');
  assert.equal(emptyDocuments.status, 200);
  assert.ok(Array.isArray(emptyDocuments.body));

  const document = await request('/v1/assets/asset-1/documents', json('POST', {
    file_name: 'manual.pdf', file_url: 'https://files.synapsedx.sbs/assets/manual.pdf', file_type: 'application/pdf', document_type: 'manual', is_public: true,
  }, accessToken));
  assert.equal(document.status, 201);
  assert.equal(document.body.file_name, 'manual.pdf');

  const documents = await request('/v1/assets/asset-1/documents');
  assert.equal(documents.body.length, 1);

  const removed = await request(`/v1/assets/asset-1/attachments/${encodeURIComponent('https://files.synapsedx.sbs/assets/manual.pdf')}`, json('DELETE', undefined, accessToken));
  assert.equal(removed.status, 204);

  const photos = await request('/v1/assets/asset-1/photos', json('POST', {
    photos: ['https://files.synapsedx.sbs/assets/lamp.png'], file_name: 'lamp.png', file_type: 'image/png',
  }, accessToken));
  assert.equal(photos.status, 200);
  assert.equal(photos.body.photos.length, 1);

  const report = await request('/v1/assets/asset-1/reports', json('POST', { report_type: 'maintenance_summary', format: 'csv' }, accessToken));
  assert.equal(report.status, 201);
  assert.match(report.body.report_url, /\/v1\/reports\//);
  assert.ok(report.body.row_count >= 1, 'the report must contain rows from city-maintenance');

  const download = await request(`/v1/reports/${report.body.report_id}/download`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') || '', /text\/csv/);
  assert.match(String(download.body), /work_order_id,asset_id,title/);
  assert.match(String(download.body), /Scheduled inspection/);

  const removedAsset = await request('/v1/assets/asset-1', json('DELETE', undefined, accessToken));
  assert.equal(removedAsset.status, 204);
  const deletedAsset = await request('/v1/assets/asset-1');
  assert.equal(deletedAsset.status, 200);
  assert.equal(deletedAsset.body.status, 'decommissioned');
});

test('CSV ingest parses rows and creates City assets through Tier-2', async () => {
  const content = [
    'asset_code,name,feature_type,feature_code,latitude,longitude,category,status,address,properties',
    'CSV-1,CSV Lamp,street_light,den_duong,21.01,105.81,lighting,active,"1 Main St","{""lumens"":1200}"',
    'CSV-2,CSV Hydrant,hydrant,tru_chua_chay,21.02,105.82,water,active,2 Main St,{}',
    'BAD-1,Bad Row,street_light,den_duong,not-a-number,105.83,lighting,active,3 Main St,{}',
  ].join('\n');
  const response = await request('/v1/ingest/csv', json('POST', { filename: 'assets.csv', content }, accessToken));
  assert.equal(response.status, 202);
  assert.equal(response.body.accepted, 3);
  assert.equal(response.body.created, 2);
  assert.equal(response.body.errors.length, 1);
  assert.match(response.body.message, /Ingested 2 of 3/);

  const assets = await request('/v1/assets');
  assert.equal(assets.status, 200);
  assert.ok(assets.body.some((asset: Record<string, unknown>) => asset.asset_code === 'CSV-1'));
  const csvAsset = assets.body.find((asset: Record<string, unknown>) => asset.asset_code === 'CSV-1');
  assert.equal(csvAsset.properties.lumens, 1200);
  assert.deepEqual(csvAsset.geometry.coordinates, [105.81, 21.01]);

  const missing = await request('/v1/ingest/csv', json('POST', { filename: 'bad.csv', content: 'name,latitude\nx,1' }, accessToken));
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'missing_columns');
});

test('unknown /v1 namespaces still return the exact 404 body', async () => {
  const response = await request('/v1/unknown');
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: 'not_found', product: 'synapsecity' });
});
