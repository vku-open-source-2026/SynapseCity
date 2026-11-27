#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Read-only production smoke test for the retired console route contract.
 * Does not follow redirects, send credentials, or mutate deployment state.
 *
 *   npm run smoke:retired-routes
 *   npm run smoke:retired-routes -- https://cloud.synapsecity.sbs
 */
import assert from 'node:assert/strict';

const EXPECTED_LOCATION = 'https://synapsedx.sbs/workspace';
const RETIRED_PATHS = [
    '/login',
    '/login?next=%2Fadmin',
    '/register',
    '/workspace',
    '/workspace/projects',
    '/admin',
    '/admin/assets',
    '/technician',
    '/technician/tasks/task-1',
];
const bases = process.argv.slice(2);
if (bases.length === 0) bases.push('https://synapsecity.sbs');
if (bases.includes('--help') || bases.includes('-h')) {
    console.log('Usage: node scripts/production-retired-routes-smoke.mjs [base-url ...]');
    process.exit(0);
}

let checked = 0;
for (const base of bases) {
    const origin = new URL(base);
    assert.ok(['https:', 'http:'].includes(origin.protocol), 'base URL must be http(s)');
    for (const retiredPath of RETIRED_PATHS) {
        const url = new URL(retiredPath, origin);
        const response = await fetch(url, {
            redirect: 'manual',
            signal: AbortSignal.timeout(15_000),
            headers: { accept: 'text/html' },
        });
        await response.body?.cancel().catch(() => {});
        assert.equal(
            response.status,
            308,
            `${url} returned ${response.status}; the public edge is not applying the retired-route contract`,
        );
        assert.equal(
            response.headers.get('location'),
            EXPECTED_LOCATION,
            `${url} must redirect to the fixed DX workspace without preserving a return target`,
        );
        checked += 1;
    }
    console.log(`[retired-routes-smoke] ${origin.origin}: ${RETIRED_PATHS.length} redirects OK`);
}
console.log(`[retired-routes-smoke] ${checked} checks passed`);
