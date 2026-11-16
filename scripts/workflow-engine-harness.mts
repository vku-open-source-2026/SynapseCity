// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * LOCAL TEST-ONLY harness: execute a Tier-3 workflow artifact through the real
 * Tier-1 SynapseFlow engine with a fake HTTP transport.
 *
 * Modes: create | transition | close, plus good|malformed|terminal|conflict.
 * It simulates DX server-side credentialRef binding in memory only and never
 * uses a real credential, network, deployment or Docker.
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };

const [workflowPath, dataset, credentialRef, mode] = process.argv.slice(2);
if (!workflowPath || !dataset || !credentialRef || !['good', 'malformed', 'terminal', 'conflict'].includes(mode || '')) {
    console.log(JSON.stringify({ ok: false, error: 'usage: <workflow.json> <dataset> <credentialRef> <good|malformed|terminal|conflict>' }));
    process.exit(2);
}

const enginePath = process.env.SYNAPSEONE_ENGINE
    || new URL('../../../SynapseOne/apps/workflow-service/src/engine.ts', import.meta.url).pathname;
if (!fs.existsSync(enginePath)) {
    console.log(JSON.stringify({ ok: false, error: 'engine_not_found', enginePath }));
    process.exit(3);
}

const { runWorkflow } = await import(pathToFileURL(enginePath).href) as {
    runWorkflow: (definition: unknown, input: unknown, options: unknown) => Promise<{
        status: string;
        error?: string;
        output: unknown;
        nodeRuns: Array<{ node: string; type: string; output: unknown; status: string; error?: string }>;
    }>;
};

const kind = workflowPath.includes('create') ? 'create'
    : workflowPath.includes('close') ? 'close'
        : 'transition';
const calls: Call[] = [];
const credentialResolutions: string[] = [];
const BOUND_CREDENTIAL_ID = 'bound-test-credential';

const ids: Record<string, string> = {
    incident: 'incident-1',
    maintenance: 'wo-1',
    dispatch: 'dispatch-1',
    event: 'event-1',
};
const subject = workflowPath.includes('maintenance') ? 'maintenance'
    : workflowPath.includes('incident') ? 'incident'
        : workflowPath.includes('dispatch') ? 'dispatch' : 'event';
const recordId = ids[subject];
const terminal = mode === 'terminal';
const record = (() => {
    if (subject === 'incident') {
        return {
            id: recordId,
            data: { id: recordId, type: 'Incident', title: 'Existing incident', description: 'keep me', category: 'damage', severity: 'high', status: terminal ? 'resolved' : 'reported', assigned_to: 'old-operator', unrelated: { keep: true } },
            version: 3,
        };
    }
    if (subject === 'maintenance') {
        return {
            id: recordId,
            data: { id: recordId, type: 'Maintenance', title: 'Existing work order', description: 'keep me', asset_id: 'asset-1', priority: 'medium', status: terminal ? 'completed' : (workflowPath.includes('complete') ? 'in_progress' : 'scheduled'), assigned_to: 'tech-old', unrelated: { keep: true } },
            version: 3,
        };
    }
    if (subject === 'dispatch') {
        return {
            id: recordId,
            data: { id: recordId, type: 'DispatchOrder', emergency_event_id: 'event-1', task_title: 'Existing task', status: terminal ? 'completed' : 'pending', priority: 'medium', assignments: [], metadata: { keep: true } },
            version: 4,
        };
    }
    return {
        id: recordId,
        data: { id: recordId, type: 'EmergencyEvent', title: 'Existing event', description: 'keep me', event_type: 'flood', severity: 'high', status: terminal ? 'resolved' : 'active', metadata: { keep: true } },
        version: 5,
    };
})();

globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = init.headers || {};
    if (rawHeaders instanceof Headers) rawHeaders.forEach((value, key) => { headers[key.toLowerCase()] = value; });
    else if (Array.isArray(rawHeaders)) for (const [key, value] of rawHeaders) headers[String(key).toLowerCase()] = String(value);
    else for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) headers[key.toLowerCase()] = String(value);
    const method = String(init.method || 'GET').toUpperCase();
    const body = init.body ? String(init.body) : null;
    calls.push({ url, method, headers, body });

    const pathDataset = url.includes('/datasets/') ? url.split('/datasets/')[1].split('/')[0] : dataset;
    if (url.includes('/records/query')) {
        if (pathDataset === 'sos-dispatch-orders') {
            return Response.json({ items: [
                { id: 'dispatch-1', status: 'completed', created_at: '2026-11-14T00:00:00.000Z', assigned_resource_unit_id: 'resource-1', assignments: [{ assigned_at: '2026-11-14T00:10:00.000Z' }] },
            ], total: 1, limit: 100, offset: 0 });
        }
        if (pathDataset === 'sos-sitreps') {
            return Response.json({ items: [
                { id: 'sitrep-1', status: 'published', created_at: '2026-11-14T00:20:00.000Z' },
            ], total: 1, limit: 100, offset: 0 });
        }
        return Response.json({ items: [
            { id: 'resource-1', status: 'deployed' },
            { id: 'resource-2', status: 'available' },
        ], total: 2, limit: 200, offset: 0 });
    }

    if (method === 'GET') {
        return Response.json(record);
    }
    if (method === 'PATCH') {
        if (mode === 'conflict') {
            return Response.json({ error: 'version_conflict', message: 'record was modified' }, { status: 409 });
        }
        const parsed = body ? JSON.parse(body) : {};
        return Response.json({ id: recordId, data: parsed.data, version: record.version + 1 });
    }
    if (method === 'POST') {
        const parsed = body ? JSON.parse(body) : {};
        const created = { id: pathDataset === 'sos-after-action-reports' ? 'aar-event-1-v1' : 'record-test-1', data: parsed.data, version: 1 };
        return Response.json(created, { status: 201 });
    }
    return Response.json({ error: 'unexpected' }, { status: 500 });
}) as typeof fetch;

const definition = JSON.parse(fs.readFileSync(workflowPath, 'utf8'));
const sourceCredentialRefs: string[] = [];
for (const node of definition.nodes || []) {
    const auth = node?.parameters?.auth;
    if (node?.type === 'httpRequest' && auth?.credentialRef) {
        sourceCredentialRefs.push(String(auth.credentialRef));
        auth.credentialId = BOUND_CREDENTIAL_ID;
    }
}

const baseEnvelope = {
    pluginId: 'plugin-test',
    widgetId: 'widget-test',
    product: workflowPath.includes('SynapseCitySOS') ? 'sos' : 'city',
    resource: subject === 'incident' ? 'incidents'
        : subject === 'maintenance' ? 'maintenance'
            : subject === 'dispatch' ? 'dispatch' : 'events',
    submittedBy: 'member-test',
    submittedAt: '2026-11-14T00:00:00.000Z',
    fields: {},
};
const createFields: Record<string, string> = {
    title: 'Bridge inspection',
    description: 'Cracked support beam',
    category: 'damage',
    severity: 'high',
    asset_id: 'asset-1',
    priority: 'high',
    scheduled_date: '2026-11-20',
    event_type: 'flood',
    emergency_event_id: 'event-1',
    task_title: 'Deploy rescue boat',
    task_description: 'Check the low-lying ward',
};
const transitionFields: Record<string, string> = subject === 'incident'
    ? (workflowPath.includes('resolve')
        ? { incident_id: recordId, resolution_notes: 'Fixed the span', resolution_type: 'fixed' }
        : { incident_id: recordId, assigned_to: 'operator-2' })
    : subject === 'maintenance'
        ? (workflowPath.includes('assign')
            ? { work_order_id: recordId, assigned_to: 'tech-2' }
            : { work_order_id: recordId })
        : subject === 'dispatch'
            ? { order_id: recordId }
            : { event_id: recordId, resolution_note: 'Event closed after final sweep' };
if (mode === 'malformed') {
    baseEnvelope.fields = { description: 'malformed submission' };
} else if (kind === 'create') {
    baseEnvelope.fields = Object.fromEntries(Object.entries(createFields).filter(([key]) => {
        if (workflowPath.includes('incident')) return ['title', 'description', 'category', 'severity'].includes(key);
        if (workflowPath.includes('maintenance')) return ['asset_id', 'title', 'description', 'priority', 'scheduled_date'].includes(key);
        if (workflowPath.includes('event')) return ['title', 'description', 'event_type', 'severity'].includes(key);
        return ['emergency_event_id', 'task_title', 'task_description', 'priority'].includes(key);
    }));
} else {
    baseEnvelope.fields = transitionFields;
}

let result;
try {
    result = await runWorkflow(definition, baseEnvelope, {
        name: 'tier3-workflow-engine-test',
        principal: { sub: 'member-test', kind: 'user' },
        credentialResolver: async (id: string) => {
            credentialResolutions.push(id);
            return id === BOUND_CREDENTIAL_ID ? { kind: 'api-key', secret: 'test-api-key-secret' } : null;
        },
    });
} catch (error) {
    console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error), calls, credentialResolutions, sourceCredentialRefs }));
    process.exit(1);
}

const validationRun = result.nodeRuns.find((run) => run.node.startsWith('Validate DX envelope'));
console.log(JSON.stringify({
    ok: true,
    kind,
    status: result.status,
    error: result.error,
    calls,
    credentialResolutions,
    sourceCredentialRefs,
    validationOutput: validationRun?.output ?? null,
    nodeRuns: result.nodeRuns.map((run) => ({ node: run.node, type: run.type, status: run.status, error: run.error })),
}));
