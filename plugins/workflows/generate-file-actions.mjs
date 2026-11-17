// SPDX-License-Identifier: Apache-2.0
/** Product-owned file/ingest/report rules. DX only supplies reusable import/export primitives. */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const DX = 'https://synapsedx.sbs', dir = new URL('./', import.meta.url);
const node = (name, type, parameters = {}) => ({ name, type, typeVersion: type === 'httpRequest' ? 4 : type === 'code' ? 2 : 1, position: [0, 0], parameters });
const http = (name, url, body, app = false) => node(name, 'httpRequest', { method: 'POST', url, body, includeInput: true, timeoutMs: 30000, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(app ? { 'X-Workspace-App': 'city' } : {}) }, auth: { credentialRef: 'synapsedx-organization', header: 'X-API-Key', allowedOrigins: [DX] } });
function save(name, nodes) {
  nodes.forEach((n, i) => { n.position = [200 + i * 220, 300]; });
  const connections = Object.fromEntries(nodes.map((n, i) => [n.name, { main: [i + 1 < nodes.length ? [{ node: nodes[i + 1].name, type: 'main', index: 0 }] : []] }]));
  fs.writeFileSync(new URL(`${name}.workflow.json`, dir), JSON.stringify({ name, nodes, connections, settings: { access: { mode: 'owner-only' } } }, null, 2) + '\n');
}
const envelope = (resource, fields) => `const input = $input || {};
if (Object.keys(input).some(key => !['pluginId','widgetId','product','resource','action','submittedBy','submittedAt','fields'].includes(key))) throw new Error('unknown_envelope_fields');
if (input.product !== 'city' || input.resource !== '${resource}' || input.action !== 'execute' || !input.submittedBy || !input.pluginId || !input.widgetId) throw new Error('invalid_operation_envelope');
const fields = input.fields;
if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).some(key => !${JSON.stringify(fields)}.includes(key))) throw new Error('unknown_fields');
`;
const columns = [
  { column: 'asset_code', field: 'asset_code', required: true, maxLength: 120 },
  { column: 'asset_code', field: 'assetId', required: true, maxLength: 120 },
  { column: 'name', field: 'name', required: true, maxLength: 200 },
  { column: 'feature_type', field: 'feature_type', required: true, maxLength: 80 },
  { column: 'feature_code', field: 'feature_code', required: true, maxLength: 120 },
  { column: 'latitude', field: 'latitude', type: 'number', required: true, min: -90, max: 90 },
  { column: 'longitude', field: 'longitude', type: 'number', required: true, min: -180, max: 180 },
  { column: 'latitude', field: 'location.coordinates.latitude', type: 'number', required: true, min: -90, max: 90 },
  { column: 'longitude', field: 'location.coordinates.longitude', type: 'number', required: true, min: -180, max: 180 },
  { column: 'address', field: 'location.address', maxLength: 300 },
  { column: 'category', field: 'category', maxLength: 80 },
  { column: 'status', field: 'status', options: ['active','inactive','maintenance','retired','disposed'] },
  { column: 'properties', field: 'properties', type: 'json' },
  { column: 'geometry', field: 'geometry', type: 'json' },
];
save('city-csv-import', [
  node('DX manual execution', 'manualTrigger'),
  node('Validate City import', 'code', { code: envelope('ingest', ['file_id', 'batch_offset']) + `
if (typeof fields.file_id !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(fields.file_id)) throw new Error('file_id_required');
const offset = fields.batch_offset === undefined ? 0 : fields.batch_offset;
if (!Number.isInteger(offset) || offset < 0 || offset > 50000) throw new Error('invalid_batch_offset');
return { input, file_id: fields.file_id, body: { datasetId: 'city-assets', schema: { columns: ${JSON.stringify(columns)}, defaults: { type: 'Asset', status: 'active', public_visible: true, source: 'synapsecity-ingest', sourceVersion: '2.0.0', properties: {}, created_at: $now, updated_at: $now }, idField: 'asset_code', point: { latitude: 'latitude', longitude: 'longitude', target: 'geometry' } }, publish: true, offset, limit: 500 } };` }),
  http('Import validated asset batch', `={{ '${DX}/v1/capabilities/files/' + $json.file_id + '/tabular/import' }}`, '={{ $json.body }}', true),
  node('Record processing results', 'code', { code: `const result = $input.body;
if (!$input.statusCode || typeof result.imported !== 'number' || typeof result.totalRows !== 'number') throw new Error('invalid_import_result');
const source = $input.input;
return { result, body: { data: { type: 'IngestJob', source: 'csv', dataset: 'city-assets', file_id: source.file_id, file_name: result.filename, status: result.nextOffset !== undefined ? 'running' : result.invalid ? 'completed_with_errors' : 'completed', rows_total: result.totalRows, rows_processed: result.processedRows, rows_imported: result.imported, rows_skipped: result.skipped, rows_invalid: result.invalid, batch_offset: result.offset, errors: result.errors, checksum: result.checksumSha256, submitted_by: source.input.submittedBy, plugin_id: source.input.pluginId, created_at: $now, updated_at: $now }, publish: false } };` }),
  http('Persist ingest result', `${DX}/v1/capabilities/datasets/city-ingest-jobs/records`, '={{ $json.body }}'),
  node('Return batch result', 'code', { code: 'return $input.input.result;' }),
]);
const field = name => ({ field: name }), literal = value => ({ literal: value }), calc = (op, ...args) => ({ op, args }), coalesce = (...names) => calc('coalesce', ...names.map(field)), column = (name, value = field(name)) => ({ name, value });
const numeric = name => calc('number', field(name));
const age = calc('round', calc('yearsBetween', field('lifecycle.commissioned_date'), calc('now')), literal(1));
const remaining = calc('max', literal(0), calc('round', calc('subtract', numeric('lifecycle.designed_lifespan_years'), age), literal(1)));
const specs = {
  maintenance_summary: { datasetId: 'city-maintenance', columns: [column('work_order_id', field('id')), column('asset_id', coalesce('asset_id','assetId')), ...['title','type','status','priority'].map(n => column(n)), column('assigned_to', coalesce('assigned_to','technician')), ...['scheduled_date','completed_at','source_alert_id','estimated_cost','actual_cost'].map(n => column(n))] },
  incident_summary: { datasetId: 'city-incidents', columns: [column('incident_id', field('id')), column('incident_number', coalesce('incident_number','incident_code')), ...['title','category','severity','status'].map(n => column(n)), column('asset_id', coalesce('asset_id','assetId')), ...['reported_at','resolved_at','resolution_type'].map(n => column(n))] },
  lifecycle_overview: { datasetId: 'city-assets', columns: [column('asset_code', coalesce('asset_code','feature_code','id')), ...['name','feature_type','status'].map(n => column(n)), column('lifecycle_status', coalesce('lifecycle.lifecycle_status','lifecycle_stage')), column('condition'), column('commissioned_date', field('lifecycle.commissioned_date')), column('last_maintenance_date', field('lifecycle.last_maintenance_date')), column('designed_lifespan_years', numeric('lifecycle.designed_lifespan_years'))] },
  end_of_life_forecast: { datasetId: 'city-assets', columns: [column('asset_code', coalesce('asset_code','feature_code','id')), column('name'), column('commissioned_date', field('lifecycle.commissioned_date')), column('designed_lifespan_years', numeric('lifecycle.designed_lifespan_years')), column('age_years', age), column('remaining_years', remaining), column('projected_replacement_year', calc('add', calc('year', calc('now')), calc('ceil', remaining))), column('status')] },
};
specs.custom = specs.incident_summary;
save('city-generate-report', [
  node('DX manual execution', 'manualTrigger'),
  node('Validate report specification', 'code', { code: envelope('reports', ['type','format','asset_id','severity','date_from','date_to']) + `
const specs = ${JSON.stringify(specs)};
if (!Object.prototype.hasOwnProperty.call(specs, fields.type)) throw new Error('unsupported_report_type');
if (!['csv','json'].includes(fields.format)) throw new Error('unsupported_report_format');
for (const name of ['date_from','date_to']) if (fields[name] && (!/^\\d{4}-\\d{2}-\\d{2}/.test(fields[name]) || !Number.isFinite(Date.parse(fields[name])))) throw new Error('invalid_report_date');
if (fields.date_from && fields.date_to && fields.date_from > fields.date_to) throw new Error('invalid_date_range');
const spec = specs[fields.type], clauses = [];
if (fields.asset_id) clauses.push(spec.datasetId === 'city-assets' ? { or: [{ id: fields.asset_id }, { asset_code: fields.asset_id }] } : { or: [{ asset_id: fields.asset_id }, { assetId: fields.asset_id }] });
if (fields.severity) clauses.push({ severity: fields.severity });
// Date filters are declared on the report's business date. Records without that date remain visible in the legacy report contract.
const dateField = fields.type === 'maintenance_summary' ? 'scheduled_date' : 'reported_at';
if (fields.date_from || fields.date_to) {
  const range = {};
  if (fields.date_from) range.gte = fields.date_from;
  if (fields.date_to) range.lte = fields.date_to + 'T23:59:59.999Z';
  clauses.push({ or: [{ [dateField]: range }, { [dateField]: { exists: false } }] });
}
return { input, body: { ...spec, filename: fields.type + '-' + $now.slice(0,10) + '.' + fields.format, format: fields.format, ...(clauses.length ? { where: { and: clauses } } : {}), metadata: { report_type: fields.type, filters: fields, submitted_by: input.submittedBy } } };` }),
  http('Generate complete report artifact', `${DX}/v1/capabilities/files/tabular/export`, '={{ $json.body }}', true),
  node('Prepare completed report record', 'code', { code: `const file = $input.body, input = $input.input.input;
if (!file.file_id || !file.checksumSha256 || typeof file.rowCount !== 'number') throw new Error('report_artifact_incomplete');
return { result: file, body: { data: { type: 'Report', report_code: input.fields.type + '-' + $now, report_type: input.fields.type, format: input.fields.format, status: 'completed', file_id: file.file_id, filename: file.filename, file_url: file.downloadUrl, row_count: file.rowCount, checksum_sha256: file.checksumSha256, parameters: input.fields, created_by: input.submittedBy, created_at: $now, updated_at: $now }, publish: false } };` }),
  http('Persist generated report', `${DX}/v1/capabilities/datasets/city-reports/records`, '={{ $json.body }}'),
  node('Return generated artifact', 'code', { code: 'return $input.input.result;' }),
]);
