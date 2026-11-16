#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Release-readiness check for the Tier-2 SDK dependency.
 *
 * City pins the Tier-2 client to a vendored, checksummed tarball
 * (`vendor/synapsedx-capabilities-<version>.tgz`). A clean clone therefore
 * builds without a sibling SynapseDX checkout and without registry access.
 *
 *   npm run check:release            # verify the vendored dependency
 *   RELEASE=1 npm run check:release  # identical strict check (fails on file: dirs)
 *
 * A registry semver dependency is also accepted. A `file:` directory (the old
 * sibling-checkout workaround) always fails.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const root = path.join(__dirname, '..');
const pkgPath = path.join(root, 'apps', 'city-service', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const dependency = pkg.dependencies && pkg.dependencies['@synapsedx/capabilities'];
const strict = process.env.RELEASE === '1' || process.argv.includes('--strict');

function fail(message) {
  console.error(`[release-check] FAIL: ${message}`);
  process.exit(1);
}

/** Read `package/package.json` from a gzipped npm tarball without external tools. */
function readPackedPackageJson(file) {
  const tar = zlib.gunzipSync(fs.readFileSync(file));
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const contentStart = offset + 512;
    if (name === 'package/package.json') {
      return JSON.parse(tar.subarray(contentStart, contentStart + size).toString('utf8'));
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function verifyTarball(spec) {
  const relative = spec.replace(/^file:/, '');
  const file = path.resolve(path.join(root, 'apps', 'city-service'), relative);
  if (!fs.existsSync(file)) fail(`vendored tarball is missing: ${file}`);
  if (!file.endsWith('.tgz')) fail(`a file: dependency must point at a pinned .tgz, found: ${relative}`);

  const packed = readPackedPackageJson(file);
  if (!packed) fail(`cannot read package.json from ${relative}`);
  if (packed.name !== '@synapsedx/capabilities') fail(`tarball contains ${packed.name}, expected @synapsedx/capabilities`);

  const shaFile = `${file}.sha256`;
  if (!fs.existsSync(shaFile)) fail(`checksum file is missing: ${path.basename(shaFile)}`);
  const expected = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  if (expected !== actual) fail(`vendored tarball checksum mismatch: ${relative}`);

  console.log(`[release-check] Tier-2 SDK pinned tarball: @synapsedx/capabilities@${packed.version}`);
  console.log(`[release-check]   ${relative}`);
  console.log(`[release-check]   sha256 ${actual}`);
  if (strict) {
    console.log('[release-check] Strict release check passed (registry semver dependency, no sibling checkout).');
  }
}

if (!dependency) fail('@synapsedx/capabilities is not declared');

if (dependency.startsWith('file:')) {
  verifyTarball(dependency);
} else if (/^[~^]?\d+\.\d+\.\d+/.test(dependency)) {
  console.log(`[release-check] Tier-2 SDK registry release: @synapsedx/capabilities@${dependency}`);
} else if (dependency.startsWith('https://') || dependency.startsWith('npm:')) {
  console.log(`[release-check] Tier-2 SDK pinned remote dependency: ${dependency}`);
} else {
  fail(`expected a semver release or a pinned .tgz, found: ${dependency}`);
}

if (pkg.scripts && pkg.scripts.prebuild && /SynapseDX/.test(pkg.scripts.prebuild)) {
  fail('prebuild still builds a sibling SynapseDX checkout');
}
