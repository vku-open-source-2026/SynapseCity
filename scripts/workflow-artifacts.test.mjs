// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Product-owned City workflow artifact checks.
 *
 * Creates POST to the Tier-2 records API. Transitions use the Tier-1
 * `httpRequest` option `includeInput:true` to read the current record and carry
 * the validated action fields into a code merge, then PATCH the full merged
 * record with `ifVersion` (optimistic CAS). All auth uses the portable
 * `credentialRef:synapsedx-organization` / `X-API-Key` and public HTTPS Tier-2.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'plugins', 'workflows');
const manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
const API = 'https://synapsedx.sbs/v1/capabilities/datasets';

function readWorkflow(file) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
}
const creates = () => manifest.workflows.filter((entry) => entry.operation.endsWith('.create'));
const transitions = () => manifest.workflows.filter((entry) => entry.method === 'PATCH');

test('manifest is City-owned, source-ready and inactive', () => {
    assert.equal(manifest.format, 'synapsedx-workflow-source');
    assert.equal(manifest.formatVersion, 3);
    assert.equal(manifest.product, 'city');
    assert.equal(manifest.status, 'source_ready_pending_credential_binding');
    assert.equal(manifest.active, false);
    assert.equal(manifest.trigger, 'manualTrigger');
    assert.equal(manifest.repository, 'https://github.com/vku-open-source-2026/SynapseCity');
    assert.deepEqual(manifest.bindingEnvelope, ['pluginId', 'widgetId', 'product', 'resource', 'submittedBy', 'submittedAt', 'fields']);
    assert.equal(manifest.persistence.credentialRef, 'synapsedx-organization');
    assert.equal(manifest.persistence.credentialHeader, 'X-API-Key');
    assert.equal(manifest.persistence.credentialBinding.status, 'pending_dx_binding');
    assert.match(manifest.persistence.credentialBinding.resolvedTo, /owner-only encrypted/);
    assert.equal(manifest.persistence.userSuppliedBinding, 'rejected');
    assert.equal(manifest.pluginWidgetBinding.portableField, 'workflowRef');
    assert.deepEqual(manifest.pluginWidgetBinding.resolvedFields, [
        'workflowArtifactId',
        'workflowArtifactRevision',
        'workflowArtifactChecksum',
    ]);
    assert.deepEqual(creates().map((entry) => entry.operation).sort(), ['incidents.create', 'maintenance.create']);
    assert.deepEqual(transitions().map((entry) => entry.operation).sort(), [
        'incidents.assign',
        'incidents.resolve',
        'maintenance.assign',
        'maintenance.complete',
        'maintenance.start',
    ]);
    for (const entry of manifest.workflows) {
        assert.equal(entry.status, 'source_ready_pending_credential_binding');
        assert.ok(fs.existsSync(path.join(ROOT, entry.file)), entry.file);
        assert.equal(entry.dataset, manifest.persistence.datasetByResource[entry.resource]);
    }
});

test('create flows validate the DX envelope and POST to their fixed dataset', () => {
    for (const entry of creates()) {
        const workflow = readWorkflow(entry.file);
        assert.equal(workflow.name, entry.workflow);
        assert.equal(workflow.nodes.length, 3);

        const [trigger, validate, persist] = workflow.nodes;
        assert.equal(trigger.type, 'manualTrigger');
        assert.equal(validate.type, 'code');
        const code = validate.parameters.code;
        for (const key of manifest.bindingEnvelope) assert.ok(code.includes(key), `${entry.workflow} ignores ${key}`);
        assert.match(code, /unknown_envelope_fields/);
        assert.match(code, /unsupported_product/);
        assert.match(code, /unsupported_resource/);
        assert.match(code, /unknown_fields/);
        assert.ok(code.includes(`dataset: '${entry.dataset}'`));
        assert.ok(!/datasource/i.test(code));
        assert.ok(code.includes('body: { data: record, publish:'));
        if (entry.operation === 'incidents.create') {
            assert.ok(code.includes('publish: true'));
            assert.match(code, /title_required_max_200/);
        } else {
            assert.ok(code.includes('publish: false'));
            assert.match(code, /asset_id_required_max_128/);
        }

        assert.equal(persist.type, 'httpRequest');
        assert.equal(persist.parameters.method, 'POST');
        assert.equal(persist.parameters.url, `${API}/${entry.dataset}/records`);
        assert.deepEqual(persist.parameters.auth, { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: ['https://synapsedx.sbs'] });
        assert.equal(persist.parameters.auth.credentialId, undefined);
        assert.equal(persist.parameters.body, '={{ $json.body }}');
        assert.deepEqual(workflow.connections[trigger.name].main[0][0].node, validate.name);
        assert.deepEqual(workflow.connections[validate.name].main[0][0].node, persist.name);
    }
});

