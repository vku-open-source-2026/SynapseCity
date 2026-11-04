// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';
import { haversineMeters, parsePoint, pointInBoundingBox, pointInPolygon, polygonCoordinates } from './geo';
import { analyseCoverage } from './analytics';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-geo-test-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let token: string;

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
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;

  const point = (longitude: number, latitude: number) => ({
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
    location: { address: 'test', coordinates: { longitude, latitude } },
  });
  tier2.seed('city-assets', 'a1', { id: 'a1', asset_code: 'A1', name: 'Lamp 1', feature_type: 'street_light', feature_code: 'den_duong', status: 'active', ...point(105.8, 21.0) });
  tier2.seed('city-assets', 'a2', { id: 'a2', asset_code: 'A2', name: 'Lamp 2', feature_type: 'street_light', feature_code: 'den_duong', status: 'active', ...point(105.8005, 21.0) });
  tier2.seed('city-assets', 'a3', { id: 'a3', asset_code: 'A3', name: 'Far lamp', feature_type: 'street_light', feature_code: 'den_duong', status: 'active', ...point(106.8, 21.0) });
  tier2.seed('city-assets', 'h1', { id: 'h1', asset_code: 'H1', name: 'Hydrant', feature_type: 'hydrant', feature_code: 'tru_chua_chay', status: 'active', ...point(105.8001, 21.0001) });
  tier2.seed('city-incidents', 'inc-1', {
    id: 'inc-1', title: 'Open issue', status: 'open', category: 'damage', severity: 'high',
    location: { coordinates: { longitude: 105.8001, latitude: 21.0002 } },
    reported_at: new Date().toISOString(),
  });
  tier2.seed('city-incidents', 'inc-old', {
    id: 'inc-old', title: 'Old resolved', status: 'resolved', category: 'damage', severity: 'low',
    location: { coordinates: { longitude: 105.8001, latitude: 21.0002 } },
    reported_at: new Date(Date.now() - 90 * 86_400_000).toISOString(),
  });
  tier2.seed('city-iot-sensors', 's1', { id: 's1', sensor_code: 'S1', asset_id: 'a1', feature_type: 'street_light', status: 'active', geometry: { type: 'Point', coordinates: [105.8, 21.0] } });

  const auth = await import('./auth');
  token = auth.signToken({
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

test('geo primitives compute distances and predicates', () => {
  const hanoi = { longitude: 105.8, latitude: 21.0 };
  const offset = { longitude: 105.8005, latitude: 21.0 };
  const distance = haversineMeters(hanoi, offset);
  assert.ok(distance > 40 && distance < 70, `unexpected distance ${distance}`);
  assert.equal(haversineMeters(hanoi, hanoi), 0);
  assert.equal(pointInBoundingBox(offset, { minLng: 105.79, minLat: 20.99, maxLng: 105.81, maxLat: 21.01 }), true);
  assert.equal(pointInBoundingBox({ longitude: 106, latitude: 21 }, { minLng: 105.79, minLat: 20.99, maxLng: 105.81, maxLat: 21.01 }), false);
  const square: Array<[number, number]> = [[105.79, 20.99], [105.81, 20.99], [105.81, 21.01], [105.79, 21.01]];
  assert.equal(pointInPolygon(hanoi, square), true);
  assert.equal(pointInPolygon({ longitude: 106, latitude: 21 }, square), false);
  assert.deepEqual(polygonCoordinates({ type: 'Polygon', coordinates: [square] }), square);
  assert.equal(parsePoint({ lng: '105.8', lat: '21' })?.latitude, 21);
  assert.equal(parsePoint({}), null);
  assert.equal(parsePoint({ lng: 'nope', lat: 21 }), null);
});

test('nearby returns only assets inside the radius, sorted by distance', async () => {
  const response = await request('/v1/geo/assets/nearby?lng=105.8&lat=21.0&radius_meters=100', json('GET'));
  assert.equal(response.status, 200);
  const ids = (response.body as Array<{ id: string; distance_meters: number }>).map((asset) => asset.id);
  assert.deepEqual(ids, ['a1', 'h1', 'a2']);
  const distances = (response.body as Array<{ distance_meters: number }>).map((asset) => asset.distance_meters);
  assert.equal(distances[0], 0);
  assert.ok(distances.every((value, index) => index === 0 || value >= distances[index - 1]));
});

test('nearby honors feature_type and rejects missing coordinates', async () => {
  const filtered = await request('/v1/geo/assets/nearby?lng=105.8&lat=21.0&radius_meters=1000&feature_type=hydrant', json('GET'));
  assert.deepEqual((filtered.body as Array<{ id: string }>).map((asset) => asset.id), ['h1']);
  assert.equal((await request('/v1/geo/assets/nearby', json('GET'))).status, 400);
});

test('within-bounds and within-polygon return exact membership', async () => {
  const bounds = await request('/v1/geo/assets/within-bounds?min_lng=105.7999&min_lat=20.9999&max_lng=105.8002&max_lat=21.0002', json('GET'));
  assert.equal(bounds.status, 200);
  assert.deepEqual((bounds.body as Array<{ id: string }>).map((asset) => asset.id).sort(), ['a1', 'h1']);

  const polygon = await request('/v1/geo/assets/within-polygon', json('POST', {
    coordinates: [[105.7999, 20.9999], [105.8006, 20.9999], [105.8006, 21.0002], [105.7999, 21.0002]],
  }));
  assert.equal(polygon.status, 200);
  assert.deepEqual((polygon.body as Array<{ id: string }>).map((asset) => asset.id).sort(), ['a1', 'a2', 'h1']);
  assert.equal((await request('/v1/geo/assets/within-polygon', json('POST', {}))).status, 400);
});

test('distance-to computes a real distance instead of zero', async () => {
  const response = await request('/v1/geo/assets/a1/distance-to?lng=105.8005&lat=21.0', json('GET'));
  assert.equal(response.status, 200);
  assert.ok(response.body.distance_meters > 40 && response.body.distance_meters < 70);
  assert.ok(response.body.duration_seconds > 0);
  assert.equal(response.body.mode, 'straight_line_estimate');
  assert.equal((await request('/v1/geo/assets/a1/distance-to', json('GET'))).status, 400);
});

test('geofence tests match real assets and sensors', async () => {
  const created = await request('/v1/geofences', json('POST', {
    name: 'Downtown',
    polygon: [[105.7999, 20.9999], [105.8006, 20.9999], [105.8006, 21.0002], [105.7999, 21.0002]],
  }));
  assert.equal(created.status, 201);
  const tested = await request(`/v1/geofences/${created.body.id}/test`, json('POST', {}));
  assert.equal(tested.status, 200);
  assert.equal(tested.body.geometry_type, 'polygon');
  assert.equal(tested.body.matched_assets, 3);
  assert.equal(tested.body.matched_sensors, 1);
});

test('list endpoints filter and page after filtering, with totals', async () => {
  const response = await request('/v1/assets?feature_type=street_light&limit=2&offset=0', json('GET'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-total-count'), '3');
  assert.equal(response.body.length, 2);
  const page2 = await request('/v1/assets?feature_type=street_light&limit=2&offset=2', json('GET'));
  assert.equal(page2.body.length, 1);
  const noMatch = await request('/v1/assets?feature_type=nonexistent', json('GET'));
  assert.equal(noMatch.body.length, 0);
  assert.equal(noMatch.headers.get('x-total-count'), '0');
});

test('coverage analysis prioritises areas with unmet population demand', () => {
  const report = analyseCoverage({
    areas: [
      { name: 'Covered', population: 2000, bbox: { minLng: 105.79, minLat: 20.99, maxLng: 105.81, maxLat: 21.01 }, asset_types: ['street_light', 'hydrant'] },
      { name: 'Uncovered', population: 50000, bbox: { minLng: 106.0, minLat: 21.0, maxLng: 106.1, maxLat: 21.1 }, asset_types: ['street_light'] },
    ],
    assets: [
      { id: 'a1', feature_type: 'street_light', point: { longitude: 105.8, latitude: 21.0 } },
      { id: 'h1', feature_type: 'hydrant', point: { longitude: 105.8001, latitude: 21.0001 } },
    ],
    incidents: [
      { id: 'i1', status: 'open', point: { longitude: 106.05, latitude: 21.05 }, reported_at: new Date().toISOString() },
      { id: 'i2', status: 'open', point: { longitude: 106.05, latitude: 21.05 }, reported_at: new Date().toISOString() },
    ],
    serviceRadiusMeters: 100,
    targetPopulationPerAsset: 2000,
    now: Date.parse('2026-11-04T00:00:00Z'),
  });
  const uncovered = report.areas.find((area) => area.area === 'Uncovered')!;
  const covered = report.areas.find((area) => area.area === 'Covered')!;
  assert.equal(uncovered.asset_count, 0);
  assert.deepEqual(uncovered.missing_asset_types, ['street_light']);
  assert.equal(uncovered.open_incident_count, 2);
  assert.ok(uncovered.gap_score > covered.gap_score);
  assert.equal(uncovered.priority, 'critical');
  assert.ok(covered.gap_score < uncovered.gap_score);
  assert.equal(covered.missing_asset_types.length, 0);
});

test('coverage endpoint accepts area definitions and rejects invalid input', async () => {
  const response = await request('/v1/geo/coverage', json('POST', {
    areas: [
      { name: 'Downtown', population: 1000, bbox: { minLng: 105.79, minLat: 20.99, maxLng: 105.81, maxLat: 21.01 }, asset_types: ['street_light'] },
      { name: 'Gap', population: 50000, bbox: { minLng: 106.0, minLat: 21.0, maxLng: 106.1, maxLat: 21.1 } },
    ],
    service_radius_meters: 100,
  }));
  assert.equal(response.status, 200);
  assert.equal(response.body.areas[0].area, 'Gap');
  assert.equal(response.body.areas[0].priority, 'critical');
  assert.ok(response.body.areas[0].gap_score > response.body.areas[1].gap_score);

  assert.equal((await request('/v1/geo/coverage', json('POST', { areas: [] }))).status, 400);
  assert.equal((await request('/v1/geo/coverage', json('POST', { areas: [{ name: 'x', population: 1 }] }))).status, 400);
});
