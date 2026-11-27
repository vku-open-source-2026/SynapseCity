#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Verify notice propagation and the removed Hippocratic dependency in dist. */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const directories = process.argv.slice(2);
if (directories.length === 0) throw new Error('usage: node scripts/check-notice-artifacts.mjs <dist> [dist...]');
const required = [
  'LICENSE',
  'NOTICE',
  'THIRD-PARTY.md',
  'THIRD-PARTY-NOTICES.txt',
  'SOURCE-OFFER.txt',
  'licenses/MPL-2.0.txt',
  'licenses/EDL-1.0.txt',
  'licenses/LICENSE-CHOICES.md',
];
let failed = false;
function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}
for (const raw of directories) {
  const directory = resolve(raw);
  for (const file of required) {
    if (!existsSync(join(directory, file))) {
      console.error(`notice artifact: missing ${file} in ${directory}`);
      failed = true;
    }
  }
  const offerPath = join(directory, 'SOURCE-OFFER.txt');
  if (existsSync(offerPath)) {
    const offer = readFileSync(offerPath, 'utf8');
    if (offer.includes('SOURCE_COMMIT') || !offer.includes('github.com/vku-open-source-2026/SynapseCity/tree/')) {
      console.error(`notice artifact: source offer is not rendered in ${directory}`);
      failed = true;
    }
  }
  for (const file of files(directory).filter((path) => /\.(?:js|css)$/.test(path))) {
    const text = readFileSync(file, 'utf8');
    if (/Hippocratic-2\.1|@react-leaflet\/core/i.test(text)) {
      console.error(`notice artifact: forbidden bundled dependency text in ${file}`);
      failed = true;
    }
  }
}
if (failed) process.exitCode = 1;
console.log(`notice artifacts: ${directories.length} director${directories.length === 1 ? 'y' : 'ies'} passed`);
