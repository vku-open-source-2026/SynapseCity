// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-public-contract-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let adminToken: string;
let auth: typeof import('./auth');

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, init);
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

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;

  tier2.seed('city-assets', 'asset-active', {
    id: 'asset-active', asset_code: 'ACTIVE-1', name: 'Active lamp', feature_type: 'street_light',
    feature_code: 'den_duong', category: 'lighting', status: 'active',
    geometry: { type: 'Point', coordinates: [105.8342, 21.0278] },
    location: { address: 'Hanoi', coordinates: { longitude: 105.8342, latitude: 21.0278 } },
  });
  tier2.seed('city-assets', 'asset-decommissioned', {
    id: 'asset-decommissioned', asset_code: 'OLD-1', name: 'Old lamp', feature_type: 'street_light',
    feature_code: 'den_duong', status: 'decommissioned', geometry: { type: 'Point', coordinates: [105.8, 21.0] },
  });
  tier2.seed('city-assets', 'asset-deleted', {
    id: 'asset-deleted', asset_code: 'DEL-1', name: 'Deleted lamp', feature_type: 'street_light',
    feature_code: 'den_duong', status: 'active', deleted_at: new Date().toISOString(),
    geometry: { type: 'Point', coordinates: [105.8, 21.0] },
  });
  tier2.seed('city-assets', 'asset-hidden', {
    id: 'asset-hidden', asset_code: 'HIDDEN-1', name: 'Hidden asset', feature_type: 'hydrant',
    feature_code: 'tru_chua_chay', status: 'active', public_visible: false,
    geometry: { type: 'Point', coordinates: [105.8, 21.0] },
  });

  tier2.seed('city-incidents', 'inc-private', {
    id: 'inc-private', incident_number: 'INC-2026-PRIV01', incident_code: 'INC-2026-PRIV01',
    title: 'Hidden incident', description: 'not public', category: 'damage', severity: 'low',
    status: 'reported', reporter_type: 'citizen', public_visible: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  tier2.seed('city-incidents', 'inc-deleted', {
    id: 'inc-deleted', incident_number: 'INC-2026-DEL001', incident_code: 'INC-2026-DEL001',
    title: 'Deleted incident', description: 'deleted', category: 'damage', severity: 'low',
    status: 'reported', reporter_type: 'citizen', deleted_at: new Date().toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  tier2.seed('city-maintenance', 'maint-1', {
    id: 'maint-1', asset_id: 'asset-active', title: 'Completed repair', status: 'completed',
    type: 'corrective', assigned_to: 'operator-internal', completed_at: new Date().toISOString(),
    resolution_notes: 'internal-only maintenance note',
    scheduled_date: new Date().toISOString(),
  });
  tier2.seed('city-maintenance', 'maint-2', {
    id: 'maint-2', asset_id: 'asset-active', title: 'Scheduled inspection', status: 'scheduled',
    assigned_to: 'operator-internal', scheduled_date: new Date(Date.now() + 86_400_000).toISOString(),
  });

  auth = await import('./auth');
  adminToken = auth.signToken({
    sub: 'user-admin', username: 'admin', email: 'admin@example.com', full_name: 'Admin',
    role: 'admin', permissions: ['*'], typ: 'access',
  });
  const service = await import('./server');
  server = service.createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (tier2) await tier2.close();
});

test('public assets exclude deleted, decommissioned and non-public records', async () => {
  const list = await request('/v1/public/assets');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('x-total-count'), '1');
  assert.deepEqual((list.body as Array<{ asset_code: string }>).map((asset) => asset.asset_code), ['ACTIVE-1']);

  // A retired asset is hidden from the default list but remains addressable by
  // code so a full-inventory map can still open its detail page.
  assert.equal((await request('/v1/public/assets/OLD-1')).status, 200);
  assert.equal((await request('/v1/public/assets/OLD-1/qr-code')).status, 200);
  for (const code of ['DEL-1', 'HIDDEN-1']) {
    const response = await request(`/v1/public/assets/${code}`);
    assert.equal(response.status, 404, `${code} must not be publicly visible`);
    assert.equal((await request(`/v1/public/assets/${code}/qr-code`)).status, 404);
  }

  const active = await request('/v1/public/assets/ACTIVE-1');
  assert.equal(active.status, 200);
  for (const field of ['id', 'asset_code', 'name', 'feature_type', 'category', 'status', 'location', 'qr_code', 'public_url']) {
    assert.ok(field in active.body, `public asset contract must include ${field}`);
  }
  assert.equal('@context' in active.body, false, 'the documented contract is not NGSI-LD');
});

test('the public map can request the complete inventory including retired assets', async () => {
  const list = await request('/v1/public/assets?include_inactive=true');
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('x-total-count'), '2');
  assert.deepEqual(
    (list.body as Array<{ asset_code: string }>).map((asset) => asset.asset_code).sort(),
    ['ACTIVE-1', 'OLD-1'],
  );
});

