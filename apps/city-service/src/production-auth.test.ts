// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';

// Production must be set before the service module (and its session secret) is
// imported. Tier-2 is the default identity source.
process.env.NODE_ENV = 'production';
process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-production-test-secret';
process.env.LOG_LEVEL = 'silent';
delete process.env.CITY_AUTH_MODE;
delete process.env.AUTH_MODE;
delete process.env.AUTH_DEMO_MODE;
delete process.env.AUTH_DEMO_ROLE;

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let adminToken: string;

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
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
  process.env.CITY_BOOTSTRAP_ADMIN_EMAILS = 'ops@city.test';
  const service = await import('./server');
  server = service.createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const login = await request('/v1/auth/login', json('POST', { email: 'ops@city.test', password: 'secret' }));
  assert.equal(login.status, 200);
  adminToken = login.body.access_token;
});

after(async () => {
  delete process.env.AUTH_DEMO_MODE;
  delete process.env.AUTH_DEMO_ROLE;
  delete process.env.CITY_AUTH_MODE;
  delete process.env.CITY_BOOTSTRAP_ADMIN_EMAILS;
  delete process.env.CITY_AUTH_EXCHANGE;
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (tier2) await tier2.close();
});

test('production verifies credentials through Tier-2 and never trusts a request role', async () => {
  const login = await request('/v1/auth/login', json('POST', {
    email: 'citizen@city.test', password: 'secret', role: 'admin', permissions: ['*'],
  }));
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, 'citizen', 'an unknown identity must not become admin');
  assert.match(String(login.body.access_token), /^[A-Za-z0-9_-]+\./);
  const me = await request('/v1/auth/me', { headers: { authorization: `Bearer ${login.body.access_token}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'citizen');
  assert.equal(me.body.tier2_token, undefined, 'the Tier-1 token must not leave the service');
});

test('a City administrator comes from the server-side bootstrap allow-list or a City profile', async () => {
  const me = await request('/v1/auth/me', { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, 'admin');
  const verify = await request('/v1/auth/verify', { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(verify.body.identity_source, 'tier2');
});

test('Tier-2 exchange is used when configured and does not widen the token', async () => {
  process.env.CITY_AUTH_EXCHANGE = 'true';
  try {
    const login = await request('/v1/auth/login', json('POST', { email: 'ops@city.test', password: 'secret' }));
    assert.equal(login.status, 200);
    assert.ok(tier2.auth.exchanges.length >= 1, 'auth.exchange must be called');
    const exchange = tier2.auth.exchanges[tier2.auth.exchanges.length - 1];
    assert.equal(exchange.audience, 'synapsecity');
    assert.equal(exchange.userId, 'user-ops');
    const me = await request('/v1/auth/me', { headers: { authorization: `Bearer ${login.body.access_token}` } });
    assert.equal(me.status, 200);
  } finally {
    delete process.env.CITY_AUTH_EXCHANGE;
  }
});

test('refresh rotates the Tier-2 session and logout revokes it', async () => {
  const login = await request('/v1/auth/login', json('POST', { email: 'ops@city.test', password: 'secret' }));
  assert.equal(login.status, 200);
  const refreshed = await request('/v1/auth/refresh', json('POST', { refresh_token: login.body.refresh_token }));
  assert.equal(refreshed.status, 200);
  assert.notEqual(refreshed.body.access_token, login.body.access_token);
  const logout = await request('/v1/auth/logout', json('POST', { refresh_token: refreshed.body.refresh_token }));
  assert.equal(logout.status, 204);
  const reused = await request('/v1/auth/refresh', json('POST', { refresh_token: refreshed.body.refresh_token }));
  assert.equal(reused.status, 401);
});

test('an unavailable Tier-2 identity capability fails closed', async () => {
  tier2.auth.available = false;
  try {
    const login = await request('/v1/auth/login', json('POST', { email: 'someone@city.test', password: 'secret' }));
    assert.equal(login.status, 503);
    assert.equal(login.body.error, 'identity_not_configured');
    assert.equal(login.body.access_token, undefined);
    const register = await request('/v1/auth/register', json('POST', {
      email: 'new@city.test', password: 'secret123', full_name: 'New',
    }));
    assert.equal(register.status, 503);
    assert.equal(register.body.error, 'identity_not_configured');
  } finally {
    tier2.auth.available = true;
  }
});

test('production reports capability state honestly', async () => {
  const city = await request('/v1/city');
  assert.equal(city.status, 200);
  assert.equal(city.body.capabilities.identity.status, 'available');
  assert.equal(city.body.capabilities.identity.mode, 'tier2');
  assert.equal(city.body.capabilities.files.status, 'available');
  assert.equal(city.body.capabilities.files.transport, 'synapsedx');
  assert.equal(city.body.capabilities.geo.provider, 'tier2');
  assert.equal(city.body.capabilities.jobs.status, 'not_used');
});

test('demo login needs both an explicit demo mode and AUTH_DEMO_MODE', async () => {
  process.env.CITY_AUTH_MODE = 'demo';
  delete process.env.AUTH_DEMO_MODE;
  // Demo mode without AUTH_DEMO_MODE falls back to Tier-2 identity; it must
  // never mint the configured demo role. The unknown identity stays a citizen.
  const fallback = await request('/v1/auth/login', json('POST', { email: 'demo@city.test', password: 'demo' }));
  assert.equal(fallback.status, 200);
  assert.equal(fallback.body.user.role, 'citizen');

  process.env.AUTH_DEMO_MODE = 'true';
  process.env.AUTH_DEMO_ROLE = 'manager';
  try {
    const login = await request('/v1/auth/login', json('POST', {
      username: 'demo-operator', password: 'demo', role: 'admin',
    }));
    assert.equal(login.status, 200);
    assert.equal(login.body.user.role, 'manager', 'the configured role wins, not the request role');
    const changed = await request('/v1/auth/change-password', json('POST', {
      current_password: 'old', new_password: 'new-secret',
    }, login.body.access_token));
    assert.equal(changed.status, 503, 'the demo shell must not fake a password change');
  } finally {
    delete process.env.AUTH_DEMO_MODE;
    delete process.env.AUTH_DEMO_ROLE;
    delete process.env.CITY_AUTH_MODE;
  }
});

test('an operator request without a session is still 401 in production', async () => {
  assert.equal((await request('/v1/assets')).status, 401);
  assert.equal((await request('/v1/users')).status, 401);
  assert.equal((await request('/v1/files')).status, 401);
});

test('public reporting stays anonymous in production', async () => {
  const response = await request('/v1/public/incidents', json('POST', {
    title: 'Production citizen report', description: 'Street light out', category: 'malfunction',
  }));
  assert.equal(response.status, 201);
  assert.equal(response.body.contact_info, undefined);
  assert.equal((await request('/v1/public/assets')).status, 200);
});
