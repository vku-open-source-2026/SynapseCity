// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Virtual ESP32 for the City water-culvert demo. Publishes realistic
// water-level readings to MQTT, so the workspace, iot-bridge and Tier-2
// telemetry path stay live without physical hardware.
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';

const MQTT_URL = process.env.MQTT_URL || 'mqtt://mqtt:1883';
const MQTT_USERNAME = process.env.MQTT_USERNAME || '';
const MQTT_PASSWORD = process.env.MQTT_PASSWORD || '';
const SENSOR_ID = process.env.MOCK_SENSOR_ID || 'cong-nc-001-wl';
const SENSOR_CODE = process.env.MOCK_SENSOR_CODE || 'CONG-NC-001-WL';
const INTERVAL_MS = Math.min(Math.max(Number(process.env.MOCK_INTERVAL_MS || 15000), 2000), 3600000);
const MODE = process.env.MOCK_MODE || 'culvert';
const DEPTH_CM = Number(process.env.MOCK_DEPTH_CM || 220);
const TOPIC = process.env.MOCK_TOPIC || `city/sensors/${SENSOR_ID}/data`;

function fail(message) {
  console.error(`[iot-mock] ${message}`);
  process.exit(1);
}

if (!MQTT_USERNAME || !MQTT_PASSWORD) fail('missing MQTT_USERNAME/MQTT_PASSWORD');
if (!/^[A-Za-z0-9_.:@-]{1,128}$/.test(SENSOR_ID)) fail('MOCK_SENSOR_ID contains unsupported characters');
if (MQTT_USERNAME !== SENSOR_ID) fail('MQTT_USERNAME must equal MOCK_SENSOR_ID for the per-device ACL');
if (TOPIC !== `city/sensors/${SENSOR_ID}/data`) fail('MOCK_TOPIC must match the credentialed sensor topic');

let parsedUrl;
try {
  parsedUrl = new URL(MQTT_URL);
} catch {
  fail('MQTT_URL must be a valid mqtt:// or mqtts:// URL');
}
if (!['mqtt:', 'mqtts:'].includes(parsedUrl.protocol)) fail('MQTT_URL must use mqtt:// or mqtts://');
if (parsedUrl.username || parsedUrl.password) fail('MQTT_URL must not contain credentials');

let mqttCa;
if (process.env.MQTT_CA_FILE) {
  try {
    mqttCa = readFileSync(process.env.MQTT_CA_FILE);
  } catch {
    fail('cannot read MQTT_CA_FILE');
  }
}

const mqttClient = mqtt.connect(MQTT_URL, {
  clientId: `city-mock-${SENSOR_ID}`.slice(0, 23),
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  ...(mqttCa ? { ca: mqttCa } : {}),
});

let phase = 0;
let stormUntil = 0;
let stormExtra = 0;
let nextStormAt = Date.now() + 2 * 60 * 1000;

function culvertLevel() {
  const now = Date.now();
  phase += INTERVAL_MS / 1000;
  // Slow drainage/tide cycle + sensor noise + short storm surges. Surges are
  // deliberately strong enough to cross the 350/450 cm demo thresholds.
  let level = DEPTH_CM * 0.42 + Math.sin(phase / 240) * 34 + (Math.random() - 0.5) * 4;
  if (now > nextStormAt) {
    const severe = Math.random() < 0.35;
    stormExtra = severe ? 0.62 : 0.38;
    stormUntil = now + (70 + Math.random() * 110) * 1000;
    nextStormAt = now + (4 + Math.random() * 6) * 60 * 1000;
    console.log(`[iot-mock] storm surge start (${severe ? 'severe' : 'moderate'})`);
  }
  if (now < stormUntil) level += DEPTH_CM * stormExtra + Math.sin(phase / 20) * 8;
  return Math.max(5, Math.min(DEPTH_CM, level));
}

function genericLevel() {
  phase += INTERVAL_MS / 1000;
  return 50 + Math.sin(phase / 180) * 25 + (Math.random() - 0.5) * 4;
}

function reading() {
  const value = MODE === 'culvert' ? culvertLevel() : genericLevel();
  const timestamp = new Date().toISOString();
  return {
    value: Math.round(value * 100) / 100,
    timestamp,
    metadata: {
      source: 'mock-publisher',
      mode: 'mock',
      mock_mode: MODE,
      sensor_code: SENSOR_CODE,
      interval_ms: INTERVAL_MS,
    },
  };
}

function publish() {
  const body = reading();
  mqttClient.publish(TOPIC, JSON.stringify(body), { qos: 1 }, (error) => {
    if (error) console.error(`[iot-mock] publish failed: ${error.message}`);
    else console.log(`[iot-mock] ${TOPIC} value=${body.value} cm ts=${body.timestamp}`);
  });
}

mqttClient.on('connect', () => {
  console.log(`[iot-mock] connected; publishing ${TOPIC} every ${INTERVAL_MS}ms (mode=${MODE})`);
  publish();
  setInterval(publish, INTERVAL_MS);
});
mqttClient.on('reconnect', () => console.log('[iot-mock] reconnecting mqtt...'));
mqttClient.on('error', (error) => console.error(`[iot-mock] mqtt: ${error.message}`));

process.on('SIGTERM', () => mqttClient.end(false));
process.on('SIGINT', () => mqttClient.end(false));
