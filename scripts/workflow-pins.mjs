#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Verify (and with --fix, repair) the `workflowRef.checksum` pins inside every
 * tracked plugin bundle against the committed workflow sources.
 *
 * DX computes an imported artifact's portable checksum as sha256 over the
 * canonical `{nodes, connections, settings}` AFTER injecting the mandatory
 * owner-only access policy (SynapseDX `routes/workflow-artifacts.ts`
 * `withOwnerOnly`). A bundle pin that does not equal that checksum makes a
 * live `POST /workspaces/import` fail with `409 workflow_artifact_not_found`,
 * so every committed source declares the same policy and every pin must match
 * it byte-for-byte.
 *
 * Usage:
 *   node scripts/workflow-pins.mjs          verify only; exit 1 on drift
 *   node scripts/workflow-pins.mjs --fix    declare owner-only settings on the
 *                                           sources, rewrite stale pins and
 *                                           reseal the affected bundles
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleChecksum, canonicalJson } from './lib/plugin-bundle.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = join(ROOT, 'plugins', 'workflows');
const PLUGINS = join(ROOT, 'plugins');
const FIX = process.argv.includes('--fix');

/** Mirror DX `withOwnerOnly`: the managed workflow is always owner-only. */
function withOwnerOnly(settings) {
  const base =
    settings && typeof settings === 'object' && !Array.isArray(settings)
      ? { ...settings }
      : {};
  const access =
    base.access && typeof base.access === 'object' && !Array.isArray(base.access)
      ? { ...base.access }
      : {};
  access.mode = 'owner-only';
  base.access = access;
  return base;
}

/** The portable checksum DX stores on an imported artifact. */
function portableChecksum(definition) {
  return createHash('sha256')
    .update(
      canonicalJson({
        nodes: definition.nodes,
        connections: definition.connections,
        settings: withOwnerOnly(definition.settings),
      }),
      'utf8',
    )
    .digest('hex');
}

const pins = new Map();
const problems = [];
const normalized = [];

for (const file of readdirSync(WORKFLOWS).sort()) {
  if (!file.endsWith('.workflow.json')) continue;
  const path = join(WORKFLOWS, file);
  const definition = JSON.parse(readFileSync(path, 'utf8'));
  const name = typeof definition.name === 'string' && definition.name
    ? definition.name
    : file.replace(/\.workflow\.json$/, '');
  const settings = withOwnerOnly(definition.settings);
  const declaresPolicy =
    definition.settings &&
    typeof definition.settings === 'object' &&
    !Array.isArray(definition.settings) &&
    definition.settings.access &&
    typeof definition.settings.access === 'object' &&
    !Array.isArray(definition.settings.access) &&
    definition.settings.access.mode === 'owner-only';
  if (!declaresPolicy) {
    if (!FIX) {
      problems.push(`${file}: settings.access.mode=owner-only is not declared`);
    } else {
      const rebuilt = {
        name: definition.name,
        ...(definition.slug !== undefined ? { slug: definition.slug } : {}),
        nodes: definition.nodes,
        connections: definition.connections,
        settings,
        ...(Object.keys(definition).some((key) => !['name', 'slug', 'nodes', 'connections', 'settings'].includes(key))
          ? {
              // Preserve any exotic top-level keys (never expected here).
              ...Object.fromEntries(
                Object.entries(definition).filter(
                  ([key]) => !['name', 'slug', 'nodes', 'connections', 'settings'].includes(key),
                ),
              ),
            }
          : {}),
      };
      writeFileSync(path, `${JSON.stringify(rebuilt, null, 2)}\n`);
      normalized.push(file);
    }
  }
  pins.set(name, portableChecksum(definition));
}

let reseals = 0;
let repins = 0;
for (const file of readdirSync(PLUGINS).sort()) {
  if (!file.endsWith('.plugin.json')) continue;
  const path = join(PLUGINS, file);
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  let changed = false;
  for (const widget of bundle.plugin.widgets) {
    const ref = widget.workflowRef;
    if (!ref || typeof ref.name !== 'string') continue;
    if (!pins.has(ref.name)) {
      problems.push(`${file}: ${widget.id} references ${ref.name} with no committed workflow source`);
      continue;
    }
    const expected = pins.get(ref.name);
    if (ref.checksum !== expected) {
      if (!FIX) {
        problems.push(
          `${file}: ${widget.id} -> ${ref.name} pin ${String(ref.checksum).slice(0, 12)}… != portable ${expected.slice(0, 12)}…`,
        );
      } else {
        ref.checksum = expected;
        changed = true;
        repins += 1;
      }
    }
  }
  if (changed) {
    bundle.checksum = bundleChecksum(bundle);
    writeFileSync(path, `${JSON.stringify(bundle, null, 2)}\n`);
    reseals += 1;
  }
}

if (normalized.length) {
  console.log(`declared owner-only access on ${normalized.length} workflow source(s): ${normalized.join(', ')}`);
}
if (FIX) {
  console.log(`repinned ${repins} workflowRef(s) across ${reseals} bundle(s)`);
}
if (problems.length) {
  for (const problem of problems) console.error(`workflow-pins: ${problem}`);
  process.exit(1);
}
console.log(`workflow pins are import-ready (${pins.size} workflow sources verified)`);
