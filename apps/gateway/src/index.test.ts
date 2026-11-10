// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const NOT_FOUND = { error: 'not_found', product: 'synapsecity' };

let gateway: Server;
let serviceServer: Server;
let consoleServer: Server;
let baseUrl: string;
let serviceHits: string[] = [];
let consoleHits: string[] = [];
let exported: typeof import('./index');

before(async () => {
  const service = http.createServer(async (req, res) => {
    serviceHits.push(req.url || '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    res.setHeader('content-type', 'application/json');
    if ((req.url || '').startsWith('/v1/assets')) res.setHeader('x-total-count', '3');
    if ((req.url || '').startsWith('/v1/files/upload')) {
      res.end(JSON.stringify({
        service: 'fake-city-service',
        path: req.url,
        bytes: body.length,
        sha256: body.toString('base64'),
        contentType: req.headers['content-type'],
        fileName: req.headers['x-file-name'],
      }));
      return;
    }
    res.end(JSON.stringify({ service: 'fake-city-service', path: req.url }));
  });
  const consoleServerInstance = http.createServer((req, res) => {
    consoleHits.push(req.url || '');
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end('<!doctype html><html><body>console shell</body></html>');
  });

  await new Promise<void>((resolve, reject) => {
    service.listen(0, '0.0.0.0', () => resolve());
    service.once('error', reject);
  });
  await new Promise<void>((resolve, reject) => {
    consoleServerInstance.listen(0, '0.0.0.0', () => resolve());
    consoleServerInstance.once('error', reject);
  });
  serviceServer = service;
  consoleServer = consoleServerInstance;
  const servicePort = (service.address() as AddressInfo).port;
  const consolePort = (consoleServerInstance.address() as AddressInfo).port;
  process.env.CITY_SERVICE_URL = `http://0.0.0.0:${servicePort}`;
  process.env.CONSOLE_URL = `http://0.0.0.0:${consolePort}`;

  exported = await import('./index');
  gateway = exported.app.listen(0);
  await new Promise<void>((resolve, reject) => {
    gateway.once('listening', resolve);
    gateway.once('error', reject);
  });
  baseUrl = `http://0.0.0.0:${(gateway.address() as AddressInfo).port}`;
});

after(async () => {
  for (const server of [gateway, serviceServer, consoleServer]) {
    if (!server) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test('foreign and unknown /v1 namespaces return the exact 404 body without an upstream', async () => {
  const rejected = [
    // SynapseCitySOS namespaces.
    '/v1/emergency',
    '/v1/emergency/events',
    '/v1/emergency/eop',
    '/v1/hazards',
    '/v1/hazards/recent',
    '/v1/sos',
    '/v1/sos/command-centre',
    // Unknown namespaces are not part of the City contract.
    '/v1/unknown',
    '/v1/public/unknown',
    '/v1/admin',
  ];

  for (const path of rejected) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must be rejected at the gateway`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the City not-found body`);
  }
});

test('encoded, uppercase and trailing-slash variants cannot bypass the boundary', async () => {
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
    '/v1/assets/%2e%2e/hazards',
    '/%76%31/emergency',
  ];

  for (const path of bypasses) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must not bypass the City boundary`);
    assert.deepEqual(await response.json(), NOT_FOUND, `${path} must return the City not-found body`);
  }
});

test('encoded /v1 prefixes are rejected with JSON 404, never answered with console HTML', async () => {
  for (const path of ['/%76%31/assets', '/%76%31/city', '/%76%31/public/assets']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must be rejected`);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await response.json(), NOT_FOUND);
  }

  // Non-prefix canonicalization still proxies owned API paths.
  for (const path of ['/v1//assets///1', '/V1/Assets/']) {
    const response = await fetch(`${baseUrl}${path}`, { headers: { authorization: 'Bearer test-session' } });
    assert.equal(response.status, 200, `${path} must reach the City service`);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    const body = (await response.json()) as { service: string };
    assert.equal(body.service, 'fake-city-service');
  }

  const consoleApiHits = consoleHits.filter((path) => path.toLowerCase().includes('/v1'));
  assert.deepEqual(consoleApiHits, [], 'no /v1 spelling may reach the console fallback');
  assert.equal(serviceHits.some((path) => path.toLowerCase().startsWith('/v1/assets')), true, 'canonicalized assets path must be proxied');
});

