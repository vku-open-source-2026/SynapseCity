// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Regenerate the generic City workspace-action workflow.
 *
 * The workflow is intentionally declarative product source: every operation is
 * a form binding resolved by DX, and the actual write goes through the Tier-2
 * records API with the organization technical credential. This file is a
 * generator so the large field allowlist stays reviewable instead of being
 * hand-edited inside JSON.
 *
 * Usage: node plugins/workflows/generate-workspace-actions.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const DX = 'https://synapsedx.sbs';
const PRODUCT = 'city';

const S = (max = 4000) => ({ kind: 'text', max });
const N = () => ({ kind: 'number' });
const DATE = () => ({ kind: 'date' });
const JSONV = () => ({ kind: 'json' });
const BOOL = () => ({ kind: 'boolean' });

/**
 * Field allowlists are deliberately flat. Nested domain objects use `*_json`
 * fields and are parsed by the validation node; the browser never executes
 * this code and never chooses a dataset or URL.
 */
const SCHEMAS = {
  assets: {
    dataset: 'city-assets', recordType: 'Asset', publish: true, terminal: ['retired', 'disposed'],
    statuses: ['active', 'inactive', 'maintenance', 'retired', 'disposed'],
    fields: {
      asset_code: S(120), name: S(200), feature_type: S(80), feature_code: S(120), category: S(80),
      status: S(40), condition: S(40), lifecycle_stage: S(60), address: S(300), ward: S(120),
      district: S(120), city: S(120), owner: S(160), managing_unit: S(160), description: S(4000),
      latitude: N(), longitude: N(), properties_json: JSONV(),
    },
    required: ['name'],
    defaults: { status: 'active' },
  },
  incidents: {
    dataset: 'city-incidents', recordType: 'Incident', publish: true,
    terminal: ['closed', 'cancelled', 'rejected', 'merged'],
    statuses: ['reported', 'open', 'acknowledged', 'assigned', 'investigating', 'in_progress', 'waiting_approval', 'resolved', 'verified', 'closed', 'rejected', 'cancelled', 'merged'],
    fields: {
      title: S(200), description: S(4000), category: S(80), severity: S(40), status: S(40),
      priority: S(40), asset_id: S(128), assigned_to: S(160), reporter_type: S(40),
      resolution_type: S(80), resolution_notes: S(4000), address: S(300), latitude: N(), longitude: N(),
      details_json: JSONV(),
    },
    required: ['title'],
    defaults: { status: 'reported', severity: 'medium' },
  },
  maintenance: {
    dataset: 'city-maintenance', recordType: 'Maintenance', publish: false,
    terminal: ['completed', 'cancelled', 'rejected'],
    statuses: ['scheduled', 'assigned', 'in_progress', 'on_hold', 'completed', 'cancelled', 'rejected'],
    fields: {
      asset_id: S(128), title: S(200), description: S(4000), priority: S(40), status: S(40),
      type: S(40), scheduled_date: DATE(), assigned_to: S(160), technician: S(160),
      estimated_cost: N(), actual_cost: N(), work_performed: S(4000), notes: S(4000),
      approval_status: S(40), rejection_reason: S(4000), parts_json: JSONV(),
    },
    required: ['title'],
    defaults: { status: 'scheduled', priority: 'medium' },
  },
  iot: {
    dataset: 'city-iot-sensors', recordType: 'IoTSensor', publish: false,
    terminal: ['retired'],
    statuses: ['active', 'inactive', 'offline', 'maintenance', 'retired'],
    fields: {
      sensor_code: S(120), asset_id: S(128), sensor_type: S(40), status: S(40),
      measurement_unit: S(40), longitude: N(), latitude: N(), threshold_json: JSONV(),
    },
    required: ['sensor_code', 'asset_id', 'sensor_type'],
    defaults: { status: 'active' },
  },
  iotReadings: {
    dataset: 'city-iot-readings', recordType: 'SensorReading', publish: false,
    terminal: [], statuses: [],
    fields: { sensor_id: S(128), timestamp: DATE(), value: N(), metadata_json: JSONV() },
    required: ['sensor_id', 'value'],
    defaults: {},
  },
  alerts: {
    dataset: 'city-alerts', recordType: 'Alert', publish: false,
    terminal: ['resolved', 'dismissed'],
    statuses: ['active', 'acknowledged', 'resolved', 'dismissed'],
    fields: {
      alert_type: S(80), severity: S(40), status: S(40), asset_id: S(128), sensor_id: S(128),
      message: S(4000), metadata_json: JSONV(), resolution_notes: S(4000),
    },
    required: ['message'],
    defaults: { status: 'active', severity: 'medium' },
  },
  budgets: {
    dataset: 'city-budgets', recordType: 'Budget', publish: false,
    terminal: ['approved', 'rejected', 'closed'],
    statuses: ['draft', 'submitted', 'approved', 'rejected', 'closed'],
    fields: {
      budget_code: S(120), fiscal_year: N(), category: S(120), total_amount: N(),
      allocated_amount: N(), spent_amount: N(), status: S(40), breakdown_json: JSONV(),
    },
    required: ['fiscal_year', 'category', 'total_amount'],
    defaults: { status: 'draft', allocated_amount: 0, spent_amount: 0 },
  },
  budgetTransactions: {
    dataset: 'city-budget-transactions', recordType: 'BudgetTransaction', publish: false,
    terminal: [], statuses: ['pending', 'approved', 'rejected'],
    fields: {
      budget_id: S(128), amount: N(), description: S(4000), transaction_type: S(40),
      maintenance_id: S(128), approved_at: DATE(), status: S(40),
    },
    required: ['budget_id', 'amount', 'description', 'transaction_type'],
    defaults: { status: 'pending' },
  },
  reports: {
    dataset: 'city-reports', recordType: 'Report', publish: false,
    terminal: ['failed', 'archived'],
    statuses: ['pending', 'generating', 'completed', 'failed', 'archived'],
    fields: {
      report_code: S(120), type: S(40), format: S(20), status: S(40),
      parameters_json: JSONV(), file_url: S(1000), row_count: N(),
    },
    required: ['type', 'format'],
    defaults: { status: 'pending' },
  },
  users: {
    dataset: 'city-users', recordType: 'CityUser', publish: false,
    terminal: ['deleted'],
    statuses: ['active', 'inactive', 'suspended', 'deleted'],
    fields: {
      username: S(120), email: S(320), full_name: S(200), phone: S(40), role: S(40),
      status: S(40), department: S(160), permissions_json: JSONV(),
    },
    required: ['username', 'email', 'full_name', 'role'],
    defaults: { status: 'active' },
  },
  geofences: {
    dataset: 'city-geofences', recordType: 'Geofence', publish: false,
    terminal: [],
    statuses: ['active', 'inactive'],
    fields: {
      name: S(200), type: S(80), description: S(4000), active: BOOL(), category: S(80),
      geometry_json: JSONV(),
    },
    required: ['name'],
    defaults: { active: true },
  },
  ingest: {
    dataset: 'city-ingest-jobs', recordType: 'IngestJob', publish: false,
    terminal: ['completed', 'failed'],
    statuses: ['queued', 'running', 'completed', 'failed'],
    fields: {
      source: S(80), dataset: S(120), file_name: S(300), status: S(40),
      rows_total: N(), rows_imported: N(), error_message: S(4000),
    },
    required: ['source'],
    defaults: { status: 'queued' },
  },
  files: {
    dataset: 'city-files', recordType: 'File', publish: false,
    terminal: [], statuses: [],
    fields: { name: S(300), content_type: S(120), size: N(), checksum: S(128), url: S(1000) },
    required: ['name'],
    defaults: {},
  },
  notifications: {
    dataset: 'city-notifications', recordType: 'Notification', publish: false,
    terminal: [], statuses: [],
    fields: { user_id: S(128), title: S(200), message: S(4000), type: S(40), read: BOOL() },
    required: ['title'],
    defaults: { read: false },
  },
};

