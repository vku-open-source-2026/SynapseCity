// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Tier-3 MQTT edge bridge: subscribes mosquitto topic city/sensors/+/data
// and forwards to Tier-2 telemetry ingest (public HTTPS), which persists via
// Tier-1 Base and fans out to Tier-1 Stream.
// Tier-3 never touches Tier-1 directly. Run: node index.js
import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://mqtt:1883';
const MQTT_TOPIC = process.env.MQTT_TOPIC || 'city/sensors/+/data';
const TIER2_BASE_URL = (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/+$/, '');
const TIER2_API_KEY = process.env.SYNAPSEDX_API_KEY || '';
const TIER2_TOKEN = process.env.SYNAPSEDX_TOKEN || '';
const DATASET_ID = process.env.TELEMETRY_DATASET || 'city-iot-readings';
const SENSOR_DATASET = process.env.SENSOR_DATASET || 'city-iot-sensors';
const UPDATE_SENSORS = (process.env.UPDATE_SENSORS || 'true') !== 'false';
const BATCH_MS = Number(process.env.BRIDGE_BATCH_MS || 1000);
const BATCH_MAX = Math.min(Math.max(Number(process.env.BRIDGE_BATCH_MAX || 50), 1), 100);

if (!TIER2_API_KEY && !TIER2_TOKEN) {
  console.error('[iot-bridge] missing SYNAPSEDX_API_KEY (or SYNAPSEDX_TOKEN)');
  process.exit(1);
}

const queue = [];
let timer = null;

function tier2Headers(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (TIER2_API_KEY) headers['X-API-Key'] = TIER2_API_KEY;
  if (TIER2_TOKEN) headers.Authorization = `Bearer ${TIER2_TOKEN}`;
  return headers;
}

/**
 * Keep the sensor registry's last_reading/last_seen current so the workspace
 * table and map do not lag behind the readings dataset. The Tier-2 PATCH
 * replaces `data`, so read the record first and merge with its version (CAS).
 */
async function touchSensors(readings) {
  if (!UPDATE_SENSORS || !readings.length) return;
  const latest = new Map();
  for (const reading of readings) latest.set(reading.sensor_id, reading);
  for (const [sensorId, reading] of latest) {
    const url = `${TIER2_BASE_URL}/v1/capabilities/datasets/${SENSOR_DATASET}/records/${encodeURIComponent(sensorId)}`;
    try {
      const current = await fetch(url, { headers: tier2Headers() });
      if (!current.ok) {
        if (current.status !== 404) console.warn(`[iot-bridge] sensor ${sensorId} GET ${current.status}`);
        continue;
      }
      const document = await current.json();
      const data = document?.data || {};
      const merged = {
        ...data,
        status: 'online',
        last_reading: reading.value,
        last_seen: reading.timestamp,
        last_reading_at: reading.timestamp,
        last_reading_unit: data.measurement_unit || data.last_reading_unit,
        updated_at: new Date().toISOString(),
      };
      const patched = await fetch(url, {
        method: 'PATCH',
        headers: tier2Headers(),
        body: JSON.stringify({ data: merged, ifVersion: document.version }),
      });
      if (!patched.ok) {
        const body = (await patched.text()).slice(0, 200);
        console.warn(`[iot-bridge] sensor ${sensorId} PATCH ${patched.status}: ${body}`);
      }
    } catch (error) {
      console.warn(`[iot-bridge] sensor ${sensorId} update failed: ${error.message}`);
    }
  }
}

async function flush() {
  timer = null;
  if (!queue.length) return;
  const readings = queue.splice(0, queue.length);
  try {
    const res = await fetch(`${TIER2_BASE_URL}/v1/capabilities/telemetry/ingest`, {
      method: 'POST',
      headers: tier2Headers(),
      body: JSON.stringify({ datasetId: DATASET_ID, readings, source: 'mqtt' }),
    });
    if (!res.ok) {
      console.error(`[iot-bridge] ingest ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return;
    }
    const out = await res.json();
    console.log(`[iot-bridge] forwarded=${readings.length} created=${out.total} stream=${out.stream?.topic}`);
    await touchSensors(readings);
  } catch (err) {
    console.error(`[iot-bridge] forward failed: ${err.message}`);
  }
}

function schedule() {
  if (timer || !queue.length) return;
  timer = setTimeout(flush, BATCH_MS);
  if (queue.length >= BATCH_MAX) {
    clearTimeout(timer);
    flush();
  }
}

const client = mqtt.connect(MQTT_URL);
client.on('connect', () => {
  console.log(`[iot-bridge] connected ${MQTT_URL}, sub ${MQTT_TOPIC}`);
  client.subscribe(MQTT_TOPIC, (err) => {
    if (err) console.error(`[iot-bridge] subscribe failed: ${err.message}`);
  });
});
client.on('message', (topic, payload) => {
  // topic: city/sensors/{sensor_id}/data
  const parts = topic.split('/');
  const sensorId = parts[2] || '';
  if (!sensorId) return;
  let body;
  try {
    body = JSON.parse(payload.toString());
  } catch {
    const v = Number(payload.toString());
    if (!Number.isFinite(v)) return;
    body = { value: v };
  }
  const value = Number(body.value ?? body.v ?? body.val);
  if (!Number.isFinite(value)) {
    console.warn(`[iot-bridge] skip non-numeric ${topic}`);
    return;
  }
  queue.push({
    sensor_id: sensorId,
    value,
    timestamp: typeof body.timestamp === 'string' ? body.timestamp : new Date().toISOString(),
    ...(body.metadata ? { metadata: body.metadata } : {}),
  });
  schedule();
});
client.on('error', (err) => console.error(`[iot-bridge] mqtt: ${err.message}`));

process.on('SIGTERM', () => { client.end(); if (timer) clearTimeout(timer); });
