#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Audit production dependencies for every independently locked npm app. */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projects = ['', 'apps/console', 'apps/contribution-console', 'mobile'];
let failed = false;
for (const project of projects) {
  const cwd = join(root, project);
  console.log(`\nProduction npm audit: ${project || 'root/workspaces'}`);
  const result = spawnSync(process.env.NPM || 'npm', ['audit', '--omit=dev', '--audit-level=high'], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.error || result.status !== 0) failed = true;
}
if (failed) process.exitCode = 1;
