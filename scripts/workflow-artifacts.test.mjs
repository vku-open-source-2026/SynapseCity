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
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBundle, canonicalJson } from './lib/plugin-bundle.mjs';

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
    // Artifacts exist and are engine-tested: the bundle is source-ready. The
    // credential binding is an operator action tracked separately in
    // persistence.credentialBinding (pending_dx_binding) and the deployment
    // gate; it is not part of the source status.
    assert.equal(manifest.status, 'source_ready');
    assert.equal(manifest.active, false);
    assert.equal(manifest.trigger, 'manualTrigger');
    assert.equal(manifest.repository, 'https://github.com/vku-open-source-2026/SynapseCity');
    assert.deepEqual(manifest.bindingEnvelope, ['pluginId', 'widgetId', 'product', 'resource', 'submittedBy', 'submittedAt', 'fields', 'action']);
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
        assert.equal(entry.status, 'source_ready');
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
            // Incidents are never written straight to the public projection;
            // City allocates the number and owns publication.
            assert.ok(code.includes('publish: false'));
            assert.match(code, /title_required_max_200/);
            assert.match(code, /incident_number/);
            assert.match(code, /created_at/);
            assert.match(code, /public_visible/);
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
    for (const entry of manifest.workflows.concat(manifest.domainWorkflows || [])) {
        const text = JSON.stringify(readWorkflow(entry.file));
        assert.ok(!/webhook|publish-record|synapseone\.api/.test(text), 'no webhook/LDS/first-party projection node');
        assert.ok(!/synapsecity-sos|sos\.synapsecity\.sbs|\/v1\/emergency/i.test(text), 'no SOS references');
        assert.ok(!/\/v1\/assets|\/v1\/incidents|\/v1\/maintenance/.test(text), 'no Tier-3 API path');
        assert.ok(!/import\s*\(|eval\s*\(|require\s*\(/.test(text), 'validation code must not load remote code');
        const urls = [...text.matchAll(/https?:\/\/[^"']+/g)].map((match) => match[0]);
        for (const url of urls) {
            // Public Tier-2 only: dataset records plus the files capability the
            // tracked file-action workflows (city-csv-import) already use.
            assert.ok(
                url === 'https://synapsedx.sbs'
                    || url.startsWith('https://synapsedx.sbs/v1/capabilities/datasets/')
                    || url.startsWith('https://synapsedx.sbs/v1/capabilities/files/'),
                `unexpected URL ${url}`,
            );
        }
    }
});

test('incident workflows keep internal fields out of public writes', () => {
    const internal = ['assigned_to', 'reporter_type', 'resolution_notes'];
    const incidentFiles = manifest.workflows
        .concat(manifest.lifecycleWorkflows || [])
        .concat((manifest.domainWorkflows || []).filter((entry) => entry.resource === 'incidents'))
        .filter((entry) => entry.resource === 'incidents');
    for (const entry of incidentFiles) {
        const workflow = readWorkflow(entry.file);
        const writes = workflow.nodes.filter((node) =>
            node.type === 'httpRequest' && ['POST', 'PATCH'].includes(node.parameters.method));
        assert.ok(writes.length > 0, `${entry.workflow} has no write node`);
        for (const write of writes) {
            if (write.parameters.method === 'PATCH') {
                const merge = workflow.nodes.find((node) => node.type === 'code' && node.parameters.code.includes('publish: false'));
                assert.ok(merge, `${entry.workflow} PATCH must stay unpublished`);
            } else {
                const body = write.parameters.body;
                const code = workflow.nodes
                    .filter((node) => node.type === 'code')
                    .map((node) => node.parameters.code)
                    .join('\n');
                assert.ok(
                    body.includes('publish: false') || code.includes('publish: false'),
                    `${entry.workflow} POST must stay private`,
                );
            }
        }
    }

    // The public incident create artifact and the generic incident schema carry
    // no internal operator field at all.
    const create = readWorkflow('plugins/workflows/city-incident-create.workflow.json');
    const createText = JSON.stringify(create);
    for (const field of internal) {
        assert.ok(!createText.includes(`"${field}"`), `incident create exposes ${field}`);
    }
    const generic = readWorkflow('plugins/workflows/city-workspace-actions.workflow.json');
    const code = generic.nodes.find((node) => node.name === 'Validate envelope and select operation').parameters.code;
    const incidentStart = code.indexOf('"incidents":{');
    const incidentEnd = code.indexOf(',"maintenance":', incidentStart);
    assert.ok(incidentStart !== -1 && incidentEnd > incidentStart, 'incident schema is missing');
    const incidentSchema = code.slice(incidentStart, incidentEnd);
    assert.match(incidentSchema, /"publish":false/);
    for (const field of internal) {
        assert.ok(!incidentSchema.includes(`"${field}"`), `generic incident schema exposes ${field}`);
    }
    const allCode = generic.nodes
        .filter((node) => node.type === 'code')
        .map((node) => node.parameters.code)
        .join('\n');
    assert.match(allCode, /action\.resource === 'incidents' \? \{ publish: false \}/);
    // Role/permission elevation stays behind City user administration.
    const usersStart = code.indexOf('"users":{');
    const usersEnd = code.indexOf(',"geofences":', usersStart);
    assert.ok(usersStart !== -1 && usersEnd > usersStart, 'users schema is missing');
    const usersSchema = code.slice(usersStart, usersEnd);
    assert.ok(!usersSchema.includes('"role":{"kind"'), 'users schema exposes role');
    assert.ok(!usersSchema.includes('"permissions_json"'), 'users schema exposes permissions');
    assert.match(usersSchema, /"defaults":\{"status":"active","role":"citizen"\}/);
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

test('domain workflows pin their portable graph checksum and keep incident writes private', () => {
    const canonicalJson = (value) => {
        if (value === null || typeof value !== 'object') return JSON.stringify(value);
        if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
    };
    const graphChecksum = (workflow) =>
        `sha256:${createHash('sha256').update(canonicalJson({
            nodes: workflow.nodes,
            connections: workflow.connections,
            settings: workflow.settings || {},
        }), 'utf8').digest('hex')}`;

    const domainEntries = manifest.domainWorkflows || [];
    assert.ok(domainEntries.length >= 4, 'the incident domain batch is registered');
    const byWorkflow = new Map(domainEntries.map((entry) => [entry.workflow, entry]));
    const bundleDir = path.join(ROOT, 'plugins');
    for (const name of fs.readdirSync(bundleDir).filter((file) => file.endsWith('.plugin.json'))) {
        const bundle = JSON.parse(fs.readFileSync(path.join(bundleDir, name), 'utf8'));
        for (const widget of bundle.plugin.widgets.filter((item) => item.type === 'form' && byWorkflow.has(item.workflowRef?.name))) {
            const entry = byWorkflow.get(widget.workflowRef.name);
            const workflow = readWorkflow(entry.file);
            // The pin must equal the portable workflow graph checksum so the
            // DX source import produces an artifact this plugin resolves to.
            assert.equal(
                `sha256:${widget.workflowRef.checksum}`,
                graphChecksum(workflow),
                `${name}/${widget.id} pins a stale ${entry.workflow} checksum`,
            );
            assert.equal(workflow.settings?.access?.mode, 'owner-only', `${entry.workflow} must be owner-only`);
        }
    }

    const merge = readWorkflow('plugins/workflows/city-incident-merge.workflow.json');
    // The merge orchestration caps duplicates at the fixed slot count and only
    // annotates the primary with duplicates that are actually closed.
    const plan = merge.nodes.find((node) => node.name === 'Plan duplicate closes');
    assert.match(plan.parameters.code, /while \(slots\.length < 5\)/);
    const annotate = merge.nodes.find((node) => node.name === 'Merge primary annotation');
    assert.match(annotate.parameters.code, /merged_into\) === String\(primaryId\)/);
    assert.match(annotate.parameters.code, /new Set\(\[\.\.\.existing, \.\.\.closedIds\]\)/);
    assert.match(annotate.parameters.code, /publish: false/);
    const closes = merge.nodes.filter((node) => node.type === 'httpRequest' && node.parameters.method === 'PATCH');
    assert.equal(closes.length, 6, 'five duplicate closes plus the primary annotation');
    for (const close of closes) {
        assert.equal(close.parameters.auth.credentialRef, 'synapsedx-organization');
    }

    const upvote = readWorkflow('plugins/workflows/city-incident-upvote.workflow.json');
    const decide = upvote.nodes.find((node) => node.name === 'Decide upvote path and version');
    assert.match(decide.parameters.code, /upvoters\.includes\(action\.submitter\)/);
    assert.match(decide.parameters.code, /publish: false/);
});

test('product forms bind executable workflows; Common forms retain app-scoped capability actions', () => {
    const workflows = new Set([
        ...manifest.workflows.map((entry) => entry.workflow),
        ...(manifest.lifecycleWorkflows || []).map((entry) => entry.workflow),
        ...(manifest.domainWorkflows || []).map((entry) => entry.workflow),
        ...(manifest.fileActionWorkflows || []).map((entry) => entry.workflow),
    ]);
    if (manifest.genericActionWorkflow?.workflow) workflows.add(manifest.genericActionWorkflow.workflow);
    const forms = [];
    for (const name of fs.readdirSync(path.join(ROOT, 'plugins')).filter((file) => file.endsWith('.plugin.json'))) {
        const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', name), 'utf8'));
        assert.deepEqual(validateBundle(bundle).errors, [], name);
        for (const widget of bundle.plugin.widgets.filter((item) => item.type === 'form')) {
            const submit = bundle.plugin.widgets.find(item => item.id === widget.onSubmit)?.operation;
            assert.equal(submit?.target, widget.id, `${name}/${widget.id}: missing submit action`);
            assert.equal(submit?.kind === "batch" ? "execute" : submit?.kind, widget.action, `${name}/${widget.id}: wrong submit operation`);
            if (widget.resource.startsWith('common')) {
                assert.equal(widget.workflowRef, undefined, 'Common uses the app-scoped capability, never a product workflow');
                continue;
            }
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

test('bundle workflow pins equal the DX portable checksum of the committed source', () => {
    // DX injects settings.access.mode=owner-only on every managed import and
    // resolves bundle refs against that portable checksum; a stale pin makes a
    // live import fail with workflow_artifact_not_found. scripts/workflow-pins.mjs
    // --fix repairs this class of drift.
    const withOwnerOnly = (settings) => {
        const base = settings && typeof settings === 'object' && !Array.isArray(settings) ? { ...settings } : {};
        const access = base.access && typeof base.access === 'object' && !Array.isArray(base.access) ? { ...base.access } : {};
        access.mode = 'owner-only';
        base.access = access;
        return base;
    };
    const portable = new Map();
    for (const file of fs.readdirSync(DIR).filter((name) => name.endsWith('.workflow.json'))) {
        const definition = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
        assert.equal(
            definition.settings?.access?.mode,
            'owner-only',
            `${file} must declare settings.access.mode=owner-only like a DX-managed import`,
        );
        portable.set(definition.name || file.replace(/\.workflow\.json$/, ''), createHash('sha256').update(canonicalJson({
            nodes: definition.nodes,
            connections: definition.connections,
            settings: withOwnerOnly(definition.settings),
        }), 'utf8').digest('hex'));
    }
    for (const file of fs.readdirSync(path.join(ROOT, 'plugins')).filter((name) => name.endsWith('.plugin.json'))) {
        const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugins', file), 'utf8'));
        for (const widget of bundle.plugin.widgets) {
            const ref = widget.workflowRef;
            if (!ref) continue;
            assert.ok(portable.has(ref.name), `${file}/${widget.id} references unknown workflow ${ref.name}`);
            assert.equal(
                ref.checksum,
                portable.get(ref.name),
                `${file}/${widget.id} -> ${ref.name}: pin must equal the DX portable checksum (run node scripts/workflow-pins.mjs --fix)`,
            );
        }
    }
});
