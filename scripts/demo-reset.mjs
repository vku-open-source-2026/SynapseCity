#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/** Reset the SynapseCity DX-Lab demo records (issue #28). */
const base = (process.env.CITY_API_URL || 'http://127.0.0.1:8083').replace(/\/$/, '');
const token = process.env.CITY_DEMO_TOKEN || '';

async function api(method, path) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  return { status: response.status, body: payload };
}

async function list(path) {
  const result = await api('GET', path);
  return result.status === 200 && Array.isArray(result.body) ? result.body : (result.body?.items || []);
}

async function remove(path, predicate) {
  const rows = await list(path);
  let removed = 0;
  for (const row of rows.filter(predicate)) {
    const id = row.id || row.assetId || row.incidentId;
    if (!id) continue;
    const result = await api('DELETE', `${path}/${encodeURIComponent(id)}`);
    if (result.status < 300) removed++;
  }
  return removed;
}

async function main() {
  const maintenance = await remove('/v1/maintenance', (row) => String(row.id || '').startsWith('DEMO-') || String(row.title || '').includes('Demo'));
  const incidents = await remove('/v1/incidents', (row) => String(row.incident_number || row.incident_code || row.id || '') === 'DEMO-INC-01');
  const assets = await remove('/v1/assets', (row) => String(row.asset_code || row.feature_code || '').startsWith('DEMO-'));
  const budgets = await remove('/v1/budgets', (row) => String(row.id || '') === 'DEMO-BUDGET-01');
  console.log(`Demo reset: ${assets} assets, ${incidents} incidents, ${maintenance} work orders, ${budgets} budgets removed.`);
}

main().catch((error) => { console.error(error); process.exit(1); });
