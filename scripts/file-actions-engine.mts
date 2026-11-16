// SPDX-License-Identifier: Apache-2.0
/** LOCAL TEST ONLY: real workflow engine -> DX HTTP routes -> fake Tier-1 persistence. */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '../..');
const { runWorkflow } = await import(pathToFileURL(path.join(root, 'SynapseOne/apps/workflow-service/src/engine.ts')).href);
const harnessModule = await import(pathToFileURL(path.join(root, 'SynapseDX/apps/capabilities-service/dist/src/testing/harness.js')).href);
const { api, startHarness, createDataset } = harnessModule.default || harnessModule;
const h = await startHarness(); h.config.publicUrl = h.base;
const headers = { 'x-workspace-app': 'city' };
const originalFetch = globalThis.fetch;
try {
  for (const slug of ['city-assets','city-ingest-jobs','city-reports','city-maintenance','city-incidents']) {
    const dataset = await createDataset(h, { slug, name: slug, public: slug === 'city-assets' }, { token: 'admin-token' });
    assert.equal(dataset.status, 201, JSON.stringify(dataset.body));
    if (slug === 'city-assets') assert.equal((await api(h, '/v1/capabilities/datasets/city-assets/publish', { token: 'admin-token', method: 'POST' })).status, 200);
  }
  const source = 'asset_code,name,feature_type,feature_code,latitude,longitude\nAST_1,Bridge,bridge,BRG,16,108\nAST_2,Invalid,light,LGT,200,108\nAST_3,Street lamp,light,LGT,16.1,108.2\n';
  const metadata = await api(h, '/v1/capabilities/files', { token: 'admin-token', method: 'POST', headers, body: { filename: 'assets.csv', contentType: 'text/csv' } });
  assert.equal(metadata.status, 201);
  const fileId = metadata.body.id;
  assert.equal((await api(h, `/v1/capabilities/files/${fileId}/content`, { token: 'admin-token', method: 'PUT', headers: { ...headers, 'content-type': 'text/csv' }, buffer: Buffer.from(source) })).status, 200);
  globalThis.fetch = (async (url: any, options: any) => {
    const target = String(url);
    return originalFetch(target.startsWith('https://synapsedx.sbs/') ? h.base + target.slice('https://synapsedx.sbs'.length) : url, options);
  }) as typeof fetch;
  const run = async (workflow: string, resource: string, fields: any) => {
    const definition = JSON.parse(fs.readFileSync(path.join(root, `SynapseCity/plugins/workflows/${workflow}.workflow.json`), 'utf8'));
    for (const node of definition.nodes) if (node.parameters?.auth?.credentialRef) node.parameters.auth.credentialId = 'bound-test-credential';
    return runWorkflow(definition, { pluginId: 'test-plugin', widgetId: 'test-widget', product: 'city', resource, action: 'execute', submittedBy: 'member-test', submittedAt: new Date().toISOString(), fields }, { name: workflow, principal: { sub: 'member-test', kind: 'user' }, credentialResolver: async (id: string) => id === 'bound-test-credential' ? { kind: 'api-key', secret: 'workflow-org-key' } : null });
  };
  const imported = await run('city-csv-import', 'ingest', { file_id: fileId, batch_offset: 0 });
  assert.equal(imported.status, 'success', imported.error);
  assert.equal(imported.output.imported, 2); assert.equal(imported.output.invalid, 1);
  assert.equal(imported.output.errors[0].row, 3);
  const assets = await api(h, '/v1/capabilities/datasets/city-assets/records', { token: 'admin-token' });
  assert.equal(assets.body.items.length, 2);
  const jobs = await api(h, '/v1/capabilities/datasets/city-ingest-jobs/records', { token: 'admin-token' });
  assert.equal(jobs.body.items.length, 1); assert.equal(jobs.body.items[0].data.status, 'completed_with_errors');
  assert.equal(jobs.body.items[0].data.rows_imported, 2);
  const repeated = await run('city-csv-import', 'ingest', { file_id: fileId, batch_offset: 0 });
  assert.equal(repeated.status, 'success', repeated.error); assert.equal(repeated.output.imported, 0); assert.equal(repeated.output.skipped, 2);
  const maintenance = await api(h, '/v1/capabilities/datasets/city-maintenance/records', { token: 'admin-token', method: 'POST', body: { data: { title: 'Bridge inspection', asset_id: 'AST_1', priority: 'high', status: 'completed', actual_cost: 150, scheduled_date: '2026-11-01' }, publish: false } });
  assert.equal(maintenance.status, 201);
  const asset = assets.body.items[0];
  assert.equal((await api(h, `/v1/capabilities/datasets/city-assets/records/${asset.id}`, { token: 'admin-token', method: 'PATCH', body: { data: { ...asset.data, lifecycle: { commissioned_date: '2016-01-01', designed_lifespan_years: 20 } }, ifVersion: asset.version } })).status, 200);
  for (const type of ['maintenance_summary','incident_summary','lifecycle_overview','end_of_life_forecast','custom']) {
    const result = await run('city-generate-report', 'reports', { type, format: 'csv' });
    assert.equal(result.status, 'success', result.error);
    assert.ok(result.output.file_id); assert.ok(result.output.checksumSha256);
    const downloaded = await originalFetch(h.base + result.output.downloadUrl, { headers: { authorization: 'Bearer admin-token', ...headers } });
    assert.equal(downloaded.status, 200);
    const content = await downloaded.text();
    if (type === 'maintenance_summary') { assert.equal(result.output.rowCount, 1); assert.match(content, /Bridge inspection/); assert.match(content, /150/); }
    if (type === 'end_of_life_forecast') { assert.equal(result.output.rowCount, 2); assert.match(content, /projected_replacement_year/); assert.ok(!content.includes('NaN')); }
  }
  const reports = await api(h, '/v1/capabilities/datasets/city-reports/records', { token: 'admin-token' });
  assert.equal(reports.body.items.length, 5); assert.ok(reports.body.items.every((row: any) => row.data.status === 'completed' && row.data.file_id));
  const bad = await run('city-generate-report', 'reports', { type: 'maintenance_summary', format: 'pdf' });
  assert.equal(bad.status, 'error');
  console.log(JSON.stringify({ passed: true, engine: 'real Tier-1', capability: 'real DX HTTP routes', persistence: 'fake Tier-1 test transport', imported: 2, invalid: 1, skippedOnRetry: 2, generatedReports: 5, productAPICalls: 0 }));
} finally { globalThis.fetch = originalFetch; await h.close(); }
