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
import vm from 'node:vm';
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
        const sidecarAware = entry.operation === 'incidents.assign' || entry.operation === 'incidents.resolve';
        assert.equal(workflow.nodes.length, sidecarAware ? 12 : 5);
        const [trigger, validate, read] = workflow.nodes;
        assert.equal(trigger.type, 'manualTrigger');
        assert.equal(validate.type, 'code');
        assert.equal(read.type, 'httpRequest');
        assert.equal(read.parameters.method, 'GET');
        assert.equal(read.parameters.includeInput, true, `${entry.workflow} must preserve the action inputs`);
        assert.ok(read.parameters.url.includes(`${API}/${entry.dataset}/records/`));
        assert.deepEqual(read.parameters.auth, { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: ['https://synapsedx.sbs'] });

        const merge = workflow.nodes.find((node) => node.id === 'merge-record');
        assert.equal(merge.type, 'code');
        const mergeCode = merge.parameters.code;
        assert.match(mergeCode, /response\.input/);
        assert.match(mergeCode, /ifVersion: current\.version/);
        assert.match(mergeCode, /record_version_unavailable/);
        if (!sidecarAware) {
            assert.match(mergeCode, /\.\.\.data, \.\.\.action\.patch/);
            assert.match(mergeCode, /record_terminal/);
        }
        if (entry.operation.startsWith('incidents') || entry.operation === 'maintenance.assign' || entry.operation === 'maintenance.start') {
            assert.match(mergeCode, /record_status_invalid/);
        }
        if (entry.operation === 'maintenance.complete') assert.match(mergeCode, /record_not_in_progress/);

        const patch = workflow.nodes.find((node) => node.id === 'http-patch');
        assert.equal(patch.type, 'httpRequest');
        assert.equal(patch.parameters.method, 'PATCH');
        assert.equal(patch.parameters.body, '={{ $json.body }}');
        assert.ok(patch.parameters.url.includes(`${entry.dataset}/records/`));
        assert.deepEqual(patch.parameters.auth, { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: ['https://synapsedx.sbs'] });
        if (sidecarAware) assert.equal(patch.parameters.includeInput, true);
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

