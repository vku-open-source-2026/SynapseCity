#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Generate CycloneDX SBOMs for every npm lock and Cargo service. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'sbom'));
mkdirSync(output, { recursive: true });
const npmProjects = [
  ['root', 'package-lock.json', '.'],
  ['console', 'apps/console/package-lock.json', 'apps/console'],
  ['contribution-console', 'apps/contribution-console/package-lock.json', 'apps/contribution-console'],
  ['mobile', 'mobile/package-lock.json', 'mobile'],
];
for (const [name, , cwd] of npmProjects) {
  // Foreign-platform optional packages may bundle dependencies that npm does not
  // record as separate lock entries. Omit those uninstalled optionals here; the
  // license gate below still audits every component in every lockfile.
  const json = execFileSync(process.env.NPM || 'npm', ['sbom', '--package-lock-only', '--omit=optional', '--sbom-format=cyclonedx'], {
    cwd: join(root, cwd),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  writeFileSync(join(output, `npm-${name}.cdx.json`), json);
  console.log(`SBOM: npm-${name}.cdx.json`);
}
execFileSync(process.execPath, [join(root, 'scripts/license-gate.mjs'), '--sbom-dir', output], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
console.log(`SBOMs written to ${output}`);
