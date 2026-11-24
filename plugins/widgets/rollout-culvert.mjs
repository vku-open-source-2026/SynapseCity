// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// One-shot production rollout for the City IoT plugin: merge the tracked
// culvert widgets into the installed draft, publish a new version and refresh
// the installation. The DX admin token is read from DX_TOKEN and never printed.
import fs from 'node:fs';

const BASE = process.env.DX_BASE || 'https://synapsedx.sbs';
const TOKEN = process.env.DX_TOKEN;
const PLUGIN_ID = process.env.DX_PLUGIN_ID || '7627432b-2b7f-47cd-bc65-e6e3de1740ed';
if (!TOKEN) throw new Error('DX_TOKEN is required');

const headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', accept: 'application/json' };
async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = text; }
  if (!response.ok) {
    throw new Error(`${method} ${path} -> ${response.status}: ${typeof payload === 'string' ? payload.slice(0, 300) : JSON.stringify(payload).slice(0, 300)}`);
  }
  return payload;
}

const bundle = JSON.parse(fs.readFileSync('plugins/city-iot-network.plugin.json', 'utf8'));
const additions = bundle.plugin.widgets.filter((widget) => ['culvert-heading', 'culvert-live'].includes(widget.id));
if (additions.length !== 2) throw new Error('culvert widgets missing from the bundle');

const current = await call('GET', `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}`);
const widgets = current.widgets.filter((widget) => !['culvert-heading', 'culvert-live'].includes(widget.id));

// Ensure the readings/registry query actions declare the sort inputs used by
// the live code widget. Existing plugins were published without them.
for (const target of widgets) {
  if (target.type !== 'action' || !['act-readings-table-load', 'act-iot-table-load'].includes(target.id)) continue;
  const mappings = target.operation.mappings;
  for (const [field, value] of [['sortBy', 'sortBy'], ['sortDirection', 'sortDirection']]) {
    if (!mappings.some((mapping) => mapping.field === field)) {
      mappings.push({ field, source: 'event', value });
    }
  }
}

const anchor = widgets.findIndex((widget) => widget.id === 'readings-metric');
const at = anchor >= 0 ? anchor + 1 : widgets.length;
widgets.splice(at, 0, ...additions);

console.log(`draft v${current.version} -> ${widgets.length} widgets (insert at ${at})`);
const updated = await call('PUT', `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}`, {
  version: current.version,
  name: current.name,
  slug: current.slug,
  audience: current.audience,
  roles: current.roles,
  widgets,
});
console.log(`updated v${updated.version}`);

const published = await call('POST', `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}/publish`, { version: updated.version });
console.log(`published v${published.version} checksum=${published.checksum}`);

const installed = await call('POST', `/v1/capabilities/workspaces/plugins/${PLUGIN_ID}/install`, {
  roles: Array.isArray(current.installedRoles) ? current.installedRoles : [],
});
console.log(`installed v${installed.version} status=${installed.status}`);
