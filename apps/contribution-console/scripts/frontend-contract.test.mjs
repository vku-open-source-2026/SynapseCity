// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(appRoot, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(resolve(appRoot, 'package-lock.json'), 'utf8'));
const mapSource = readFileSync(resolve(appRoot, 'src/components/Map/MapView.jsx'), 'utf8');

test('contribution runtime dependencies contain no React Leaflet/Hippocratic packages', () => {
  assert.equal(manifest.dependencies['react-leaflet'], undefined);
  for (const [path, entry] of Object.entries(lock.packages)) {
    assert.doesNotMatch(path, /react-leaflet/i);
    assert.notEqual(entry.license, 'Hippocratic-2.1');
  }
});

test('map is implemented directly with Leaflet', () => {
  assert.doesNotMatch(mapSource, /from ['"]react-leaflet['"]/);
  assert.match(mapSource, /L\.map\(/);
  assert.match(mapSource, /L\.marker\(/);
  assert.match(mapSource, /L\.polyline\(/);
  assert.match(mapSource, /draggable:\s*true/);
  assert.doesNotMatch(mapSource, /setAttribution\(/);
});

test('routing and HTTP dependencies are on fixed compatible releases', () => {
  assert.match(manifest.dependencies['react-router-dom'], /^\^7\./);
  assert.match(manifest.dependencies.axios, /^\^1\.21\./);
  assert.ok(!Object.keys(lock.packages).some((path) => path.endsWith('/follow-redirects')
    && lock.packages[path].version === '1.15.11'));
  assert.ok(!Object.keys(lock.packages).some((path) => path.endsWith('/form-data')
    && lock.packages[path].version === '4.0.5'));
});
