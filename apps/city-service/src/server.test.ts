// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer } from './server';
import { DATASETS } from './domain';

type CityMetadata = {
  product: string;
  publicUrl: string;
  domain: string;
  features: string[];
  notOwned: string[];
  datasets: string[];
  dependency: string;
};

const NOT_FOUND = { error: 'not_found', product: 'synapsecity' };

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

test('GET /v1/city advertises the domain boundary and Tier-2 dependency', async () => {
  const response = await fetch(`${baseUrl}/v1/city`);
  assert.equal(response.status, 200);
  const metadata = (await response.json()) as CityMetadata;

  assert.equal(metadata.product, 'synapsecity');
  assert.equal(metadata.publicUrl, 'https://synapsecity.sbs');
  assert.equal(metadata.domain, 'infrastructure');
  assert.equal(metadata.dependency, 'https://synapsedx.sbs');

  for (const feature of ['assets', 'incidents', 'maintenance', 'iot', 'alerts', 'budgets', 'reports', 'users', 'geofences', 'ingest', 'public-asset-map']) {
    assert.ok(metadata.features.includes(feature), `missing feature: ${feature}`);
  }
  for (const foreign of ['hazards', 'emergency-events', 'eop', 'dispatch', 'resources', 'sitrep', 'aar', 'emergency-command-centre']) {
    assert.ok(metadata.notOwned.includes(foreign), `missing notOwned entry: ${foreign}`);
  }

  assert.ok(metadata.datasets.length > 0);
  for (const dataset of metadata.datasets) {
    assert.match(dataset, /^city-/, `foreign dataset leaked into City metadata: ${dataset}`);
  }
});

test('every declared City dataset uses the city- prefix', () => {
  for (const spec of Object.values(DATASETS)) {
    assert.match(spec.id, /^city-/, `foreign dataset declared in City service: ${spec.id}`);
    assert.ok(!spec.id.startsWith('sos-'));
  }
});

test('foreign SynapseCitySOS namespaces return 404 JSON', async () => {
  const foreignPaths = [
    '/v1/emergency',
    '/v1/emergency/events',
    '/v1/emergency/eop',
    '/v1/hazards',
    '/v1/hazards/recent',
    '/v1/sos',
    '/v1/sos/command-centre',
  ];

  for (const path of foreignPaths) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must return 404`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the City not-found body`);
  }
});

test('encoded, uppercase and trailing-slash variants cannot bypass the service guard', async () => {
  const bypasses = [
    '/v1/EMERGENCY',
    '/v1/Hazards/',
    '/v1/%65mergency',
    '/v1/%68azards/recent',
    '/v1/emergency/',
    '/v1/emergency%2Fevents',
    '/v1/sos/',
    '/v1/%73os',
    '/v1/assets/../emergency',
    '/%76%31/emergency',
  ];

  for (const path of bypasses) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must not bypass the City boundary`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the City not-found body`);
  }
});

test('unknown /v1 namespaces fall back to 404 JSON', async () => {
  for (const path of ['/v1', '/v1/unknown', '/v1/public/unknown', '/v1/not-a-city-namespace']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must return 404`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the City not-found body`);
  }
});

test('operator routes are protected before any generic record lookup', async () => {
  for (const path of ['/v1/users', '/v1/users/me', '/v1/users/technicians', '/v1/users/volunteers']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, `${path} must require a session instead of returning 404`);
    assert.notDeepEqual(await response.json(), NOT_FOUND, `${path} must not fall through to the /v1 not-found handler`);
  }
});

test('users are not exposed through the public projection contract', () => {
  assert.equal(DATASETS.users.public, false);
  assert.equal(DATASETS.users.id, 'city-users');
});
