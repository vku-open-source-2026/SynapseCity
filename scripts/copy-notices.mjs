#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Copy the canonical license/NOTICE/source-offer bundle into a dist directory. */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.argv[2] || join(root, 'dist'));
if (!process.argv[2]) throw new Error('usage: node scripts/copy-notices.mjs <output-directory>');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const sourceCommit = process.env.SOURCE_COMMIT || git(['rev-parse', 'HEAD']);
if (!sourceCommit) throw new Error('SOURCE_COMMIT is required when building outside a git checkout');
const dirty = !process.env.SOURCE_COMMIT && Boolean(git(['status', '--porcelain']));
mkdirSync(output, { recursive: true });
for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY.md']) {
  cpSync(join(root, file), join(output, file));
}
cpSync(join(root, 'licenses'), join(output, 'licenses'), { recursive: true });

const template = readFileSync(join(root, 'licenses/SOURCE-OFFER.md'), 'utf8');
const rendered = template.replaceAll('SOURCE_COMMIT', sourceCommit);
const localNote = dirty
  ? '\nLocal build note: the working tree contained uncommitted changes; only the base commit above is represented as public source.\n'
  : '';
writeFileSync(join(output, 'SOURCE-OFFER.txt'), `${rendered}${localNote}`);
writeFileSync(join(output, 'licenses/SOURCE-OFFER.txt'), `${rendered}${localNote}`);

const generated = join(root, 'licenses/THIRD-PARTY-NOTICES.generated.txt');
const noticeTarget = join(output, 'THIRD-PARTY-NOTICES.txt');
if (existsSync(generated)) {
  cpSync(generated, noticeTarget);
  cpSync(generated, join(output, 'licenses/THIRD-PARTY-NOTICES.txt'));
} else {
  cpSync(join(root, 'licenses/THIRD-PARTY-NOTICES.txt'), noticeTarget);
}
console.log(`notice bundle: ${output} (source ${sourceCommit}${dirty ? ', uncommitted local build' : ''})`);
