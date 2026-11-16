#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Idempotent SynapseCity OLP 2026 demo seed (issue #28).
 * Writes only through the public City API; the City service owns Tier-2 calls.
 */
const base = (process.env.CITY_API_URL || 'http://127.0.0.1:8083').replace(/\/$/, '');
const token = process.env.CITY_DEMO_TOKEN || '';

async function api(method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, body: payload };
}

async function list(path) {
  const result = await api('GET', path);
  if (result.status !== 200) return [];
  return Array.isArray(result.body) ? result.body : (result.body?.items || []);
}

async function upsertByCode(listPath, codeField, code, createPath, payload) {
  const rows = await list(listPath);
  const existing = rows.find((row) => String(row[codeField] || row.asset_code || row.feature_code || row.incident_number || row.id) === code);
  if (existing) {
    const id = existing.id || existing.assetId || existing.incidentId;
    const updated = await api('PUT', `${listPath}/${encodeURIComponent(id)}`, payload);
    if (updated.status < 400 || updated.status === 405) return { id, updated: updated.status < 400, status: updated.status };
  }
  const created = await api('POST', createPath, payload);
  return { id: created.body?.id || created.body?.assetId || created.body?.incidentId, updated: false, status: created.status };
}

async function genericUpsert(path, id, payload) {
  const current = await api('GET', `${path}/${encodeURIComponent(id)}`);
  if (current.status === 200) return { id, ...(await api('PUT', `${path}/${encodeURIComponent(id)}`, payload)), updated: true };
  return { id, ...(await api('POST', path, { id, ...payload })), updated: false };
}

async function main() {
  const health = await api('GET', '/health');
  if (health.status !== 200) {
    console.error(`City API is not healthy at ${base}`);
    process.exit(1);
  }

  const assets = [
    {
      asset_code: 'DEMO-BRIDGE-01', name: 'Demo Bridge (DX-Lab)', feature_type: 'bridge', status: 'active',
      condition: 'fair', municipality: 'Demo City', owner: 'Public Works',
      geometry: { type: 'Point', coordinates: [105.8342, 21.0278] },
      location: { address: 'Demo City river crossing', coordinates: { longitude: 105.8342, latitude: 21.0278 } },
    },
    {
      asset_code: 'DEMO-PUMP-01', name: 'Demo Pump Station', feature_type: 'pump_station', status: 'active',
      condition: 'good', municipality: 'Demo City', owner: 'Water Utility',
      geometry: { type: 'Point', coordinates: [105.8400, 21.0300] },
    },
  ];
  const assetIds = {};
  for (const asset of assets) {
    const result = await upsertByCode('/v1/assets', 'asset_code', asset.asset_code, '/v1/assets', asset);
    assetIds[asset.asset_code] = result.id;
    console.log(`${result.updated ? 'updated' : 'created'} asset ${asset.asset_code}`);
  }

  const bridgeId = assetIds['DEMO-BRIDGE-01'];
  await api('PUT', `/v1/assets/${encodeURIComponent(bridgeId)}/criticality`, {
    service_impact: 5, population_served: 120000, redundancy: 2, safety_impact: 5,
  });

  const incident = await upsertByCode('/v1/incidents', 'incident_number', 'DEMO-INC-01', '/v1/incidents', {
    incidentId: 'DEMO-INC-01', incident_number: 'DEMO-INC-01', title: 'Bridge deck vibration',
    description: 'Sensors report abnormal vibration after heavy rain.', category: 'structural', severity: 'high',
    status: 'open', asset_id: bridgeId, reporter_type: 'operator', reported_by: 'demo-operator',
  });
  console.log(`${incident.updated ? 'updated' : 'created'} incident DEMO-INC-01`);

  const maintenance = await genericUpsert('/v1/maintenance', 'DEMO-WO-01', {
    asset_id: bridgeId, title: 'Inspect bridge expansion joints', type: 'preventive', status: 'scheduled',
    priority: 'high', assigned_to: 'demo-technician',
    scheduled_date: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    notes: 'DX-Lab demo work order; approval goes through Tier-2 HITL.',
  });
  console.log(`${maintenance.updated ? 'updated' : 'created'} maintenance DEMO-WO-01`);

  const budget = await genericUpsert('/v1/budgets', 'DEMO-BUDGET-01', {
    name: 'Bridge maintenance program', fiscal_year: '2026', amount: 500000, currency: 'VND',
    status: 'submitted', department: 'Public Works',
  });
  console.log(`${budget.updated ? 'updated' : 'created'} budget DEMO-BUDGET-01`);

  console.log('Demo seed complete. Open the City console and follow docs/DEMO_PACK.md.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