test('an operator incident never writes reporter identity or internal comments to the public dataset', async () => {

  const created = await request('/v1/incidents', json('POST', {
    title: 'Operator incident', description: 'Lamp damaged', category: 'damage', severity: 'high',
    asset_id: 'asset-active',
    reported_by: 'operator-jane',
    contact_info: { name: 'Jane', phone_number: '0900000001', id_card_number: '001234567890' },
  }, adminToken));
  assert.equal(created.status, 201);
  const incidentId = created.body.id;

  const commented = await request(`/v1/incidents/${incidentId}/comments`, json('POST', {
    comment: 'internal-only note', is_internal: true,
  }, adminToken));
  assert.equal(commented.status, 200);
  const publicComment = await request(`/v1/incidents/${incidentId}/comments`, json('POST', {
    comment: 'Public update', is_internal: false,
  }, adminToken));
  assert.equal(publicComment.status, 200);

  const stored = tier2.records.get('city-incidents')?.get(String(incidentId)) as Record<string, unknown>;
  assert.ok(stored, 'the incident must be stored in city-incidents');
  const serialized = JSON.stringify(stored);
  assert.equal('reported_by' in stored, false, 'reported_by must not reach the public dataset');
  assert.equal('contact_info' in stored, false, 'contact_info must not reach the public dataset');
  assert.equal(serialized.includes('operator-jane'), false);
  assert.equal(serialized.includes('0900000001'), false);
  assert.equal(serialized.includes('001234567890'), false);
  assert.equal(serialized.includes('internal-only note'), false, 'internal comments must not reach the public dataset');
  assert.equal(serialized.includes('Public update'), true, 'public comments are part of the projection');

  const sidecar = tier2.records.get('city-incident-internal')?.get(`internal-${String(incidentId)}`) as Record<string, unknown>;
  assert.ok(sidecar, 'reporter identity must be stored in the private sidecar');
  assert.equal(sidecar.reported_by, 'operator-jane');
  assert.equal(JSON.stringify(sidecar).includes('internal-only note'), true);

  // The operator view is reassembled from the public record + sidecar.
  const operatorView = await request(`/v1/incidents/${incidentId}`, json('GET', undefined, adminToken));
  assert.equal(operatorView.status, 200);
  assert.equal(operatorView.body.reported_by, 'operator-jane');
  assert.equal(operatorView.body.comments.length, 2);

  // The anonymous public view never exposes them.
  const publicView = await request(`/v1/public/incidents/${incidentId}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.reported_by, undefined);
  assert.equal(publicView.body.contact_info, undefined);
  assert.equal(JSON.stringify(publicView.body).includes('internal-only note'), false);
  assert.equal(publicView.body.comments.length, 1);
});

test('citizen reports keep contact data in the private sidecar and publish:false', async () => {
  const created = await request('/v1/public/incidents', json('POST', {
    title: 'Pothole', description: 'Big pothole', category: 'damage',
    contact_info: { name: 'Citizen', phone_number: '0900000009', id_card_number: '009999999999' },
  }));
  assert.equal(created.status, 201);
  assert.equal(created.body.contact_info, undefined);

  const id = String(created.body.incidentId || created.body.id);
  const stored = tier2.records.get('city-incidents')?.get(id) as Record<string, unknown>;
  assert.ok(stored);
  assert.equal(JSON.stringify(stored).includes('0900000009'), false);
  assert.equal(JSON.stringify(stored).includes('009999999999'), false);

  const requestRecord = [...tier2.createRequests].reverse().find((entry) => entry.datasetId === 'city-incidents');
  assert.ok(requestRecord, 'a city-incidents create request must be recorded');
  assert.equal(requestRecord.publish, false, 'anonymous reports must be withheld from publication');

  const sidecar = tier2.records.get('city-incident-internal')?.get(`internal-${id}`) as Record<string, unknown>;
  assert.ok(sidecar);
  assert.equal((sidecar.contact_info as Record<string, unknown>).phone_number, '0900000009');
});

test('public incident list excludes non-public and deleted records', async () => {
  const list = await request('/v1/public/incidents');
  assert.equal(list.status, 200);
  const ids = (list.body as Array<Record<string, unknown>>).map((incident) => incident.id);
  assert.equal(ids.includes('inc-private'), false);
  assert.equal(ids.includes('inc-deleted'), false);
  assert.equal((await request('/v1/public/incidents/inc-private')).status, 404);
  assert.equal((await request('/v1/public/incidents/inc-deleted')).status, 404);
});

test('the public maintenance summary exposes aggregates only', async () => {
  const summary = await request('/v1/public/assets/ACTIVE-1/maintenance-summary');
  assert.equal(summary.status, 200);
  assert.equal(summary.body.work_order_count, 2);
  assert.equal(summary.body.completed_count, 1);
  assert.equal(summary.body.last_maintenance_type, 'corrective');
  const serialized = JSON.stringify(summary.body);
  assert.equal(serialized.includes('operator-internal'), false, 'assignee identity must not be public');
  assert.equal(serialized.includes('internal-only maintenance note'), false);
  assert.equal((await request('/v1/public/assets/OLD-1/maintenance-summary')).status, 200);
});

test('data URLs are rejected for asset attachments and public incident photos', async () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const photo = await request('/v1/assets/asset-active/photos', json('POST', { photos: [dataUrl] }, adminToken));
  assert.equal(photo.status, 415);
  assert.equal(photo.body.error, 'data_url_not_supported');
  assert.equal(JSON.stringify(tier2.records.get('city-assets')?.get('asset-active')).includes('data:image'), false);

  const publicPhoto = await request('/v1/public/incidents/inc-private/photos', json('POST', { photos: [dataUrl] }));
  assert.equal(publicPhoto.status, 415);

  const document = await request('/v1/assets/asset-active/documents', json('POST', {
    file_name: 'manual.pdf', file_url: dataUrl, file_type: 'application/pdf',
  }, adminToken));
  assert.equal(document.status, 415);

  // A stored HTTPS reference is accepted and only the reference is persisted.
  const accepted = await request('/v1/assets/asset-active/documents', json('POST', {
    file_name: 'manual.pdf', file_url: 'https://files.synapsedx.sbs/assets/manual.pdf', file_type: 'application/pdf',
  }, adminToken));
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.file_url, 'https://files.synapsedx.sbs/assets/manual.pdf');
  assert.equal(accepted.body.file_url.startsWith('data:'), false);
});
