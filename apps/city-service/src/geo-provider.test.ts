// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';
import { roleForIdentity, identityFromSession } from './identity';
import { geoProviderMode } from './geo-provider';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-geo-test-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.CITY_AUTH_MODE = 'demo';
delete process.env.CITY_GEO_PROVIDER;

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let auth: typeof import('./auth');
let token: string;

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

function json(method: string, body?: unknown, bearer?: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;
  tier2.geo.results = [
    { id: 'place-1', label: 'Hanoi Opera House', address: '1 Trang Tien, Hanoi', lat: 21.0245, lon: 105.8572, raw: { city: 'Hanoi', country: 'Vietnam' } },
  ];
  auth = await import('./auth');
  token = auth.signToken({
    sub: 'user-geo', username: 'geo', email: 'geo@example.com', full_name: 'Geo',
    role: 'manager', permissions: auth.permissionsForRole('manager'), typ: 'access',
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
  delete process.env.CITY_GEO_PROVIDER;
  delete process.env.CITY_GEO_FALLBACK_VIETMAP;
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (tier2) await tier2.close();
});

test('City geocoding uses the shared Tier-2 adapter by default', async () => {
  assert.equal(geoProviderMode(), 'tier2');
  const search = await request('/v1/geo/search-address?q=Hanoi', json('GET', undefined, token));
  assert.equal(search.status, 200);
  assert.equal(search.body[0].provider, 'synapsedx');
  assert.equal(search.body[0].address, '1 Trang Tien, Hanoi');
  assert.equal(search.body[0].coordinates.latitude, 21.0245);
  assert.equal(search.body[0].ref_id, 'place-1');
  assert.ok(tier2.writes.some((write) => write.path === '/v1/capabilities/geo/autocomplete') === false, 'GET geo calls are not writes');

  const geocode = await request('/v1/geo/geocode', json('POST', { address: 'Hanoi Opera House' }, token));
  assert.equal(geocode.status, 200);
  assert.equal(geocode.body.provider, 'synapsedx');
  assert.deepEqual(geocode.body.geojson.coordinates, [105.8572, 21.0245]);

  const reverse = await request('/v1/geo/reverse-geocode', json('POST', { latitude: 21.0245, longitude: 105.8572 }, token));
  assert.equal(reverse.status, 200);
  assert.equal(reverse.body.provider, 'synapsedx');
  assert.equal(reverse.body.city, 'Hanoi');
});

test('an unavailable shared geocoder is reported honestly, not replaced silently', async () => {
  tier2.geo.available = false;
  try {
    const search = await request('/v1/geo/search-address?q=Hanoi', json('GET', undefined, token));
    assert.equal(search.status, 503);
    assert.equal(search.body.error, 'geocoder_unavailable');
    const status = await request('/v1/city');
    assert.equal(status.body.capabilities.geo.provider, 'tier2');
  } finally {
    tier2.geo.available = true;
  }
});

test('there is no local VietMap opt-in: geocoding is always Tier 2', () => {
  process.env.CITY_GEO_PROVIDER = 'vietmap';
  try {
    assert.equal(geoProviderMode(), 'tier2');
  } finally {
    delete process.env.CITY_GEO_PROVIDER;
  }
});

test('Tier-2 identity is parsed without trusting client-supplied roles', () => {
  const identity = identityFromSession({
    accessToken: 'a', refreshToken: 'r',
    user: { id: 'user-1', email: 'ops@city.test', display_name: 'Ops', role: 'admin', roles: ['admin'] },
  });
  assert.equal(identity.userId, 'user-1');
  assert.equal(identity.email, 'ops@city.test');
  // A user object carrying a role claim is ignored; only the bootstrap list or
  // a City operator profile decides the City role.
  assert.equal(roleForIdentity(identity, null), 'citizen');
  assert.equal(roleForIdentity(identity, { role: 'technician', status: 'active' }), 'technician');
  assert.equal(roleForIdentity(identity, { role: 'admin', status: 'inactive' }), 'citizen');
  process.env.CITY_AUTH_DEFAULT_ROLE = 'admin';
  try {
    assert.equal(roleForIdentity(identity, { role: 'not-a-role' }), 'citizen', 'an unknown profile role must never inherit the default operator role');
  } finally {
    delete process.env.CITY_AUTH_DEFAULT_ROLE;
  }
  process.env.CITY_BOOTSTRAP_ADMIN_EMAILS = 'ops@city.test';
  try {
    assert.equal(roleForIdentity(identity, null), 'admin');
  } finally {
    delete process.env.CITY_BOOTSTRAP_ADMIN_EMAILS;
  }
});
