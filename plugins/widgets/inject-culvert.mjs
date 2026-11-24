#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// One-shot authoring helper: inject the culvert live widget into the tracked
// City IoT plugin bundle, then reseal with `npm run plugins:reseal`.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('plugins');
const bundlePath = path.join(root, 'city-iot-network.plugin.json');
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'));
const read = (name) => fs.readFileSync(path.join(root, 'widgets', name), 'utf8');

const heading = {
  id: 'culvert-heading',
  type: 'heading',
  title: 'Cống nước thông minh · Nguyễn Lương Bằng',
  text:
    'Mực nước cống thoát nước được ESP32 + JSN-SR04T gửi qua MQTT mỗi 30 giây. ' +
    'Mở trang IoT Lab của SynapseCity (đường dẫn /iot) để gen firmware và xem hướng dẫn nạp.',
  width: 'full',
};

const live = {
  id: 'culvert-live',
  type: 'code',
  title: 'Cống nước · Live',
  width: 'full',
  code: {
    html: read('city-iot-culvert-live.html'),
    css: read('city-iot-culvert-live.css'),
    javascript: read('city-iot-culvert-live.js'),
    inputs: ['iot-table', 'readings-table'],
    actions: [],
    height: 560,
  },
};

const widgets = bundle.plugin.widgets.filter(
  (widget) => !['culvert-heading', 'culvert-live'].includes(widget.id)
);
const anchor = widgets.findIndex((widget) => widget.id === 'readings-metric');
const insertAt = anchor >= 0 ? anchor + 1 : widgets.length;
widgets.splice(insertAt, 0, heading, live);
bundle.plugin.widgets = widgets;

fs.writeFileSync(bundlePath, JSON.stringify(bundle, null, 2) + '\n');
console.log(`Injected culvert widgets at ${insertAt}; widgets=${widgets.length}`);
