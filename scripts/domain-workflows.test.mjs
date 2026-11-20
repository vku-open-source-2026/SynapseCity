// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * LOCAL TEST ONLY: run the City domain workflow artifacts through the real
 * Tier-1 engine against the real DX HTTP routes (fake Tier-1 persistence),
 * via scripts/domain-workflows-harness.mts.
 *
 * The wrapper asserts the harness verdict and the real domain effects the
 * harness reports (merge closes duplicates and extends merged_reporter_ids
 * with only successfully closed ones; upvote is idempotent per reporter).
 * It uses no real credential, network, Tier-1/Tier-2 deployment or Docker and
 * skips with an explicit reason when the sibling checkouts/tsx are missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(ROOT, '..');
const TSX = path.join(WORKSPACE, 'SynapseOne', 'node_modules', '.bin', 'tsx');
const ENGINE = path.join(WORKSPACE, 'SynapseOne', 'apps', 'workflow-service', 'src', 'engine.ts');
const DX_HARNESS = path.join(WORKSPACE, 'SynapseDX', 'apps', 'capabilities-service', 'dist', 'src', 'testing', 'harness.js');
const HARNESS = path.join(ROOT, 'scripts', 'domain-workflows-harness.mts');

const available = fs.existsSync(TSX) && fs.existsSync(ENGINE) && fs.existsSync(DX_HARNESS);
const skipReason = available ? '' : 'sibling SynapseOne engine/tsx or SynapseDX testing harness not available; domain engine test is local-only';

test('real engine + real DX routes: merge, upvote and the schedule check behave', { skip: available ? false : skipReason }, () => {
    const stdout = execFileSync(TSX, [HARNESS], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 120_000,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SYNAPSEONE_ENGINE: ENGINE,
            NODE_NO_WARNINGS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const verdict = JSON.parse(stdout.trim().split('\n').at(-1));
    assert.equal(verdict.passed, true, stdout);
    assert.equal(verdict.engine, 'real Tier-1');
    assert.equal(verdict.persistence, 'fake Tier-1 test transport');
    assert.equal(verdict.productAPICalls, 0, 'a workflow must never call the Tier-3 product API');
    assert.equal(verdict.comments, 2, 'structured comments were not appended');
    assert.equal(verdict.upvotes, 1, 'the upvote is not idempotent per reporter');
    assert.equal(verdict.mergedDuplicates, 2, 'the merge did not close both duplicates');
    assert.equal(verdict.mergeFailures, 1, 'the missing duplicate was not tolerated');
    assert.equal(verdict.scheduleOrdersCreated, 2, 'the schedule check did not create one order per due schedule');
    assert.equal(verdict.scheduleRecheckCreated, 0, 're-running the schedule check duplicated an order');
    assert.equal(verdict.iotRowsImported, 2, 'the IoT batch did not import the valid rows');
    assert.equal(verdict.iotRowsInvalid, 1, 'the IoT batch did not reject the invalid row');
});
