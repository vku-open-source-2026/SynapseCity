// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';
import { resetRateLimits } from './security';

// Small limits must be set before the module-level rate limiters are created.
process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-hardening-test-secret';
// This suite exercises the explicit development-only demo session shell.
process.env.CITY_AUTH_MODE = 'demo';
// Non-production test only: keep the pre-migration auth routes reachable.
process.env.TIER3_AUTH_MODE = 'legacy';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_RATE_LIMIT = '2';
process.env.AUTH_RATE_WINDOW_MS = '60000';

let tier2: MockTier2;
let server: Server;
let turnstile: Server;
let baseUrl: string;
let turnstileUrl: string;

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function json(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;
  process.env.SYNAPSEDX_API_KEY = 'city-hardening-tier2-key';

  turnstile = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const response = params.get('response');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(response === 'valid-token' ? { success: true } : { success: false, 'error-codes': ['invalid-input-response'] }));
  });
  await new Promise<void>((resolve, reject) => {
    turnstile.listen(0, '127.0.0.1', () => resolve());
    turnstile.once('error', reject);
  });
  turnstileUrl = `http://127.0.0.1:${(turnstile.address() as AddressInfo).port}/siteverify`;

  const service = await import('./server');
  server = service.createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  delete process.env.METRICS_TOKEN;
  delete process.env.TURNSTILE_SECRET_KEY;
  delete process.env.TURNSTILE_VERIFY_URL;
  for (const instance of [server, turnstile]) {
    if (!instance) continue;
    await new Promise<void>((resolve, reject) => instance.close((error) => (error ? reject(error) : resolve())));
  }
  if (tier2) await tier2.close();
});

test('auth endpoints enforce a rate limit with retry-after', async () => {
  resetRateLimits();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ok = await request('/v1/auth/login', json('POST', { username: 'qa', password: 'x' }));
    assert.equal(ok.status, 200);
  }
  const limited = await request('/v1/auth/login', json('POST', { username: 'qa', password: 'x' }));
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, 'rate_limited');
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  resetRateLimits();
});

test('Turnstile is verified server-side when configured', async () => {
  process.env.TURNSTILE_SECRET_KEY = 'turnstile-secret';
  process.env.TURNSTILE_VERIFY_URL = turnstileUrl;
  try {
    const missing = await request('/v1/public/incidents', json('POST', { title: 'x', description: 'y', category: 'other' }));
    assert.equal(missing.status, 403);
    assert.equal(missing.body.error, 'turnstile_token_required');

    const invalid = await request('/v1/public/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-turnstile-response': 'bad-token' },
      body: JSON.stringify({ title: 'x', description: 'y', category: 'other' }),
    });
    assert.equal(invalid.status, 403);
    assert.equal(invalid.body.error, 'turnstile_failed');

    const valid = await request('/v1/public/incidents', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-turnstile-response': 'valid-token' },
      body: JSON.stringify({ title: 'Verified report', description: 'y', category: 'other' }),
    });
    assert.equal(valid.status, 201);
  } finally {
    delete process.env.TURNSTILE_SECRET_KEY;
    delete process.env.TURNSTILE_VERIFY_URL;
  }
});

test('health reports per-capability dependency state instead of a blanket ready', async () => {
  const health = await request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.capabilities.files.status, 'available');
  assert.equal(health.body.capabilities.files.transport, 'synapsedx');
  assert.equal(health.body.capabilities.ai.status, 'available');
  assert.equal(health.body.capabilities.ai.transport, 'synapsedx');
  assert.equal(health.body.capabilities.notifications.status, 'partial');
  assert.equal(health.body.capabilities.notifications.external, 'unavailable');
  assert.equal(health.body.capabilities.identity.mode, 'demo');
  assert.equal(health.body.capabilities.geo.provider, 'tier2');
  assert.equal(health.body.capabilities.datasets.status, 'available');

  const ready = await request('/ready');
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, 'ready');
});

test('metrics expose request counters and can be token-protected', async () => {
  await request('/v1/public/assets');
  const open = await request('/metrics');
  assert.equal(open.status, 200);
  assert.match(String(open.body), /synapsecity_http_requests_total \d+/);
  assert.match(String(open.body), /synapsecity_http_responses_total/);

  process.env.METRICS_TOKEN = 'metrics-secret';
  try {
    const denied = await request('/metrics');
    assert.equal(denied.status, 401);
    const allowed = await request('/metrics', { headers: { 'x-metrics-token': 'metrics-secret' } });
    assert.equal(allowed.status, 200);
  } finally {
    delete process.env.METRICS_TOKEN;
  }
});
