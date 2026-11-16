// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** City predictive risk (#29) and Tier-2 HITL adoption (#30). */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';
import { scoreAssetRisk } from './risk';
import type { SessionRole } from './auth';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-hitl-test-secret';
process.env.CITY_AUTH_MODE = 'demo';
process.env.CITY_HITL_REQUIRED = 'true';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let auth: typeof import('./auth');

function tokenFor(role: SessionRole, username = `${role}-user`): string {
  return auth.signToken({
    sub: `user-${username}`, username, email: `${username}@example.com`, full_name: username,
    role, permissions: auth.permissionsForRole(role), typ: 'access',
  });
}

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const text = await response.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body };
}

function json(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;
  auth = await import('./auth');
  const service = await import('./server');
  server = service.createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (tier2) await tier2.close();
});

test('criticality and data completeness change the explained risk score (#29)', () => {
  const base = {
    asset: { id: 'a1', health_score: 70, criticality: { service_impact: 1, population_served: 100, redundancy: 5, safety_impact: 1 } },
    incidents: [], maintenance: [],
    sensors: [{ metric: 'vibration', value: 1, min: 0, max: 10, observed_at: new Date().toISOString() }],
  };
  const low = scoreAssetRisk(base);
  const high = scoreAssetRisk({
    ...base,
    asset: { ...base.asset, criticality: { service_impact: 5, population_served: 500000, redundancy: 1, safety_impact: 5 } },
  });
  assert.ok(high.score > low.score, `${high.score} must exceed ${low.score}`);
  assert.equal(low.factors.length, 5);
  assert.equal(low.factors[0].name, 'criticality');

  const missing = scoreAssetRisk({ ...base, sensors: [] });
  assert.ok(missing.flags.includes('no_sensor_data'));
  assert.ok(missing.confidence < low.confidence);

  const stale = scoreAssetRisk({
    ...base,
    sensors: [{ metric: 'vibration', value: 1, min: 0, max: 10, observed_at: new Date(Date.now() - 24 * 3600_000).toISOString() }],
  });
  assert.ok(stale.flags.includes('stale_sensor_data'));
  assert.equal(stale.data_freshness.stale, true);
  assert.ok(stale.confidence < low.confidence);
});

test('asset risk endpoint exposes factors, freshness and flags (#29)', async () => {
  const admin = tokenFor('admin');
  const created = await request('/v1/assets', json('POST', {
    asset_code: 'RISK-ASSET-1', name: 'Risk bridge', feature_type: 'bridge',
  }, admin));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const assetId = created.body.id || created.body.assetId;
  const criticality = await request(`/v1/assets/${assetId}/criticality`, json('PUT', {
    service_impact: 5, population_served: 250000, redundancy: 1, safety_impact: 5,
  }, admin));
  assert.equal(criticality.status, 200, JSON.stringify(criticality.body));

  tier2.seed('city-iot-sensors', 'sensor-risk-1', { id: 'sensor-risk-1', asset_id: assetId, metric: 'vibration' });
  tier2.seed('city-iot-readings', 'reading-risk-1', {
    id: 'reading-risk-1', sensor_id: 'sensor-risk-1', metric: 'vibration', value: 99, min: 0, max: 10,
    observed_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
  });
  const risk = await request(`/v1/assets/${assetId}/risk`, json('GET', undefined, admin));
  assert.equal(risk.status, 200, JSON.stringify(risk.body));
  assert.ok(risk.body.score >= 35);
  assert.ok(['moderate', 'high', 'critical'].includes(risk.body.band));
  assert.ok(risk.body.factors.some((factor: any) => factor.name === 'sensor' && factor.score === 80));
  assert.ok(risk.body.flags.includes('stale_sensor_data'));
  assert.equal(risk.body.data_freshness.stale, true);

  const top = await request('/v1/risk/top?limit=5', json('GET', undefined, admin));
  assert.equal(top.status, 200);
  assert.ok(top.body.items.some((item: any) => item.asset_id === assetId));
});