test('unknown encoded API paths return JSON 404 and never the SPA', async () => {
  for (const path of ['/%76%31/unknown', '/%76%31/public/unknown', '/v1/%zz/assets']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} must return 404`);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    assert.deepEqual(await response.json(), NOT_FOUND);
  }
});

test('path normalization and ownership checks are shared by the middleware', () => {
  assert.equal(exported.normalizeV1Path('/v1/EMERGENCY/'), '/v1/emergency');
  assert.equal(exported.normalizeV1Path('/v1//assets///1'), '/v1/assets/1');
  assert.equal(exported.normalizeV1Path('/v1/assets/../emergency'), '/v1/emergency');
  assert.equal(exported.normalizeV1Path('/v1/%61ssets/1'), '/v1/assets/1');
  assert.equal(exported.canonicalV1Path('/%76%31/Assets/AbC-1'), '/v1/Assets/AbC-1');

  for (const owned of ['/v1/city', '/v1/auth/login', '/v1/assets', '/v1/assets/1', '/v1/preventive-maintenance', '/v1/public/assets', '/v1/public/incidents', '/v1/ai', '/v1/ASSETS/']) {
    assert.equal(exported.isOwnedV1Path(owned), true, `${owned} must be owned by SynapseCity`);
  }
  for (const foreign of ['/v1/emergency', '/v1/hazards/recent', '/v1/sos', '/v1/unknown', '/v1/public/unknown']) {
    assert.equal(exported.isOwnedV1Path(foreign), false, `${foreign} must not be owned by SynapseCity`);
  }
  for (const anonymous of ['/v1/public/assets', '/v1/public/incidents/1', '/v1/auth/login', '/v1/city', '/v1/map/config', '/v1/map/tiles/1/2/3.png', '/v1/ai/status', '/v1/ai/chat']) {
    assert.equal(exported.isPublicV1Path(anonymous), true, `${anonymous} must stay anonymous`);
  }
  for (const operator of ['/v1/assets', '/v1/users', '/v1/reports/1/download', '/v1/ai/decision']) {
    assert.equal(exported.isPublicV1Path(operator), false, `${operator} must require a session`);
  }
});

test('binary upstream payloads are proxied byte-for-byte', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const response = new Response(png, { headers: { 'content-type': 'image/png' } });
  const body = await exported.proxyResponseBody(response);
  assert.equal(body[0], 0x89, 'PNG signature must not become a UTF-8 replacement character');
  assert.deepEqual([...body], [...png]);
});

test('binary file uploads are proxied byte-for-byte with their headers', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
  const response = await fetch(`${baseUrl}/v1/files/upload`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer operator',
      'content-type': 'image/png',
      'x-file-name': 'lamp.png',
      'x-checksum-sha256': 'a'.repeat(64),
    },
    body: bytes,
  });
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.equal(body.bytes, bytes.length);
  assert.equal(body.sha256, bytes.toString('base64'));
  assert.equal(body.contentType, 'image/png');
  assert.equal(body.fileName, 'lamp.png');
});

test('the files namespace is owned, authenticated and the public files route is anonymous', async () => {
  assert.equal((await fetch(`${baseUrl}/v1/files`)).status, 401);
  const publicFiles = await fetch(`${baseUrl}/v1/public/files/file-1/content`);
  assert.equal(publicFiles.status, 200, 'published report photos stay anonymously readable');
  assert.ok(serviceHits.includes('/v1/public/files/file-1/content'));
  const owned = await fetch(`${baseUrl}/v1/files`, { headers: { authorization: 'Bearer operator' } });
  assert.equal(owned.status, 200);
});

test('operator namespaces require an Authorization header at the gateway', async () => {
  for (const path of ['/v1/assets', '/v1/users', '/v1/reports/1/download', '/v1/ai/decision']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 401, `${path} must be rejected before proxying without a session`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body.error, 'unauthorized');
  }
  // The anonymous public surface still reaches the City service.
  for (const path of ['/v1/public/assets', '/v1/public/incidents', '/v1/city', '/v1/map/config', '/v1/auth/login']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} must stay anonymous`);
  }
  // The citizen assistant is public but still proxied (rate-limited upstream).
  const status = await fetch(`${baseUrl}/v1/ai/status`);
  assert.notEqual(status.status, 401);
  const chat = await fetch(`${baseUrl}/v1/ai/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"message":"hello"}' });
  assert.notEqual(chat.status, 401);
  // An authenticated operator request is proxied.
  const proxied = await fetch(`${baseUrl}/v1/assets`, { headers: { authorization: 'Bearer session' } });
  assert.equal(proxied.status, 200);
});

test('pagination headers survive the public edge', async () => {
  const response = await fetch(`${baseUrl}/v1/assets?limit=1`, { headers: { authorization: 'Bearer session' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-total-count'), '3');
});

test('CORS advertises PUT and DELETE for the City API', async () => {
  const response = await fetch(`${baseUrl}/v1/assets`, { method: 'OPTIONS' });
  assert.equal(response.status, 204);
  const methods = response.headers.get('access-control-allow-methods') || '';
  assert.match(methods, /\bPUT\b/);
  assert.match(methods, /\bDELETE\b/);
});