// Decision aliases for approval/publish-style execute forms.
const DECISIONS = {
  budgets: { approve: 'approved', reject: 'rejected', close: 'closed' },
  budgetTransactions: { approve: 'approved', reject: 'rejected' },
  maintenance: { approve: 'approved', reject: 'rejected' },
  reports: { complete: 'completed', fail: 'failed', archive: 'archived' },
  ingest: { start: 'running', complete: 'completed', fail: 'failed' },
};
for (const [resource, mapping] of Object.entries(DECISIONS)) {
  if (SCHEMAS[resource]) SCHEMAS[resource].decisionStatus = mapping;
}

const CODE = `const envelope = $input || {};
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const bool = (value) => (value === true || value === 'true' ? true : value === false || value === 'false' ? false : undefined);
const parseJson = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try { return JSON.parse(value); } catch { throw new Error(name + '_invalid_json'); }
};
const envelopeKeys = new Set(['pluginId', 'widgetId', 'product', 'resource', 'action', 'submittedBy', 'submittedAt', 'fields']);
const unknownEnvelope = Object.keys(envelope).filter((key) => !envelopeKeys.has(key));
if (unknownEnvelope.length) throw new Error('unknown_envelope_fields:' + unknownEnvelope.join(','));
const product = text(envelope.product);
const resource = text(envelope.resource);
const action = text(envelope.action) || 'create';
const submittedBy = text(envelope.submittedBy);
if (!submittedBy) throw new Error('submitted_by_required');
if (product !== '${PRODUCT}') throw new Error('unsupported_product');
if (!['create', 'update', 'delete', 'execute'].includes(action)) throw new Error('unsupported_action');
const fields = envelope.fields && typeof envelope.fields === 'object' && !Array.isArray(envelope.fields) ? envelope.fields : null;
if (!fields) throw new Error('fields_required');
const SCHEMAS = ${JSON.stringify(SCHEMAS)};
const schema = SCHEMAS[resource];
if (!schema) throw new Error('unsupported_resource');
const audit = {
  product, resource, action,
  pluginId: text(envelope.pluginId), widgetId: text(envelope.widgetId),
  submittedBy, submittedAt: text(envelope.submittedAt) || $now,
};
const base = '${DX}/v1/capabilities/datasets/' + schema.dataset + '/records';
const terminal = (value) => schema.terminal.includes(String(value));
const parseField = (name, spec) => {
  const value = fields[name];
  if (value === undefined || value === null || value === '') return undefined;
  if (spec.kind === 'number') {
    const number = num(value);
    if (number === undefined) throw new Error(name + '_must_be_number');
    return number;
  }
  if (spec.kind === 'boolean') {
    const flag = bool(value);
    if (flag === undefined) throw new Error(name + '_must_be_boolean');
    return flag;
  }
  if (spec.kind === 'json') return parseJson(value, name);
  const string = text(value);
  if (typeof value !== 'string' || string.length > (spec.max || 4000)) throw new Error(name + '_invalid_text');
  return string;
};
const recordId = text(fields.record_id || fields.id);
if (action !== 'create' && !/^[A-Za-z0-9_@.:+-]{1,256}$/.test(recordId)) throw new Error('record_id_invalid');
if (action === 'create') {
  const unknown = Object.keys(fields).filter((key) => key !== 'record_id' && !(key in schema.fields));
  if (unknown.length) throw new Error('unknown_fields:' + unknown.join(','));
  for (const required of schema.required) {
    const value = parseField(required, schema.fields[required]);
    if (value === undefined || value === '') throw new Error(required + '_required');
  }
  const record = { type: schema.recordType, ...schema.defaults };
  for (const [name, spec] of Object.entries(schema.fields)) {
    const parsed = parseField(name, spec);
    if (parsed === undefined) continue;
    record[name.endsWith('_json') ? name.slice(0, -5) : name] = parsed;
  }
  if (record.status !== undefined && schema.statuses.length && !schema.statuses.includes(String(record.status))) throw new Error('status_invalid');
  record.created_at = $now;
  record.updated_at = $now;
  return { mode: 'create', url: base, body: { data: record, publish: schema.publish === true }, audit, operation: resource + '.create' };
}
if (action === 'delete') {
  return { mode: 'delete', url: base + '/' + encodeURIComponent(recordId), audit, operation: resource + '.delete' };
}
const unknown = Object.keys(fields).filter((key) => key !== 'record_id' && key !== 'id' && key !== 'decision' && key !== 'notes' && !(key in schema.fields));
if (unknown.length) throw new Error('unknown_fields:' + unknown.join(','));
const patch = {};
for (const [name, spec] of Object.entries(schema.fields)) {
  const parsed = parseField(name, spec);
  if (parsed === undefined) continue;
  patch[name.endsWith('_json') ? name.slice(0, -5) : name] = parsed;
}
const decision = text(fields.decision);
const notes = text(fields.notes);
if (notes) patch.notes = notes;
if (action === 'execute') {
  const map = schema.decisionStatus || {};
  if (decision) {
    if (!map[decision]) throw new Error('decision_invalid');
    patch.status = map[decision];
  }
  if (!decision && !Object.keys(patch).length) throw new Error('action_fields_required');
  if (patch.status === 'approved') patch.approved_at = $now;
  if (patch.status === 'published') patch.published_at = $now;
  if (patch.status === 'rejected') patch.rejected_at = $now;
}
if (!Object.keys(patch).length) throw new Error('nothing_to_update');
if (patch.status !== undefined && schema.statuses.length && !schema.statuses.includes(String(patch.status))) throw new Error('status_invalid');
return { mode: 'update', url: base + '/' + encodeURIComponent(recordId), patch, audit, operation: resource + '.' + (decision || action) };
`;