test('incident cost approval is a Tier-2 HITL decision and blocks self-approval (#30)', async () => {
  const manager = tokenFor('manager', 'cost-manager');
  const admin = tokenFor('admin', 'cost-admin');
  const incident = await request('/v1/incidents', json('POST', {
    incidentId: 'inc-hitl-1', incident_number: 'INC-HITL-1', title: 'Cost approval incident',
    category: 'repair', severity: 'high', status: 'open',
  }, manager));
  assert.equal(incident.status, 201, JSON.stringify(incident.body));

  const requested = await request('/v1/incidents/inc-hitl-1/cost-approval', json('POST', {}, manager));
  assert.equal(requested.status, 202, JSON.stringify(requested.body));
  const approvalId = requested.body.approval.id;
  assert.equal(requested.body.approval.module, 'city.incident');
  assert.deepEqual(requested.body.approval.approverRoles, ['finance', 'manager']);

  const noProof = await request('/v1/incidents/inc-hitl-1/approve-cost', json('POST', {}, admin));
  assert.equal(noProof.status, 428);
  assert.equal(noProof.body.error, 'approval_required');

  const self = await request(`/v1/hitl/approvals/${approvalId}/decide`, json('POST', { decision: 'approve' }, manager));
  assert.equal(self.status, 200, JSON.stringify(self.body));
  const selfCost = await request('/v1/incidents/inc-hitl-1/approve-cost', json('POST', { approval_id: approvalId }, manager));
  assert.equal(selfCost.status, 403);
  assert.ok(selfCost.body.code === 'self_approval_forbidden' || selfCost.body.error === 'self_approval_forbidden', JSON.stringify(selfCost.body));

  const approved = await request('/v1/incidents/inc-hitl-1/approve-cost', json('POST', { approval_id: approvalId }, admin));
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.cost_status, 'approved');
  assert.equal(approved.body.cost_approval_id, approvalId);
  assert.equal(approved.body.cost_approved_by, 'cost-admin');
});

test('rejected approvals cannot be applied and overdue approvals are escalated (#30)', async () => {
  const manager = tokenFor('manager', 'reject-manager');
  const admin = tokenFor('admin', 'reject-admin');
  await request('/v1/incidents', json('POST', {
    incidentId: 'inc-hitl-2', incident_number: 'INC-HITL-2', title: 'Rejected incident', category: 'repair', status: 'open',
  }, manager));
  const requested = await request('/v1/incidents/inc-hitl-2/cost-approval', json('POST', {}, manager));
  const approvalId = requested.body.approval.id;
  await request(`/v1/hitl/approvals/${approvalId}/decide`, json('POST', { decision: 'reject', note: 'over budget' }, admin));
  const rejected = await request('/v1/incidents/inc-hitl-2/approve-cost', json('POST', { approval_id: approvalId }, admin));
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.code, 'approval_not_approved');

  tier2.approvals.set('approval-overdue', {
    id: 'approval-overdue', tenant: 'demo', title: 'Overdue approval', module: 'city.maintenance', action: 'maintenance.approve',
    requester: 'manager-user', approverRoles: ['manager'], requiredApprovals: 1, status: 'pending', decisions: [],
    dueAt: new Date(Date.now() - 3600_000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  const pending = await request('/v1/hitl/approvals?module=city.maintenance', json('GET', undefined, admin));
  assert.equal(pending.status, 200);
  const overdue = pending.body.items.find((item: any) => item.id === 'approval-overdue');
  assert.ok(overdue);
  assert.equal(overdue.escalated, true);
});

test('predictive work orders need an approved HITL decision (#29, #30)', async () => {
  const admin = tokenFor('admin', 'risk-admin');
  const asset = await request('/v1/assets', json('POST', {
    asset_code: 'RISK-ASSET-2', name: 'Risk pump', feature_type: 'pump_station',
  }, admin));
  const assetId = asset.body.id || asset.body.assetId;
  await request(`/v1/assets/${assetId}/criticality`, json('PUT', {
    service_impact: 5, population_served: 500000, redundancy: 1, safety_impact: 5,
  }, admin));

  const manager = tokenFor('manager', 'risk-manager');
  const pending = await request(`/v1/assets/${assetId}/risk/work-order`, json('POST', {}, manager));
  assert.equal(pending.status, 202, JSON.stringify(pending.body));
  assert.equal(pending.body.hitl_required, true);
  const approvalId = pending.body.approval.id;

  await request(`/v1/hitl/approvals/${approvalId}/decide`, json('POST', { decision: 'approve' }, admin));
  const created = await request(`/v1/assets/${assetId}/risk/work-order`, json('POST', { approval_id: approvalId }, admin));
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.work_order.status, 'scheduled');
  assert.equal(created.body.work_order.approval_id, approvalId);
  assert.ok(created.body.work_order.risk_factors.length >= 4);
});
