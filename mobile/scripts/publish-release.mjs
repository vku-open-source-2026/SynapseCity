#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Publish a signed Android artifact through the Tier-2 files capability.
 *
 * Tier-3 release job -> Tier-2 /v1/capabilities/files -> Tier-1 SynapseOCS.
 * No S3 credential is ever read by this process. The release key must carry
 * `files:write` and `files:publish`.
 *
 * Usage:
 *   SYNAPSEDX_RELEASE_API_KEY=... node scripts/publish-release.mjs \
 *     --product synapsecity --version 0.1.0 --apk dist/SynapseCity.apk
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

const args = process.argv.slice(2);
function arg(name, fallback = undefined) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

const baseUrl = (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/+$/, '');
const apiKey = process.env.SYNAPSEDX_RELEASE_API_KEY;
const product = arg('product');
const version = arg('version');
const file = arg('apk');
const arch = arg('arch', 'universal');
const channel = arg('channel', 'stable');
const explicitId = arg('id');

if (!apiKey) throw new Error('SYNAPSEDX_RELEASE_API_KEY is required');
if (!product || !version || !file) {
  throw new Error('usage: publish-release.mjs --product <id> --version <semver> --apk <path>');
}
if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(product)) throw new Error('product must be lowercase kebab-case');
if (!/^[0-9A-Za-z._-]{1,30}$/.test(version)) throw new Error('version contains unsupported characters');
if (!/^[a-z0-9_-]{1,30}$/.test(arch)) throw new Error('arch must be lowercase kebab/ABI name');

const bytes = await readFile(file);
const info = await stat(file);
const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
const id = explicitId || `${product}-android-${version}-${arch}`.slice(0, 80);
if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) throw new Error('release id is invalid');

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: 'application/json',
      'x-api-key': apiKey,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

async function removeExisting() {
  const existing = await request(`/v1/capabilities/files/${encodeURIComponent(id)}`);
  if (existing.response.status === 404) return;
  if (!existing.response.ok) throw new Error(`metadata lookup failed: HTTP ${existing.response.status}`);
  if (existing.body?.checksumSha256 === checksumSha256 && Number(existing.body?.size) === info.size && existing.body?.public === true && existing.body?.publicUrl) {
    const head = await fetch(`${baseUrl}${existing.body.publicUrl || ''}`, { method: 'HEAD' });
    if (head.ok && Number(head.headers.get('content-length') || 0) === info.size) {
      const publicUrl = `${baseUrl}${existing.body.publicUrl}`;
      console.log(JSON.stringify({ id, product, version, channel, arch, file: basename(file), size: info.size, sha256: checksumSha256, publicUrl, reused: true }, null, 2));
      process.exit(0);
    }
  }
  const deleted = await request(`/v1/capabilities/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!deleted.response.ok && deleted.response.status !== 404) {
    throw new Error(`could not replace existing release: HTTP ${deleted.response.status}`);
  }
}

let created = await request('/v1/capabilities/files', {
  method: 'POST',
  body: JSON.stringify({
    id,
    filename: basename(file),
    contentType: 'application/vnd.android.package-archive',
    size: info.size,
    checksumSha256,
    public: true,
  }),
});
if (created.response.status === 409) {
  await removeExisting();
  created = await request('/v1/capabilities/files', {
    method: 'POST',
    body: JSON.stringify({
      id,
      filename: basename(file),
      contentType: 'application/vnd.android.package-archive',
      size: info.size,
      checksumSha256,
      public: true,
    }),
  });
}
if (!created.response.ok) {
  throw new Error(`create failed: HTTP ${created.response.status} ${JSON.stringify(created.body)}`);
}

const presign = await request(`/v1/capabilities/files/${encodeURIComponent(id)}/presign`, {
  method: 'POST',
  body: JSON.stringify({ method: 'PUT', expiresIn: 900 }),
});
if (!presign.response.ok) {
  throw new Error(`presign failed: HTTP ${presign.response.status} ${JSON.stringify(presign.body)}`);
}

const upload = await fetch(presign.body.url, {
  method: 'PUT',
  headers: {
    'content-type': 'application/vnd.android.package-archive',
    'x-object-checksum-sha256': checksumSha256,
  },
  body: bytes,
});
if (!upload.ok) {
  throw new Error(`Tier-1 signed upload failed: HTTP ${upload.status} ${(await upload.text()).slice(0, 500)}`);
}

const completed = await request(`/v1/capabilities/files/${encodeURIComponent(id)}/complete`, {
  method: 'POST',
  body: JSON.stringify({ size: info.size }),
});
if (!completed.response.ok) {
  throw new Error(`complete failed: HTTP ${completed.response.status} ${JSON.stringify(completed.body)}`);
}
if (completed.body?.checksumSha256 !== checksumSha256 || Number(completed.body?.size) !== info.size) {
  throw new Error('Tier-2 completion did not confirm the uploaded checksum/size');
}

const publicMeta = await request(`/v1/capabilities/public/files/${encodeURIComponent(id)}`);
if (!publicMeta.response.ok) {
  throw new Error(`public metadata failed: HTTP ${publicMeta.response.status}`);
}
const publicUrl = `${baseUrl}${publicMeta.body.publicUrl}`;
const download = await fetch(publicUrl, { method: 'GET' });
if (!download.ok) throw new Error(`public download failed: HTTP ${download.status}`);
const downloaded = Buffer.from(await download.arrayBuffer());
const downloadedSha = createHash('sha256').update(downloaded).digest('hex');
if (downloadedSha !== checksumSha256) throw new Error('public download checksum does not match');

console.log(JSON.stringify({
  id,
  product,
  version,
  channel,
  arch,
  file: basename(file),
  size: info.size,
  sha256: checksumSha256,
  publicUrl,
  verifiedDownload: true,
}, null, 2));
