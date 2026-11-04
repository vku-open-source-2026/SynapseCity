// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';
import type { SessionRole } from './auth';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-files-test-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.CITY_AUTH_MODE = 'demo';
process.env.CITY_FILES_MAX_BYTES = String(2 * 1024 * 1024);
process.env.CITY_PUBLIC_URL = 'https://city.test';

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let auth: typeof import('./auth');
let adminToken: string;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers; bytes?: Buffer }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  const type = response.headers.get('content-type') || '';
  let body: any = null;
  if (type.includes('application/json')) {
    const text = buffer.toString('utf8');
    body = text ? JSON.parse(text) : null;
  } else {
    body = buffer;
  }
  return { status: response.status, body, headers: response.headers, bytes: buffer };
}

function json(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

function rawUpload(method: string, path: string, bytes: Buffer, headers: Record<string, string>, token?: string): RequestInit {
  return {
    method,
    headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: bytes as unknown as BodyInit,
  };
}

function tokenFor(role: SessionRole, username = `${role}-user`): string {
  return auth.signToken({
    sub: `user-${username}`, username, email: `${username}@example.com`, full_name: username,
    role, permissions: auth.permissionsForRole(role), typ: 'access',
  });
}

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;
  tier2.seed('city-incidents', 'inc-guard', {
    id: 'inc-guard', incident_number: 'INC-GUARD', incident_code: 'INC-GUARD', title: 'Guard',
    description: 'guard', category: 'other', severity: 'low', status: 'open',
    reported_at: new Date().toISOString(), created_at: new Date().toISOString(),
  });
  tier2.seed('city-assets', 'asset-1', {
    id: 'asset-1', asset_code: 'ASSET-1', name: 'Lamp', feature_type: 'street_light', feature_code: 'den_duong',
    status: 'active', geometry: { type: 'Point', coordinates: [105.8, 21.0] },
  });
  auth = await import('./auth');
  adminToken = tokenFor('admin', 'admin');
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

test('binary upload goes through the Tier-2 files capability and stores only metadata', async () => {
  const uploaded = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', PNG, {
    'content-type': 'image/png', 'x-file-name': 'lamp.png', 'x-checksum-sha256': createHash('sha256').update(PNG).digest('hex'),
  }, adminToken));
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.filename, 'lamp.png');
  assert.equal(uploaded.body.content_type, 'image/png');
  assert.equal(uploaded.body.size, PNG.length);
  assert.equal(uploaded.body.checksum_sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.match(uploaded.body.file_url, /^https:\/\/city\.test\/v1\/files\/.+\/content$/);
  assert.equal(tier2.files.get(uploaded.body.id)?.bytes.equals(PNG), true, 'Tier-2 received the exact bytes');
  const metadata = tier2.records.get('city-files')?.get(uploaded.body.id) as Record<string, unknown>;
  assert.equal(metadata.storage, 'tier2-files');
  assert.equal(JSON.stringify(metadata).includes('base64'), false);
  assert.equal(JSON.stringify(metadata).includes('data:'), false);
});

test('a JSON document is uploaded as bytes, not parsed into the request body', async () => {
  const content = Buffer.from('{"asset":"ASSET-1","note":"manual"}');
  const uploaded = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', content, {
    'content-type': 'application/json', 'x-file-name': 'metadata.json',
  }, adminToken));
  assert.equal(uploaded.status, 201);
  assert.equal(uploaded.body.content_type, 'application/json');
  assert.equal(tier2.files.get(uploaded.body.id)?.bytes.equals(content), true);
});

test('checksum and size limits are enforced before the Tier-2 write', async () => {
  const badChecksum = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', PNG, {
    'content-type': 'image/png', 'x-file-name': 'lamp.png', 'x-checksum-sha256': '0'.repeat(64),
  }, adminToken));
  assert.equal(badChecksum.status, 400);
  assert.equal(badChecksum.body.error, 'checksum_mismatch');

  const tooLarge = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', Buffer.alloc(3 * 1024 * 1024), {
    'content-type': 'image/png', 'x-file-name': 'big.png',
  }, adminToken));
  assert.equal(tooLarge.status, 413);

  const badType = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', Buffer.from('#!/bin/sh'), {
    'content-type': 'application/x-sh', 'x-file-name': 'run.sh',
  }, adminToken));
  assert.equal(badType.status, 415);
});

test('an uploaded file attaches to an asset, downloads byte-for-byte, and stays owner-scoped', async () => {
  const uploaded = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', PNG, {
    'content-type': 'image/png', 'x-file-name': 'lamp.png',
  }, adminToken));
  assert.equal(uploaded.status, 201);
  const fileId = String(uploaded.body.id);

  const attached = await request('/v1/assets/asset-1/photos', json('POST', { file_ids: [fileId] }, adminToken));
  assert.equal(attached.status, 200);
  assert.equal(attached.body.photos.length, 1);
  assert.match(String(attached.body.photos[0]), new RegExp(`/v1/files/${fileId}/content$`));
  const attachment = (attached.body.attachments as Array<Record<string, unknown>>)[0];
  assert.equal(attachment.file_id, fileId);
  assert.equal(attachment.file_type, 'image/png');
  assert.equal(attachment.size, PNG.length);
  assert.ok(String(attachment.checksum_sha256).length === 64);
  assert.equal(JSON.stringify(attached.body).includes('data:'), false);

  const downloaded = await request(`/v1/files/${fileId}/content`, json('GET', undefined, adminToken));
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('content-type'), 'image/png');
  assert.equal(downloaded.bytes?.equals(PNG), true);
  assert.equal(downloaded.headers.get('x-checksum-sha256'), createHash('sha256').update(PNG).digest('hex'));

  const other = tokenFor('technician', 'other-tech');
  assert.equal((await request(`/v1/files/${fileId}`, json('GET', undefined, other))).status, 404);
  assert.equal((await request(`/v1/files/${fileId}/content`, json('GET', undefined, other))).status, 404);
  const technician = tokenFor('technician', 'admin');
  assert.equal((await request(`/v1/files/${fileId}`, json('GET', undefined, technician))).status, 200, 'the owner may read their file');
});