test('incident workflows route private fields to the sidecar and redact actual public writes', () => {
    const internal = [
        'assigned_to', 'reported_by', 'contact_info', 'reporter_type', 'resolution_notes',
        'merged_reporter_ids', 'internal_comments', 'upvoters', 'merge_notes',
    ];
    const runCode = (source, input) => JSON.parse(JSON.stringify(vm.runInNewContext(
        `(function () { ${source}\n })()`,
        { $input: input, $now: '2026-11-26T12:00:00.000Z' },
        { timeout: 1000 },
    )));
    const cases = [
        ['city-incident-comment', { incident_id: 'inc-1', comment: 'Private crew note', is_internal: true }],
        ['city-incident-assign', { incident_id: 'inc-1', assigned_to: 'operator-2' }],
        ['city-incident-resolve', { incident_id: 'inc-1', resolution_notes: 'Fixed privately', resolution_type: 'fixed' }],
        ['city-incident-close', { incident_id: 'inc-1', notes: 'Closed privately' }],
        ['city-incident-reject', { incident_id: 'inc-1', reason: 'Not an issue privately' }],
        ['city-incident-upvote', { incident_id: 'inc-1' }],
        ['city-incident-acknowledge', { incident_id: 'inc-1' }],
        ['city-incident-verify', { incident_id: 'inc-1' }],
        ['city-incident-visibility', { incident_id: 'inc-1', visibility: 'internal' }],
    ];
    for (const [name, fields] of cases) {
        const workflow = readWorkflow(`plugins/workflows/${name}.workflow.json`);
        const action = runCode(workflow.nodes.find((node) => node.id === 'validate-envelope').parameters.code, {
            pluginId: 'plugin-test', widgetId: 'widget-test', product: 'city', resource: 'incidents',
            submittedBy: 'member-test', submittedAt: '2026-11-26T12:00:00.000Z', fields,
        });
        const plan = runCode(workflow.nodes.find((node) => node.id === 'merge-record').parameters.code, {
            statusCode: 200,
            input: action,
            body: {
                version: 3,
                data: {
                    id: 'inc-1', title: 'Broken pump', status: 'reported', assigned_to: 'old-operator',
                    reported_by: 'reporter-private', contact_info: { phone_number: '0900' },
                    reporter_type: 'technician', resolution_notes: 'old private note', upvoters: ['old-user'],
                    comments: [
                        { id: 'public-1', comment: 'Public update', is_internal: false, user_id: 'private-user' },
                        { id: 'internal-1', comment: 'Old private comment', is_internal: true, user_id: 'private-user' },
                    ],
                },
            },
        });
        const prepared = runCode(workflow.nodes.find((node) => node.id === 'prepare-sidecar').parameters.code, {
            statusCode: 200, input: plan, body: { items: [] },
        });
        const publicPatch = workflow.nodes.find((node) => node.id === 'http-patch');
        assert.ok(publicPatch.parameters.url.includes('city-incidents/records/'), `${name}: public destination`);
        assert.ok(prepared.sidecar.url.includes('city-incident-internal/records/'), `${name}: sidecar destination`);
        for (const field of internal) {
            if (field === 'reporter_type') {
                assert.equal(prepared.body.data[field], 'citizen', `${name}: public reporter_type must be sanitized`);
            } else {
                assert.equal(prepared.body.data[field], undefined, `${name}: public write contains ${field}`);
            }
        }
        assert.equal(prepared.body.publish, false, `${name}: public write must stay unpublished`);
        assert.equal(prepared.sidecar.body.publish, false, `${name}: sidecar write must stay private`);
        assert.equal(prepared.body.data.comments.some((entry) => entry.is_internal === true), false);
        assert.equal(prepared.body.data.comments.some((entry) => entry.user_id !== undefined), false);
        assert.equal(prepared.sidecar.body.data.contact_info.phone_number, '0900');
        assert.equal(prepared.sidecar.body.data.reporter_type, 'technician');
        assert.ok(prepared.sidecar.body.data.internal_comments.some((entry) => entry.id === 'internal-1'));
        if (name === 'city-incident-comment') {
            assert.equal(prepared.body.data.comments.length, 1);
            assert.ok(prepared.sidecar.body.data.internal_comments.some((entry) => entry.comment === 'Private crew note'));
        }
        if (name === 'city-incident-assign') assert.equal(prepared.sidecar.body.data.assigned_to, 'operator-2');
        if (name === 'city-incident-resolve') assert.equal(prepared.sidecar.body.data.resolution_notes, 'Fixed privately');
        if (name === 'city-incident-close') assert.equal(prepared.sidecar.body.data.resolution_notes, 'Closed privately');
        if (name === 'city-incident-reject') assert.equal(prepared.sidecar.body.data.resolution_notes, 'Not an issue privately');
        if (name === 'city-incident-upvote') {
            assert.ok(prepared.sidecar.body.data.upvoters.includes('member-test'));
            assert.equal(prepared.body.data.upvotes, 1);
        }

        const existing = runCode(workflow.nodes.find((node) => node.id === 'prepare-sidecar').parameters.code, {
            statusCode: 200,
            input: plan,
            body: { items: [{ id: 'internal-inc-1', version: 7, data: { contact_info: { phone_number: '0900' }, internal_notes: 'keep me' } }] },
        });
        assert.equal(existing.sidecar.exists, true);
        assert.equal(existing.sidecar.body.ifVersion, 7);
        assert.equal(existing.sidecar.body.data.internal_notes, 'keep me');
    }

    const merge = readWorkflow('plugins/workflows/city-incident-merge.workflow.json');
    const mergeAction = runCode(merge.nodes.find((node) => node.id === 'validate-envelope').parameters.code, {
        pluginId: 'plugin-test', widgetId: 'widget-test', product: 'city', resource: 'incidents',
        submittedBy: 'member-test', submittedAt: '2026-11-26T12:00:00.000Z',
        fields: { incident_id: 'inc-1', duplicate_ids: 'dup-1', merge_notes: 'Private merge note' },
    });
    const primaryPlan = runCode(merge.nodes.find((node) => node.id === 'prepare-query').parameters.code, {
        statusCode: 200, input: mergeAction,
        body: { version: 3, data: { id: 'inc-1', title: 'Primary', status: 'reported', merged_reporter_ids: ['legacy-private'] } },
    });
    const duplicatePlan = runCode(merge.nodes.find((node) => node.id === 'plan-closes').parameters.code, {
        statusCode: 200, input: primaryPlan,
        body: { items: [{ id: 'dup-1', version: 4, data: { id: 'dup-1', status: 'reported', assigned_to: 'private-tech', resolution_notes: 'old private', comments: [] } }] },
    });
    for (const field of internal) {
        if (field === 'reporter_type') {
            assert.equal(duplicatePlan.slots[0].body.data[field], 'citizen', `merge public write must sanitize ${field}`);
        } else {
            assert.equal(duplicatePlan.slots[0].body.data[field], undefined, `merge public write contains ${field}`);
        }
    }
    assert.equal(duplicatePlan.slots[0].body.data.resolution_notes, undefined);
    const collected = runCode(merge.nodes.find((node) => node.id === 'collect-closed-duplicates').parameters.code, {
        statusCode: 200, input: duplicatePlan,
        body: { items: [{ id: 'dup-1', data: { status: 'closed', merged_into: 'inc-1' } }] },
    });
    const primarySidecar = runCode(merge.nodes.find((node) => node.id === 'merge-primary').parameters.code, {
        statusCode: 200, input: collected, body: { items: [] },
    });
    assert.ok(primarySidecar.sidecar.url.includes('city-incident-internal/records/'));
    assert.equal(primarySidecar.sidecar.body.data.merge_notes, 'Private merge note');
    assert.deepEqual(primarySidecar.sidecar.body.data.merged_reporter_ids, ['dup-1', 'legacy-private']);
    const publicWrites = merge.nodes.filter((node) => node.id.startsWith('patch-duplicate-'));
    assert.equal(publicWrites.length, 5, 'merge only writes redacted public duplicate closes');
    assert.ok(duplicatePlan.slots[0].url.includes('city-incidents/records/'));

    const genericArtifact = readWorkflow('plugins/workflows/city-workspace-actions.workflow.json');
    const genericValidate = genericArtifact.nodes.find((node) => node.name === 'Validate envelope and select operation');
    const genericCreate = runCode(genericValidate.parameters.code, {
        pluginId: 'plugin-test', widgetId: 'widget-test', product: 'city', resource: 'incidents',
        action: 'create', submittedBy: 'member-test',
        fields: { title: 'Public incident', category: 'damage', severity: 'low' },
    });
    for (const field of internal) {
        if (field === 'reporter_type') {
            assert.equal(genericCreate.body.data[field], 'citizen');
        } else {
            assert.equal(genericCreate.body.data[field], undefined);
        }
    }
    const genericUpdate = runCode(genericValidate.parameters.code, {
        pluginId: 'plugin-test', widgetId: 'widget-test', product: 'city', resource: 'incidents',
        action: 'update', submittedBy: 'member-test',
        fields: { record_id: 'inc-1', status: 'assigned' },
    });
    assert.equal(genericUpdate.resource, 'incidents');
    const genericMerge = genericArtifact.nodes.find((node) => node.name === 'Merge and enforce invariants');
    const genericPublic = runCode(genericMerge.parameters.code, {
        statusCode: 200,
        input: genericUpdate,
        body: { version: 1, data: { id: 'inc-1', status: 'reported', title: 'Public incident' } },
    });
    assert.equal(genericPublic.body.publish, false);
    assert.throws(() => runCode(genericValidate.parameters.code, {
        pluginId: 'plugin-test', widgetId: 'widget-test', product: 'city', resource: 'incidents',
        action: 'update', submittedBy: 'member-test',
        fields: { record_id: 'inc-1', notes: 'private note' },
    }), /incident_notes_require_dedicated_workflow/);
    assert.throws(() => runCode(genericMerge.parameters.code, {
        statusCode: 200,
        input: { resource: 'incidents', patch: { status: 'assigned' }, url: 'unused', audit: {} },
        body: { version: 1, data: { id: 'inc-1', status: 'reported', assigned_to: 'private-tech' } },
    }), /incident_private_fields_require_sidecar_workflow/);

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
    // annotates the private primary sidecar with duplicates actually closed.
    const plan = merge.nodes.find((node) => node.name === 'Plan duplicate closes');
    assert.match(plan.parameters.code, /while \(slots\.length < 5\)/);
    const collect = merge.nodes.find((node) => node.id === 'collect-closed-duplicates');
    assert.match(collect.parameters.code, /merged_into\) === String\(state\.primary\.id\)/);
    const annotate = merge.nodes.find((node) => node.name === 'Merge primary annotation');
    assert.match(annotate.parameters.code, /new Set\(\[\.\.\.existing, \.\.\.closedIds\]\)/);
    assert.match(annotate.parameters.code, /merge_notes: state\.mergeNotes/);
    assert.match(annotate.parameters.code, /publish: false/);
    const publicCloses = merge.nodes.filter((node) => node.id.startsWith('patch-duplicate-'));
    assert.equal(publicCloses.length, 5, 'five redacted duplicate closes');
    assert.ok(merge.nodes.some((node) => node.id === 'http-patch-primary-sidecar'));
    assert.ok(merge.nodes.some((node) => node.id === 'http-create-primary-sidecar'));
    for (const close of publicCloses) {
        assert.equal(close.parameters.auth.credentialRef, 'synapsedx-organization');
    }

    const upvote = readWorkflow('plugins/workflows/city-incident-upvote.workflow.json');
    const decide = upvote.nodes.find((node) => node.name === 'Decide upvote path and version');
    assert.match(decide.parameters.code, /publicRecord/);
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