const ref = (name) => ({ node: name, type: 'main', index: 0 });
const node = (name, type, typeVersion, position, parameters = {}) => ({ name, type, typeVersion, position, parameters });

const workflow = {
  name: 'city-workspace-actions',
  nodes: [
    node('DX manual execution', 'manualTrigger', 1, [200, 300]),
    node('Validate envelope and select operation', 'code', 2, [420, 300], { code: CODE }),
    node('Create?', 'if', 1, [640, 300], {
      conditions: { combinator: 'and', conditions: [{ leftValue: '={{$json.mode}}', rightValue: 'create', operator: 'equals' }] },
    }),
    node('Create record', 'httpRequest', 4, [860, 180], {
      url: '={{ $json.url }}', method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      body: '={{ $json.body }}', timeoutMs: 15000,
    }),
    node('Update?', 'if', 1, [860, 420], {
      conditions: { combinator: 'and', conditions: [{ leftValue: '={{$json.mode}}', rightValue: 'update', operator: 'equals' }] },
    }),
    node('Read current record', 'httpRequest', 4, [1080, 360], {
      url: '={{ $json.url }}', method: 'GET',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      includeInput: true, timeoutMs: 15000,
    }),
    node('Merge and enforce invariants', 'code', 2, [1300, 360], {
      code: `const response = $input || {};
const current = response.body;
const action = response.input;
if (response.statusCode !== 200 || !current || typeof current.data !== 'object' || !current.data) throw new Error('record_not_found');
const data = current.data;
if (!Number.isInteger(current.version)) throw new Error('record_version_unavailable');
const schema = ${JSON.stringify(Object.fromEntries(Object.entries(SCHEMAS).map(([key, value]) => [key, { terminal: value.terminal }])))};
const terminal = schema[action.resource] ? schema[action.resource].terminal : [];
if (terminal.includes(String(data.status))) throw new Error('record_terminal');
const next = { ...data, ...action.patch, updated_at: $now };
return { body: { data: next, ifVersion: current.version }, url: action.url, audit: action.audit, operation: action.operation };`,
    }),
    node('Patch full record', 'httpRequest', 4, [1520, 360], {
      url: '={{ $json.url }}', method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      body: '={{ $json.body }}', timeoutMs: 15000,
    }),
    node('Delete?', 'if', 1, [1080, 560], {
      conditions: { combinator: 'and', conditions: [{ leftValue: '={{$json.mode}}', rightValue: 'delete', operator: 'equals' }] },
    }),
    node('Delete record', 'httpRequest', 4, [1300, 500], {
      url: '={{ $json.url }}', method: 'DELETE',
      headers: { Accept: 'application/json' },
      auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] },
      timeoutMs: 15000,
    }),
    node('Unsupported operation', 'code', 2, [1300, 620], {
      code: 'throw new Error(\'unsupported_operation\');\nreturn {};',
    }),
  ],
  connections: {
    'DX manual execution': { main: [[ref('Validate envelope and select operation')]] },
    'Validate envelope and select operation': { main: [[ref('Create?')]] },
    'Create?': { main: [[ref('Create record')], [ref('Update?')]] },
    'Create record': { main: [[]] },
    'Update?': { main: [[ref('Read current record')], [ref('Delete?')]] },
    'Read current record': { main: [[ref('Merge and enforce invariants')]] },
    'Merge and enforce invariants': { main: [[ref('Patch full record')]] },
    'Patch full record': { main: [[]] },
    'Delete?': { main: [[ref('Delete record')], [ref('Unsupported operation')]] },
    'Delete record': { main: [[]] },
    'Unsupported operation': { main: [[]] },
  },
};

const output = join(dir, 'city-workspace-actions.workflow.json');
writeFileSync(output, `${JSON.stringify(workflow, null, 2)}\n`);
console.log(`wrote ${output} (${workflow.nodes.length} nodes)`);
