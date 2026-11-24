#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Add declared sort inputs to the IoT readings/registry query actions.
import fs from 'node:fs';

const file = 'plugins/city-iot-network.plugin.json';
const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
let changed = 0;
for (const widget of bundle.plugin.widgets) {
  if (widget.type !== 'action' || !['act-readings-table-load', 'act-iot-table-load'].includes(widget.id)) continue;
  const mappings = widget.operation.mappings;
  for (const [field, value] of [['sortBy', 'sortBy'], ['sortDirection', 'sortDirection']]) {
    if (!mappings.some((mapping) => mapping.field === field)) {
      mappings.push({ field, source: 'event', value });
      changed += 1;
    }
  }
}
fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + '\n');
console.log(`patched ${changed} mappings`);
