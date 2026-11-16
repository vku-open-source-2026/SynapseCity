// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';
import type { SessionRole } from './auth';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-authz-test-secret';
// This suite exercises the explicit development-only demo session shell.
process.env.CITY_AUTH_MODE = 'demo';
// Non-production test only: keep the pre-migration auth routes reachable.
process.env.TIER3_AUTH_MODE = 'legacy';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let auth: typeof import('./auth');

function tokenFor(role: SessionRole, username = `${role}-user`): string {
  return auth.signToken({
    sub: `user-${username}`,
    username,
    email: `${username}@example.com`,
    full_name: username,
    role,
    permissions: auth.permissionsForRole(role),
    typ: 'access',
  });
}

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

const OPERATOR_PROBES: Array<{ method: string; path: string; body?: unknown }> = [
  { method: 'GET', path: '/v1/assets' },
  { method: 'POST', path: '/v1/assets', body: { name: 'anonymous' } },
  { method: 'GET', path: '/v1/incidents' },
  { method: 'GET', path: '/v1/maintenance' },
  { method: 'GET', path: '/v1/iot/sensors' },
  { method: 'GET', path: '/v1/alerts' },
  { method: 'GET', path: '/v1/budgets' },
  { method: 'GET', path: '/v1/reports' },
  { method: 'GET', path: '/v1/notifications' },
  { method: 'GET', path: '/v1/files' },
  { method: 'POST', path: '/v1/files/upload' },
  { method: 'GET', path: '/v1/users' },
  { method: 'GET', path: '/v1/geofences' },
  { method: 'GET', path: '/v1/geo/assets/nearby?lng=105.8&lat=21.0' },
  { method: 'POST', path: '/v1/ingest/csv', body: { content: '' } },
];

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;

  tier2.seed('city-assets', 'asset-1', {
    id: 'asset-1', asset_code: 'ASSET-1', name: 'Lamp', feature_type: 'street_light',
    feature_code: 'den_duong', status: 'active',
    geometry: { type: 'Point', coordinates: [105.8342, 21.0278] },
    location: { address: 'Hanoi', coordinates: { longitude: 105.8342, latitude: 21.0278 } },
  });
  tier2.seed('city-maintenance', 'maint-own', {
    id: 'maint-own', asset_id: 'asset-1', title: 'My task', status: 'scheduled',
    assigned_to: 'technician-user', scheduled_date: new Date(Date.now() + 3_600_000).toISOString(),
  });
  tier2.seed('city-maintenance', 'maint-other', {
    id: 'maint-other', asset_id: 'asset-1', title: 'Someone else task', status: 'scheduled',
    assigned_to: 'other-technician', scheduled_date: new Date(Date.now() + 3_600_000).toISOString(),
  });

  auth = await import('./auth');
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

test('every operator namespace rejects an anonymous request with 401 JSON', async () => {
  for (const probe of OPERATOR_PROBES) {
    const response = await request(probe.path, json(probe.method, probe.body));
    assert.equal(response.status, 401, `${probe.method} ${probe.path} must require a session`);
    assert.equal(response.body.error, 'unauthorized', `${probe.path} must return the City unauthorized body`);
  }
});

test('the anonymous public surface and product metadata stay reachable', async () => {
  for (const path of ['/v1/city', '/v1/public/assets', '/v1/public/incidents', '/v1/map/config']) {
    const response = await request(path);
    assert.equal(response.status, 200, `${path} must stay anonymous`);
  }
  const health = await request('/health');
  assert.equal(health.status, 200);
});

test('the public assistant is anonymous and never leaks a 401', async () => {
  // The citizen map embeds the assistant for visitors; it must reach the
  // Tier-2 capability with the deployment credential instead of requiring a
  // City session. Upstream availability is reported in the body (200/503).
  const status = await request('/v1/ai/status');
  assert.notEqual(status.status, 401);
  assert.ok([200, 503].includes(status.status), `unexpected status ${status.status}`);
  const chat = await request('/v1/ai/chat', json('POST', { message: 'hello' }));
  assert.notEqual(chat.status, 401);
});

test('a forged or malformed token is rejected', async () => {
  const response = await request('/v1/assets', json('GET', undefined, 'not-a-token'));
  assert.equal(response.status, 401);
  const forged = `${tokenFor('admin')}.tampered`;
  assert.equal((await request('/v1/assets', json('GET', undefined, forged))).status, 401);
});

