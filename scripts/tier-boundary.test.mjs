// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier boundary guard.
 *
 * contribution-service has one documented, scoped legacy Tier-1 migration and
 * rollback path. Production uses Tier-2. This test does not pretend the legacy
 * compatibility code is absent; it fails if the exception grows, leaks into
 * another City component, or adds another Tier-1 network or credential path.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTRIB = path.join(ROOT, 'apps', 'contribution-service');
const TIER1 = /synapseone::|from\s+['"]synapseone['"]|api\.synapseone\.space|SYNAPSEONE_(?:API_KEY|BASE_URL)/i;

// The only files allowed to mention Tier-1 inside the scoped exception.
const ALLOWED_SOURCE = new Set([
  'src/config.rs',
  'src/error.rs',
  'src/storage/base.rs',
  'src/storage/mod.rs',
  'src/bin/migrate_base_to_dx.rs',
]);

function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

test('Tier-1 exception stays confined to contribution-service', () => {
  for (const app of fs.readdirSync(path.join(ROOT, 'apps'))) {
    if (app === 'contribution-service') continue;
    for (const file of walk(path.join(ROOT, 'apps', app))) {
      if (!/\.(rs|ts|tsx|js|mjs|toml|json)$/.test(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      assert.ok(!TIER1.test(text), `${path.relative(ROOT, file)} references Tier-1`);
    }
  }
});

test('contribution-service has no new Tier-1 SDK import sites', () => {
  const cargo = fs.readFileSync(path.join(CONTRIB, 'Cargo.toml'), 'utf8');
  const dependencyLines = cargo
    .split('\n')
    .filter((line) => /^\s*synapseone\s*=/.test(line));
  assert.ok(dependencyLines.length <= 1, 'only one Tier-1 SDK dependency is allowed');

  for (const file of walk(path.join(CONTRIB, 'src'))) {
    const relative = path.relative(CONTRIB, file);
    const text = fs.readFileSync(file, 'utf8');
    if (!TIER1.test(text)) continue;
    assert.ok(ALLOWED_SOURCE.has(relative), `${relative} added a Tier-1 reference`);
  }
});

test('contribution stack keeps one documented network and env mapping', () => {
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8');
  const section = compose.match(/\n  contribution-service:\n([\s\S]*?)\n  contribution-console:/);
  assert.ok(section, 'contribution-service compose section is missing');
  const body = section[1];
  const synapseoneEnv = [...body.matchAll(/SYNAPSEONE_[A-Z_]+/g)].map((match) => match[0]);
  assert.deepEqual(
    [...new Set(synapseoneEnv)].sort(),
    ['SYNAPSEONE_API_KEY', 'SYNAPSEONE_BASE_URL'],
    'unexpected Tier-1 environment variable',
  );
  assert.ok(/\n    networks:\n      edge:/.test(body), 'contribution-service must join only the documented edge network');
  assert.ok(!/networks:\s*\[[^\]]*synapseone/i.test(body), 'no inline Tier-1 network membership');
  const networkDefinitions = compose.match(/name: synapseone_synapseone-net/g) || [];
  assert.equal(networkDefinitions.length, 1, 'exactly one external Tier-1 edge network definition');
  assert.match(compose, /edge:\n    external: true\n    name: synapseone_synapseone-net/);
});

test('Tier-1 credential rotation requirements are documented', () => {
  const doc = fs.readFileSync(path.join(ROOT, 'docs', 'TIER1_CONTRIBUTION_EXCEPTION.md'), 'utf8').toLowerCase();
  for (const phrase of ['rotation owner', 'least privilege', 'expiry', 'tier-2 migration']) {
    assert.ok(doc.includes(phrase), `runbook missing ${phrase}`);
  }
});