test('a data URL still cannot enter an asset or incident record', async () => {
  const response = await request('/v1/assets/asset-1/photos', json('POST', {
    photos: ['data:image/png;base64,iVBORw0KGgo='],
  }, adminToken));
  assert.equal(response.status, 415);
  assert.equal(response.body.error, 'data_url_not_supported');
});

test('a data URL cannot bypass validation through a PATCH payload', async () => {
  const incident = await request('/v1/incidents/inc-guard', json('PATCH', {
    photos: ['data:image/png;base64,iVBORw0KGgo='],
  }, adminToken));
  assert.equal(incident.status, 415);
  assert.equal(incident.body.error, 'data_url_not_supported');

  const base64 = await request('/v1/incidents/inc-guard', json('PATCH', {
    file_content: 'aGVsbG8=',
  }, adminToken));
  assert.equal(base64.status, 415);
  assert.equal(base64.body.error, 'inline_binary_not_accepted');

  const asset = await request('/v1/assets/asset-1', json('PATCH', {
    attachments: [{ file_url: 'data:application/pdf;base64,JVBERi0=' }],
  }, adminToken));
  assert.equal(asset.status, 415);

  for (const [datasetId, rows] of tier2.records.entries()) {
    for (const [recordId, record] of rows.entries()) {
      assert.equal(JSON.stringify(record).includes('data:'), false, `${datasetId}/${recordId} must not contain a data URL`);
      assert.equal(JSON.stringify(record).includes('aGVsbG8='), false, `${datasetId}/${recordId} must not contain inline base64`);
    }
  }
});

test('create + proxy upload + complete + presign flows use the files capability', async () => {
  const created = await request('/v1/files', json('POST', {
    filename: 'manual.pdf', content_type: 'application/pdf', size: 8,
  }, adminToken));
  assert.equal(created.status, 201);
  assert.match(String(created.body.upload.url), /\/v1\/files\/.+\/content$/);
  const fileId = String(created.body.id);

  const uploaded = await request(`/v1/files/${fileId}/content`, rawUpload('PUT', `/v1/files/${fileId}/content`, Buffer.from('%PDF-1.4'), {
    'content-type': 'application/pdf',
  }, adminToken));
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.body.size, 8);

  const completed = await request(`/v1/files/${fileId}/complete`, json('POST', { size: 8 }, adminToken));
  assert.equal(completed.status, 200);
  assert.equal(completed.body.size, 8);

  const presign = await request(`/v1/files/${fileId}/presign`, json('POST', { method: 'GET' }, adminToken));
  assert.equal(presign.status, 501, 'the filesystem backend reports presign_unsupported');
});

test('deleting a file removes the object and its City metadata', async () => {
  const uploaded = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', PNG, {
    'content-type': 'image/png', 'x-file-name': 'delete-me.png',
  }, adminToken));
  const fileId = String(uploaded.body.id);
  assert.ok(tier2.files.has(fileId));
  const deleted = await request(`/v1/files/${fileId}`, json('DELETE', undefined, adminToken));
  assert.equal(deleted.status, 204);
  assert.equal(tier2.files.has(fileId), false);
  assert.equal(tier2.records.get('city-files')?.has(fileId), false);
  assert.equal((await request(`/v1/files/${fileId}`, json('GET', undefined, adminToken))).status, 404);
});

test('anonymous report photos upload publicly and download without a session', async () => {
  const publicUpload = await request('/v1/public/files', rawUpload('POST', '/v1/public/files', PNG, {
    'content-type': 'image/png', 'x-file-name': 'pothole.png',
  }));
  assert.equal(publicUpload.status, 201);
  const fileId = String(publicUpload.body.id);
  assert.equal((tier2.records.get('city-files')?.get(fileId) as Record<string, unknown>).public, true);

  const incident = await request('/v1/public/incidents', json('POST', {
    title: 'Pothole', description: 'Deep pothole', category: 'damage', photos: [fileId],
  }));
  assert.equal(incident.status, 201);
  assert.match(String(incident.body.photos[0]), /^https:\/\/city\.test\/v1\/public\/files\/.+\/content$/);

  const download = await request(`/v1/public/files/${fileId}/content`);
  assert.equal(download.status, 200);
  assert.equal(download.bytes?.equals(PNG), true);

  const privateUpload = await request('/v1/files/upload', rawUpload('POST', '/v1/files/upload', PNG, {
    'content-type': 'image/png', 'x-file-name': 'private.png',
  }, adminToken));
  assert.equal((await request(`/v1/public/files/${String(privateUpload.body.id)}/content`)).status, 404);
});