test('a citizen session can read public data and report an incident but cannot operate', async () => {
  const citizen = tokenFor('citizen');
  assert.equal((await request('/v1/public/assets')).status, 200);
  const reported = await request('/v1/public/incidents', json('POST', {
    title: 'Citizen report', description: 'Broken hydrant', category: 'damage',
  }));
  assert.equal(reported.status, 201);

  for (const probe of [
    { method: 'POST', path: '/v1/assets', body: { name: 'forbidden asset' } },
    { method: 'GET', path: '/v1/assets' },
    { method: 'POST', path: '/v1/incidents', body: { title: 'x', category: 'damage' } },
    { method: 'GET', path: '/v1/users' },
    { method: 'POST', path: '/v1/ingest/csv', body: { content: 'x' } },
    { method: 'GET', path: '/v1/geo/assets/nearby?lng=105.8&lat=21.0' },
  ]) {
    const response = await request(probe.path, json(probe.method, probe.body, citizen));
    assert.equal(response.status, 403, `${probe.method} ${probe.path} must be forbidden for a citizen`);
    assert.equal(response.body.error, 'forbidden');
  }
});

test('a technician is scoped to their own work orders and cannot approve or manage users', async () => {
  const technician = tokenFor('technician');
  assert.equal((await request('/v1/assets', json('GET', undefined, technician))).status, 200);

  const orders = await request('/v1/maintenance', json('GET', undefined, technician));
  assert.equal(orders.status, 200);
  const ids = (orders.body as Array<{ id: string }>).map((order) => order.id);
  assert.deepEqual(ids, ['maint-own'], 'a technician must only see their own work orders');
  assert.equal((await request('/v1/maintenance/maint-other', json('GET', undefined, technician))).status, 404);

  for (const probe of [
    { method: 'POST', path: '/v1/assets', body: { name: 'technician asset' } },
    { method: 'POST', path: '/v1/budgets/b-1/approve', body: {} },
    { method: 'GET', path: '/v1/users' },
    { method: 'GET', path: '/v1/reports' },
  ]) {
    const response = await request(probe.path, json(probe.method, probe.body, technician));
    assert.equal(response.status, 403, `${probe.method} ${probe.path} must be forbidden for a technician`);
  }
});

test('a volunteer has read-only access and no operator writes', async () => {
  const volunteer = tokenFor('volunteer');
  assert.equal((await request('/v1/assets', json('GET', undefined, volunteer))).status, 200);
  assert.equal((await request('/v1/incidents', json('GET', undefined, volunteer))).status, 200);
  assert.equal((await request('/v1/assets', json('POST', { name: 'volunteer asset' }, volunteer))).status, 403);
  assert.equal((await request('/v1/incidents', json('POST', { title: 'x', category: 'damage' }, volunteer))).status, 403);
});

test('a manager can operate assets and read users but cannot administer users', async () => {
  const manager = tokenFor('manager');
  const created = await request('/v1/assets', json('POST', { name: 'Manager asset', asset_code: 'MGR-1' }, manager));
  assert.equal(created.status, 201);
  assert.equal((await request('/v1/users', json('GET', undefined, manager))).status, 200);
  assert.equal((await request('/v1/users', json('POST', { username: 'x', email: 'x@example.com', full_name: 'X' }, manager))).status, 403);
});

test('an admin can perform operator and admin writes', async () => {
  const admin = tokenFor('admin');
  const created = await request('/v1/assets', json('POST', { name: 'Admin asset', asset_code: 'ADM-1' }, admin));
  assert.equal(created.status, 201);
  assert.equal((await request('/v1/users', json('GET', undefined, admin))).status, 200);
  assert.equal((await request('/v1/alerts', json('POST', { title: 'Low alert', severity: 'low' }, admin))).status, 201);
});

test('login never trusts a client-supplied role', async () => {
  process.env.AUTH_DEMO_ROLE = 'citizen';
  try {
    const response = await request('/v1/auth/login', json('POST', {
      username: 'escalation-attempt', password: 'x', role: 'admin', permissions: ['*'],
    }));
    assert.equal(response.status, 200);
    assert.equal(response.body.user.role, 'citizen');
    assert.deepEqual(response.body.user.permissions, ['public:read']);
  } finally {
    delete process.env.AUTH_DEMO_ROLE;
  }
});

test('a stale permission list in a token cannot widen access', async () => {
  // A token signed with the citizen role but a hand-written wildcard permission
  // list must still be treated as a citizen.
  const forgedClaims = auth.signToken({
    sub: 'user-stale', username: 'stale', email: 'stale@example.com', full_name: 'Stale',
    role: 'citizen', permissions: ['*'], typ: 'access',
  });
  const response = await request('/v1/assets', json('POST', { name: 'stale' }, forgedClaims));
  assert.equal(response.status, 403);
});
