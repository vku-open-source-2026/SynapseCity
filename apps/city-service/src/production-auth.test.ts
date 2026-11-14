// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';

// Production must be set before the service module (and its session secret) is
// imported.
process.env.NODE_ENV = 'production';
process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-production-test-secret';
process.env.LOG_LEVEL = 'silent';
// The retired auth code is still present for non-production suites. Production
// must ignore this flag and answer 410 to every /v1/auth request.
process.env.TIER3_AUTH_MODE = 'legacy';
delete process.env.CITY_AUTH_MODE;
delete process.env.AUTH_MODE;
delete process.env.AUTH_DEMO_MODE;
delete process.env.AUTH_DEMO_ROLE;

let tier2: MockTier2;
let server: Server;
let baseUrl: string;

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;
  const service = await import('./server');
  server = service.createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  delete process.env.TIER3_AUTH_MODE;
  delete process.env.CITY_BOOTSTRAP_ADMIN_EMAILS;
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (tier2) await tier2.close();
});

test('every /v1/auth request returns 410 workspace_moved in production', async () => {
  const cases: Array<{ method: string; path: string; body?: unknown }> = [
    { method: 'POST', path: '/v1/auth/login', body: { email: 'ops@city.test', password: 'secret' } },
    { method: 'POST', path: '/v1/auth/register', body: { email: 'new@city.test', password: 'secret123' } },
    { method: 'POST', path: '/v1/auth/refresh', body: { refresh_token: 'anything' } },
    { method: 'POST', path: '/v1/auth/logout', body: {} },
    { method: 'POST', path: '/v1/auth/change-password', body: { current_password: 'a', new_password: 'b' } },
    { method: 'GET', path: '/v1/auth/me' },
    { method: 'GET', path: '/v1/auth/verify' },
    { method: 'GET', path: '/v1/auth' },
    { method: 'DELETE', path: '/v1/auth/unknown' },
  ];

  for (const probe of cases) {
    const response = await request(probe.path, {
      method: probe.method,
      headers: { 'content-type': 'application/json' },
      ...(probe.body === undefined ? {} : { body: JSON.stringify(probe.body) }),
    });
    assert.equal(response.status, 410, `${probe.method} ${probe.path}`);
    assert.equal(response.body.error, 'workspace_moved');
    assert.equal(response.body.product, 'city');
    assert.equal(response.body.workspace_url, 'https://synapsedx.sbs/workspace');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.body.access_token, undefined, 'no session may be minted');
    assert.equal(response.body.refresh_token, undefined, 'no session may be minted');
    assert.equal(response.body.user, undefined);
  }
});

test('a production request cannot reach the Tier-2 identity capability', async () => {
  const before = tier2.auth.sessions.size;
  const response = await request('/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'ops@city.test', password: 'secret' }),
  });
  assert.equal(response.status, 410);
  assert.equal(tier2.auth.sessions.size, before, 'no credential may be forwarded to Tier-2');
});

test('operator namespaces still require a session', async () => {
  assert.equal((await request('/v1/assets')).status, 401);
  assert.equal((await request('/v1/users')).status, 401);
  assert.equal((await request('/v1/files')).status, 401);
});

test('public reporting stays anonymous and available', async () => {
  const response = await request('/v1/public/incidents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Production citizen report', description: 'Street light out', category: 'malfunction' }),
  });
  assert.equal(response.status, 201);
  assert.equal(response.body.contact_info, undefined);
  assert.equal((await request('/v1/public/assets')).status, 200);
});

test('production reports capability state honestly', async () => {
  const city = await request('/v1/city');
  assert.equal(city.status, 200);
  assert.equal(city.body.capabilities.identity.status, 'available');
  assert.equal(city.body.capabilities.identity.mode, 'tier2');
});
