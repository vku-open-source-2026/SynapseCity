// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * LOCAL TEST-ONLY: execute the City workflow artifacts through the real
 * Tier-1 SynapseFlow engine with a fake HTTP transport.
 *
 * This validates:
 * - the engine reaches the fixed Tier-2 dataset endpoint with POST;
 * - the api-key credentialRef resolves to an in-memory secret and is sent as
 *   `X-API-Key`;
 * - the mutation body wraps `{data, publish}` and carries validated domain
 *   fields;
 * - the validation node emits the audit object (plugin/widget/submitter);
 * - a malformed form fails before any HTTP call.
 *
 * It does not use a real credential, network, Tier-1/Tier-2 deployment or
 * Docker. If the sibling SynapseOne checkout/tsx is unavailable the test skips
 * with an explicit reason.
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
const HARNESS = path.join(ROOT, 'scripts', 'workflow-engine-harness.mts');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', 'workflows', 'manifest.json'), 'utf8'));

const available = fs.existsSync(TSX) && fs.existsSync(ENGINE);
const skipReason = available ? '' : 'sibling SynapseOne engine/tsx not available; engine test is local-only';

function runHarness(workflowFile, dataset, credentialRef, mode) {
    const stdout = execFileSync(TSX, [HARNESS, path.join(ROOT, workflowFile), dataset, credentialRef, mode], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            SYNAPSEONE_ENGINE: ENGINE,
            NODE_NO_WARNINGS: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(stdout.trim().split('\n').at(-1));
}

test('real Tier-1 engine executes a valid create and audits the mutation', { skip: available ? false : skipReason }, () => {
    for (const entry of manifest.workflows.filter((item) => item.operation.endsWith('.create'))) {
        const result = runHarness(entry.file, entry.dataset, manifest.persistence.credentialRef, 'good');
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
        assert.equal(result.calls.length, 1, `${entry.workflow} must make exactly one mutation`);
        const call = result.calls[0];
        assert.equal(call.method, 'POST');
        assert.equal(call.url, `https://synapsedx.sbs/v1/capabilities/datasets/${entry.dataset}/records`);
        assert.equal(call.headers['x-api-key'], 'test-api-key-secret');
        assert.equal(call.headers['content-type'], 'application/json');
        const body = JSON.parse(call.body);
        assert.equal(typeof body.data, 'object');
        assert.equal(body.data.type, entry.dataset === 'city-incidents' ? 'Incident' : 'Maintenance');
        assert.ok(body.data.title);
        assert.equal(body.publish, entry.dataset === 'city-incidents');

        const audit = result.validationOutput?.audit;
        assert.equal(audit.operation, entry.operation);
        assert.equal(audit.submittedBy, 'member-test');
        assert.equal(audit.pluginId, 'plugin-test');
        assert.equal(audit.widgetId, 'widget-test');
        assert.equal(audit.product, 'city');
        assert.equal(audit.resource, entry.resource);
        assert.deepEqual(result.credentialResolutions, ['bound-test-credential']);
        assert.deepEqual(result.sourceCredentialRefs, ['synapsedx-organization']);
        const source = JSON.parse(fs.readFileSync(path.join(ROOT, entry.file), 'utf8'));
        const auth = source.nodes.find((node) => node.type === 'httpRequest').parameters.auth;
        assert.equal(auth.credentialRef, 'synapsedx-organization');
        assert.equal(auth.credentialId, undefined);
    }
});

test('real Tier-1 engine reads, merges and conditionally patches transitions', { skip: available ? false : skipReason }, () => {
    const transitions = manifest.workflows.filter((entry) => entry.method === 'PATCH');
    assert.ok(transitions.length >= 5);
    for (const entry of transitions) {
        const result = runHarness(entry.file, entry.dataset, manifest.persistence.credentialRef, 'good');
        assert.equal(result.status, 'success', `${entry.workflow}: ${result.error}`);
        assert.equal(result.calls.length, 2, `${entry.workflow} must GET then PATCH`);
        const [read, patch] = result.calls;
        assert.equal(read.method, 'GET');
        assert.equal(patch.method, 'PATCH');
        assert.equal(patch.headers['x-api-key'], 'test-api-key-secret');
        const body = JSON.parse(patch.body);
        assert.equal(body.ifVersion, 3, `${entry.workflow} must send optimistic CAS`);
        assert.equal(body.data.unrelated.keep, true, `${entry.workflow} erased unrelated record data`);
        assert.ok(body.data.title, `${entry.workflow} lost existing fields`);
        assert.equal(result.validationOutput.audit.operation, entry.operation);
        assert.equal(result.validationOutput.audit.submittedBy, 'member-test');
    }
});

test('real Tier-1 engine rejects terminal records and CAS conflicts', { skip: available ? false : skipReason }, () => {
    for (const entry of manifest.workflows.filter((item) => item.method === 'PATCH')) {
        const terminal = runHarness(entry.file, entry.dataset, manifest.persistence.credentialRef, 'terminal');
        assert.equal(terminal.status, 'error', `${entry.workflow} accepted a terminal record`);
        assert.match(String(terminal.error || ''), /record_terminal/);
        assert.equal(terminal.calls.length, 1, `${entry.workflow} must stop after the read`);
        assert.equal(terminal.calls[0].method, 'GET');

        const conflict = runHarness(entry.file, entry.dataset, manifest.persistence.credentialRef, 'conflict');
        assert.equal(conflict.status, 'error', `${entry.workflow} ignored a version conflict`);
        assert.match(String(conflict.error || ''), /409/);
        assert.equal(conflict.calls.length, 2);
    }
});

test('real Tier-1 engine rejects a malformed transition before any HTTP call', { skip: available ? false : skipReason }, () => {
    for (const entry of manifest.workflows.filter((item) => item.method === 'PATCH')) {
        const result = runHarness(entry.file, entry.dataset, manifest.persistence.credentialRef, 'malformed');
        assert.equal(result.status, 'error', `${entry.workflow} accepted a malformed action`);
        assert.equal(result.calls.length, 0, `${entry.workflow} made an HTTP call`);
    }
});

test('real Tier-1 engine rejects a malformed form without an HTTP call', { skip: available ? false : skipReason }, () => {
    for (const entry of manifest.workflows.filter((item) => item.operation.endsWith('.create'))) {
        const result = runHarness(entry.file, entry.dataset, manifest.persistence.credentialRef, 'malformed');
        assert.equal(result.status, 'error', `${entry.workflow} accepted a malformed form`);
        assert.match(String(result.error || ''), /required/);
        assert.equal(result.calls.length, 0, `${entry.workflow} made an HTTP call for a malformed form`);
        assert.deepEqual(result.credentialResolutions, []);
        assert.deepEqual(result.sourceCredentialRefs, ['synapsedx-organization']);
    }
});
