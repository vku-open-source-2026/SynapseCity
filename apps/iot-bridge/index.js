// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// Tier-3 MQTT edge bridge: subscribes to city/sensors/+/data at QoS 1 and
// forwards validated readings to Tier-2 telemetry ingest over HTTPS.
// Tier-3 never touches Tier-1 directly. Run: node index.js
import { readFileSync } from 'node:fs';
import mqtt from 'mqtt';

const MQTT_TOPIC = 'city/sensors/+/data';
const SENSOR_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;
const DISABLED_SENSOR_STATUSES = new Set(['inactive', 'decommissioned', 'deleted', 'retired']);

function fail(message) {
  console.error(`[iot-bridge] ${message}`);
  process.exit(1);
}

function integerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${name} must be an integer in ${min}..${max}`);
  }
  return value;
}

function numberEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) fail(`${name} must be a finite number`);
  return value;
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) fail(`missing ${name}`);
  return value;
}

function mqttUrl() {
  const value = process.env.MQTT_URL || 'mqtt://mqtt:1883';
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('MQTT_URL must be a valid mqtt:// or mqtts:// URL');
  }
  if (!['mqtt:', 'mqtts:'].includes(parsed.protocol)) {
    fail('MQTT_URL must use mqtt:// or mqtts://');
  }
  if (parsed.username || parsed.password) {
    fail('MQTT_URL must not contain credentials; use MQTT_USERNAME/MQTT_PASSWORD');
  }
  return value;
}

function tier2BaseUrl() {
  const value = (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail('SYNAPSEDX_BASE_URL must be a valid URL');
  }
  if (parsed.username || parsed.password) fail('SYNAPSEDX_BASE_URL must not contain credentials');
  const localTest = process.env.NODE_ENV === 'test';
  if (parsed.protocol !== 'https:' && !localTest) {
    fail('SYNAPSEDX_BASE_URL must use HTTPS outside explicitly marked local tests');
  }
  return value;
}

const MQTT_URL = mqttUrl();
const MQTT_USERNAME = requiredEnv('MQTT_USERNAME');
const MQTT_PASSWORD = requiredEnv('MQTT_PASSWORD');
const MQTT_CLIENT_ID = process.env.MQTT_CLIENT_ID || 'iot-bridge';
const MQTT_SESSION_EXPIRY_SECONDS = integerEnv('MQTT_SESSION_EXPIRY_SECONDS', 7 * 24 * 60 * 60, 60, 30 * 24 * 60 * 60);
const TIER2_BASE_URL = tier2BaseUrl();
const TIER2_API_KEY = process.env.SYNAPSEDX_API_KEY || '';
const TIER2_TOKEN = process.env.SYNAPSEDX_TOKEN || '';
const DATASET_ID = process.env.TELEMETRY_DATASET || 'city-iot-readings';
const SENSOR_DATASET = process.env.SENSOR_DATASET || 'city-iot-sensors';
const UPDATE_SENSORS = (process.env.UPDATE_SENSORS || 'true') !== 'false';
const BATCH_MS = integerEnv('BRIDGE_BATCH_MS', 1000, 10, 60_000);
const BATCH_MAX = integerEnv('BRIDGE_BATCH_MAX', 50, 1, 100);
const QUEUE_MAX = integerEnv('BRIDGE_QUEUE_MAX', 5000, BATCH_MAX, 20_000);
const RETRY_BASE_MS = integerEnv('BRIDGE_RETRY_BASE_MS', 1000, 10, 60_000);
const RETRY_MAX_MS = integerEnv('BRIDGE_RETRY_MAX_MS', 30_000, RETRY_BASE_MS, 300_000);
const SHUTDOWN_TIMEOUT_MS = integerEnv('BRIDGE_SHUTDOWN_TIMEOUT_MS', 30_000, 1000, 300_000);
const FETCH_TIMEOUT_MS = integerEnv('BRIDGE_FETCH_TIMEOUT_MS', 10_000, 100, 60_000);
const SENSOR_CACHE_MS = integerEnv('IOT_SENSOR_CACHE_MS', 5000, 0, 24 * 60 * 60 * 1000);
const SENSOR_CACHE_MAX = integerEnv('IOT_SENSOR_CACHE_MAX', 1000, 10, 10_000);
const TIMESTAMP_MAX_AGE_MS = integerEnv('IOT_TIMESTAMP_MAX_AGE_MS', 7 * 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000);
const TIMESTAMP_MAX_FUTURE_MS = integerEnv('IOT_TIMESTAMP_MAX_FUTURE_MS', 5 * 60 * 1000, 0, 60 * 60 * 1000);
const VALUE_MIN = numberEnv('IOT_VALUE_MIN', -1_000_000);
const VALUE_MAX = numberEnv('IOT_VALUE_MAX', 1_000_000);

if (!TIER2_API_KEY && !TIER2_TOKEN) {
  fail('missing SYNAPSEDX_API_KEY (or SYNAPSEDX_TOKEN)');
}
if (!DATASET_ID.startsWith('city-') || !SENSOR_DATASET.startsWith('city-')) {
  fail('TELEMETRY_DATASET and SENSOR_DATASET must use the city- prefix');
}
if (VALUE_MIN >= VALUE_MAX) fail('IOT_VALUE_MIN must be less than IOT_VALUE_MAX');

let mqttCa;
if (process.env.MQTT_CA_FILE) {
  try {
    mqttCa = readFileSync(process.env.MQTT_CA_FILE);
  } catch {
    fail('cannot read MQTT_CA_FILE');
  }
}

function tier2Headers(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  if (TIER2_API_KEY) headers['X-API-Key'] = TIER2_API_KEY;
  if (TIER2_TOKEN) headers.Authorization = `Bearer ${TIER2_TOKEN}`;
  return headers;
}

function requestSignal(timeout = FETCH_TIMEOUT_MS) {
  const remaining = shutdownDeadline ? shutdownDeadline - Date.now() : timeout;
  const timeoutSignal = AbortSignal.timeout(Math.max(1, Math.min(timeout, remaining)));
  return AbortSignal.any([timeoutSignal, shutdownController.signal]);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validMetadata(value, depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 4 || Array.isArray(value)) return false;
  if (!isPlainObject(value)) return false;
  const entries = Object.entries(value);
  return entries.length <= 50 && entries.every(([, nested]) => validMetadata(nested, depth + 1));
}

function timestampError(value) {
  if (typeof value !== 'string') return 'invalid_timestamp';
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return 'invalid_timestamp';
  const skew = milliseconds - Date.now();
  if (skew > TIMESTAMP_MAX_FUTURE_MS) return 'timestamp_in_future';
  if (-skew > TIMESTAMP_MAX_AGE_MS) return 'timestamp_too_old';
  return null;
}

function parseReading(topic, payload) {
  const parts = topic.split('/');
  if (parts.length !== 4 || parts[0] !== 'city' || parts[1] !== 'sensors' || parts[3] !== 'data'
    || !SENSOR_ID_PATTERN.test(parts[2])) {
    return { error: 'invalid_topic' };
  }
  if (payload.length > MAX_PAYLOAD_BYTES) return { error: 'payload_too_large' };

  const text = payload.toString('utf8');
  let body;
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'number') body = { value: parsed };
    else if (isPlainObject(parsed)) body = parsed;
    else return { error: 'invalid_payload' };
  } catch {
    if (text.trim() === '') return { error: 'invalid_payload' };
    const value = Number(text);
    if (!Number.isFinite(value)) return { error: 'invalid_payload' };
    body = { value };
  }

  const rawValue = body.value ?? body.v ?? body.val;
  if (!['number', 'string'].includes(typeof rawValue)) return { error: 'invalid_value' };
  if (typeof rawValue === 'string' && rawValue.trim() === '') return { error: 'invalid_value' };
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return { error: 'invalid_value' };

  let timestamp;
  if (body.timestamp === undefined) {
    timestamp = new Date().toISOString();
  } else {
    const error = timestampError(body.timestamp);
    if (error) return { error };
    timestamp = new Date(Date.parse(body.timestamp)).toISOString();
  }

  let metadata;
  if (body.metadata !== undefined) {
    if (!isPlainObject(body.metadata) || !validMetadata(body.metadata)) return { error: 'invalid_metadata' };
    if (Buffer.byteLength(JSON.stringify(body.metadata), 'utf8') > MAX_METADATA_BYTES) {
      return { error: 'metadata_too_large' };
    }
    metadata = body.metadata;
  }

  const sensorId = parts[2];
  return {
    reading: {
      sensor_id: sensorId,
      value,
      timestamp,
      ...(metadata ? { metadata } : {}),
    },
  };
}

const sensorCache = new Map();
const sensorRequests = new Map();

function cacheSensor(sensorId, sensor) {
  if (sensorCache.size >= SENSOR_CACHE_MAX && !sensorCache.has(sensorId)) {
    sensorCache.delete(sensorCache.keys().next().value);
  }
  const ttl = sensor ? SENSOR_CACHE_MS : Math.min(SENSOR_CACHE_MS, 5000);
  sensorCache.set(sensorId, { sensor, expiresAt: Date.now() + ttl });
}

async function getSensor(sensorId) {
  const cached = sensorCache.get(sensorId);
  if (cached && cached.expiresAt > Date.now()) return cached.sensor;
  sensorCache.delete(sensorId);
  if (sensorRequests.has(sensorId)) return sensorRequests.get(sensorId);

  const request = (async () => {
    const url = `${TIER2_BASE_URL}/v1/capabilities/datasets/${SENSOR_DATASET}/records/${encodeURIComponent(sensorId)}`;
    const response = await fetch(url, { headers: tier2Headers(), signal: requestSignal() });
    if (response.status === 404) {
      cacheSensor(sensorId, null);
      return null;
    }
    if (!response.ok) throw new Error(`sensor registry HTTP ${response.status}`);
    const document = await response.json();
    if (!isPlainObject(document?.data)) throw new Error('sensor registry returned an invalid record');
    cacheSensor(sensorId, document.data);
    return document.data;
  })().finally(() => sensorRequests.delete(sensorId));

  sensorRequests.set(sensorId, request);
  return request;
}

function sensorApproved(sensor) {
  if (!isPlainObject(sensor)) return false;
  const status = String(sensor.status || '').toLowerCase();
  return !DISABLED_SENSOR_STATUSES.has(status);
}

function firstFinite(...values) {
  return values.find((value) => typeof value === 'number' && Number.isFinite(value));
}

function readingRange(sensor) {
  const configured = [sensor.reading_range, sensor.valid_range, sensor].find(isPlainObject);
  const thresholds = isPlainObject(sensor.thresholds) ? sensor.thresholds : {};
  const min = firstFinite(configured?.min, configured?.min_value, thresholds.min_value, VALUE_MIN);
  const max = firstFinite(configured?.max, configured?.max_value, thresholds.max_value, VALUE_MAX);
  return { min, max };
}

function valueInRange(value, range) {
  return Number.isFinite(range.min) && Number.isFinite(range.max) && range.min < range.max
    && value >= range.min && value <= range.max;
}

/**
 * Keep the sensor registry's last_reading/last_seen current after Tier-2 has
 * accepted the readings. The Tier-2 PATCH replaces data, so read and merge the
 * current record with its version (CAS). Registry updates are best effort and
 * never cause an already-persisted reading to be retried.
 */
async function touchSensors(readings) {
  if (!UPDATE_SENSORS || !readings.length) return;
  const latest = new Map();
  for (const reading of readings) latest.set(reading.sensor_id, reading);
  await Promise.all(Array.from(latest, async ([sensorId, reading]) => {
    const url = `${TIER2_BASE_URL}/v1/capabilities/datasets/${SENSOR_DATASET}/records/${encodeURIComponent(sensorId)}`;
    try {
      const current = await fetch(url, { headers: tier2Headers(), signal: requestSignal() });
      if (!current.ok) {
        if (current.status !== 404) console.warn(`[iot-bridge] sensor ${sensorId} GET ${current.status}`);
        return;
      }
      const document = await current.json();
      const data = document?.data;
      if (!isPlainObject(data) || !sensorApproved(data) || !valueInRange(reading.value, readingRange(data))) return;
      const previousSeen = Date.parse(String(data.last_seen || data.last_reading_at || ''));
      if (Number.isFinite(previousSeen) && Date.parse(reading.timestamp) < previousSeen) return;
      const declaredStatus = String(data.status || '').toLowerCase();
      const merged = {
        ...data,
        status: declaredStatus === 'maintenance' ? 'maintenance' : 'online',
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
        signal: requestSignal(),
      });
      if (!patched.ok) console.warn(`[iot-bridge] sensor ${sensorId} PATCH ${patched.status}`);
    } catch (error) {
      console.warn(`[iot-bridge] sensor ${sensorId} update failed: ${error.message}`);
    }
  }));
}

// This is an ephemeral transport buffer, not a replacement for Tier-2 records.
// Items stay here, and their MQTT PUBACK stays pending, until ingest succeeds.
const queue = [];
const pendingByMessageId = new Map();
let timer = null;
let flushing = null;
let stopping = false;
let shutdownPromise = null;
let shutdownDeadline = 0;
let shutdownTimer = null;
const shutdownController = new AbortController();
let retryDelay = RETRY_BASE_MS;
let sessionGeneration = 0;

function acknowledge(item, reasonCode = 0) {
  if (item.acknowledged) return;
  item.acknowledged = true;
  pendingByMessageId.delete(item.messageKey);
  try {
    item.ack(null, reasonCode);
  } catch (error) {
    console.warn(`[iot-bridge] MQTT acknowledgement failed: ${error.message}`);
  }
}

function removeItems(items) {
  const removed = new Set(items);
  for (let index = queue.length - 1; index >= 0; index -= 1) {
    if (removed.has(queue[index])) queue.splice(index, 1);
  }
}

function schedule(delay = BATCH_MS) {
  if (stopping || timer || !queue.length) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, delay);
}

async function validateBatch(batch) {
  const results = await Promise.all(batch.map(async (item) => {
    try {
      const sensor = await getSensor(item.reading.sensor_id);
      if (!sensor) return { item, error: 'sensor_not_registered' };
      if (!sensorApproved(sensor)) return { item, error: 'sensor_not_active' };
      const timestampIssue = timestampError(item.reading.timestamp);
      if (timestampIssue) return { item, error: timestampIssue };
      const range = readingRange(sensor);
      if (range.min >= range.max) return { item, error: 'invalid_sensor_range' };
      if (!valueInRange(item.reading.value, range)) return { item, error: 'value_out_of_range' };
      return { item };
    } catch (error) {
      return { item, retryable: error };
    }
  }));
  const retryable = results.find((result) => result.retryable);
  if (retryable) throw retryable.retryable;
  return {
    accepted: results.filter((result) => !result.error).map((result) => result.item),
    rejected: results.filter((result) => result.error),
  };
}

async function attemptFlush() {
  if (!queue.length) return true;
  const batch = queue.slice(0, BATCH_MAX);
  let validated;
  try {
    validated = await validateBatch(batch);
  } catch (error) {
    console.warn(`[iot-bridge] sensor validation deferred: ${error.message}`);
    return false;
  }

  for (const result of validated.rejected) {
    console.warn(`[iot-bridge] reject ${result.item.reading.sensor_id}: ${result.error}`);
  }
  removeItems(validated.rejected.map((result) => result.item));
  for (const result of validated.rejected) acknowledge(result.item, 128);

  if (!validated.accepted.length) return true;
  const readings = validated.accepted.map((item) => item.reading);
  try {
    const response = await fetch(`${TIER2_BASE_URL}/v1/capabilities/telemetry/ingest`, {
      method: 'POST',
      headers: tier2Headers(),
      body: JSON.stringify({ datasetId: DATASET_ID, readings, source: 'mqtt' }),
      signal: requestSignal(),
    });
    if (!response.ok) {
      console.warn(`[iot-bridge] ingest ${response.status}; keeping ${readings.length} reading(s) for retry`);
      return false;
    }
    let output = {};
    try {
      output = await response.json();
    } catch {
      // A 2xx response is authoritative even if its optional log payload is malformed.
    }
    removeItems(validated.accepted);
    for (const item of validated.accepted) acknowledge(item);
    console.log(`[iot-bridge] forwarded=${readings.length} created=${output.total ?? 'unknown'} stream=${output.stream?.topic || 'unknown'}`);
    await touchSensors(readings);
    return true;
  } catch (error) {
    console.warn(`[iot-bridge] forward failed; keeping ${readings.length} reading(s): ${error.message}`);
    return false;
  }
}

async function flush() {
  if (flushing) return flushing;
  const run = (async () => {
    const success = await attemptFlush();
    if (success) {
      retryDelay = RETRY_BASE_MS;
      schedule(queue.length ? 0 : BATCH_MS);
    } else {
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
      schedule(retryDelay);
    }
    return success;
  })();
  flushing = run;
  try {
    return await run;
  } finally {
    if (flushing === run) flushing = null;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function handleIngress(topic, payload, packet, done) {
  // During shutdown, leave new packets unacknowledged so the broker redelivers
  // them to the persistent session after restart.
  if (stopping) return;
  const parsed = parseReading(topic, payload);
  if (parsed.error) {
    console.warn(`[iot-bridge] skip ${topic}: ${parsed.error}`);
    done(null, 128);
    return;
  }

  const messageKey = `${sessionGeneration}:${packet.messageId}`;
  const existing = pendingByMessageId.get(messageKey);
  if (existing) {
    existing.ack = done;
    return;
  }
  if (queue.length >= QUEUE_MAX) {
    console.error(`[iot-bridge] queue full (${QUEUE_MAX}); disconnecting without acknowledging new readings`);
    process.exitCode = 1;
    void shutdown('queue_full');
    return;
  }

  const item = { ...parsed, messageId: packet.messageId, messageKey, ack: done, acknowledged: false };
  pendingByMessageId.set(messageKey, item);
  queue.push(item);
  schedule();
  if (queue.length >= BATCH_MAX) {
    if (timer) clearTimeout(timer);
    timer = null;
    void flush();
  }
}

async function endMqtt(force) {
  if (!client) return;
  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      client.destroy();
      finish();
    }, 2000);
    try {
      client.end(force, {}, finish);
    } catch {
      client.destroy();
      finish();
    }
  });
}

async function shutdown(reason, exitCode = 0) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  shutdownDeadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
  shutdownTimer = setTimeout(() => shutdownController.abort(new Error('shutdown_deadline')), SHUTDOWN_TIMEOUT_MS);
  if (timer) clearTimeout(timer);
  timer = null;
  console.log(`[iot-bridge] graceful shutdown (${reason}); queued=${queue.length}`);

  shutdownPromise = (async () => {
    const deadline = shutdownDeadline;
    while (queue.length && Date.now() < deadline) {
      await flush();
      if (queue.length) await sleep(Math.min(retryDelay, Math.max(0, deadline - Date.now())));
    }
    const drained = queue.length === 0;
    if (shutdownTimer) clearTimeout(shutdownTimer);
    await endMqtt(!drained);
    if (!drained) {
      console.error(`[iot-bridge] shutdown deadline reached with ${queue.length} unacknowledged reading(s); broker will redeliver`);
    }
    process.exit(drained ? exitCode : 1);
  })();
  return shutdownPromise;
}

const client = mqtt.connect(MQTT_URL, {
  clientId: MQTT_CLIENT_ID,
  username: MQTT_USERNAME,
  password: MQTT_PASSWORD,
  protocolVersion: 5,
  clean: false,
  properties: { sessionExpiryInterval: MQTT_SESSION_EXPIRY_SECONDS },
  reconnectPeriod: 1000,
  connectTimeout: 10_000,
  keepalive: 30,
  customHandleAcks: handleIngress,
  ...(mqttCa ? { ca: mqttCa } : {}),
});

client.on('connect', (connack) => {
  if (!connack.sessionPresent) sessionGeneration += 1;
  console.log(`[iot-bridge] connected; session_present=${Boolean(connack.sessionPresent)}`);
  client.subscribe(MQTT_TOPIC, { qos: 1 }, (error, granted) => {
    if (error || granted?.[0]?.qos !== 1) {
      console.error(`[iot-bridge] QoS 1 subscribe failed: ${error?.message || 'broker did not grant QoS 1'}`);
      void shutdown('subscribe_failed', 1);
      return;
    }
    console.log(`[iot-bridge] subscribed ${MQTT_TOPIC} qos=${granted[0].qos}`);
  });
});
client.on('message', (topic, _payload, packet) => {
  // customHandleAcks handles QoS 1. A QoS 0 publisher is deliberately not
  // forwarded even if it reaches a QoS 1 subscription.
  if (packet.qos === 0) console.warn(`[iot-bridge] skip ${topic}: qos_0_not_accepted`);
});
client.on('error', (error) => console.error(`[iot-bridge] mqtt: ${error.message}`));
client.on('close', () => console.warn('[iot-bridge] mqtt disconnected'));

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