test('transition flows use includeInput, merge invariants and conditional full PATCH', () => {
    for (const entry of transitions()) {
        const workflow = readWorkflow(entry.file);
        assert.equal(workflow.name, entry.workflow);
        const [trigger, validate, read, merge, patch] = workflow.nodes;
        assert.equal(workflow.nodes.length, 5);
        assert.equal(trigger.type, 'manualTrigger');
        assert.equal(validate.type, 'code');
        assert.equal(read.type, 'httpRequest');
        assert.equal(read.parameters.method, 'GET');
        assert.equal(read.parameters.includeInput, true, `${entry.workflow} must preserve the action inputs`);
        assert.ok(read.parameters.url.includes(`${API}/${entry.dataset}/records/`));
        assert.deepEqual(read.parameters.auth, { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: ['https://synapsedx.sbs'] });

        assert.equal(merge.type, 'code');
        const mergeCode = merge.parameters.code;
        assert.match(mergeCode, /response\.input/);
        assert.match(mergeCode, /\.\.\.data, \.\.\.action\.patch/);
        assert.match(mergeCode, /ifVersion: current\.version/);
        assert.match(mergeCode, /record_terminal/);
        assert.match(mergeCode, /record_version_unavailable/);
        if (entry.operation.startsWith('incidents') || entry.operation === 'maintenance.assign' || entry.operation === 'maintenance.start') {
            assert.match(mergeCode, /record_status_invalid/);
        }
        if (entry.operation === 'maintenance.complete') assert.match(mergeCode, /record_not_in_progress/);

        assert.equal(patch.type, 'httpRequest');
        assert.equal(patch.parameters.method, 'PATCH');
        assert.equal(patch.parameters.body, '={{ $json.body }}');
        assert.deepEqual(patch.parameters.auth, { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: ['https://synapsedx.sbs'] });
        assert.deepEqual(workflow.connections[read.name].main[0][0].node, merge.name);
        assert.deepEqual(workflow.connections[merge.name].main[0][0].node, patch.name);
    }
});

test('no artifact writes via a projection, Base SDK or Tier-3 API', () => {
    for (const entry of manifest.workflows) {
        const text = JSON.stringify(readWorkflow(entry.file));
        assert.ok(!/webhook|publish-record|synapseone\.api/.test(text), 'no webhook/LDS/first-party projection node');
        assert.ok(!/synapsecity-sos|sos\.synapsecity\.sbs|\/v1\/emergency/i.test(text), 'no SOS references');
        assert.ok(!/\/v1\/assets|\/v1\/incidents|\/v1\/maintenance/.test(text), 'no Tier-3 API path');
        assert.ok(!/import\s*\(|eval\s*\(|require\s*\(/.test(text), 'validation code must not load remote code');
        const urls = [...text.matchAll(/https?:\/\/[^"']+/g)].map((match) => match[0]);
        for (const url of urls) {
            assert.ok(url === 'https://synapsedx.sbs' || url.startsWith('https://synapsedx.sbs/v1/capabilities/datasets/'), `unexpected URL ${url}`);
        }
    }
});

test('transition action design is implemented and keeps invariants', () => {
    const design = JSON.parse(fs.readFileSync(path.join(DIR, 'actions.design.json'), 'utf8'));
    assert.equal(design.format, 'synapsedx-action-design');
    assert.equal(design.product, 'city');
    assert.equal(design.status, 'implemented_source_ready');
    assert.match(design.implementation, /includeInput/);
    assert.match(design.blocker, /ifVersion/);
    assert.equal(design.credentialRef, manifest.persistence.credentialRef);
    for (const action of design.actions) {
        assert.equal(action.method, 'PATCH');
        assert.ok(action.invariants.length >= 2, `${action.operation} lacks invariants`);
        assert.ok(action.fields.some((field) => field.required));
        assert.ok(action.allowedFrom.length >= 1);
        assert.ok(transitions().some((entry) => entry.operation === action.operation), `${action.operation} has no workflow`);
    }
});

test('plugin bundles bind every form to an executable declarative workflow', () => {
    const workflows = new Set(manifest.workflows.map((entry) => entry.workflow));
    const forms = [];
    for (const name of fs.readdirSync(path.join(ROOT, 'plugins')).filter((file) => file.endsWith('.plugin.json'))) {
        const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', name), 'utf8'));
        for (const widget of bundle.plugin.widgets.filter((item) => item.type === 'form')) {
            forms.push(widget);
            assert.ok(widget.workflowRef && widget.workflowRef.name, `${name}/${widget.id} lacks workflowRef`);
            assert.ok(['create', 'update', 'delete', 'execute'].includes(widget.action), `${name}/${widget.id} action`);
            assert.ok(workflows.has(widget.workflowRef.name), `${name}/${widget.id} references unknown workflow ${widget.workflowRef.name}`);
            assert.ok(widget.fields.length >= 1);
        }
    }
    assert.ok(forms.length >= 5, 'expected bound City forms');
    assert.ok(forms.some((widget) => widget.action === 'create'));
    assert.ok(forms.some((widget) => widget.action === 'update'));
});
