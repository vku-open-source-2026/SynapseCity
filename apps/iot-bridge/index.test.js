// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import mqtt from 'mqtt';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mosquittoBin = process.env.MOSQUITTO_BIN || 'mosquitto';
const passwdBin = process.env.MOSQUITTO_PASSWD_BIN || 'mosquitto_passwd';
const opensslBin = process.env.OPENSSL_BIN || 'openssl';
const probe = spawnSync(mosquittoBin, ['-h'], { encoding: 'utf8' });
if (probe.error) {
  throw new Error(`Mosquitto is required for the IoT integration test; set MOSQUITTO_BIN (${probe.error.message})`);
}
const tlsProbe = spawnSync(opensslBin, ['version'], { encoding: 'utf8' });
if (tlsProbe.error) {
  throw new Error(`OpenSSL is required for the IoT TLS integration test; set OPENSSL_BIN (${tlsProbe.error.message})`);
}

const credentials = {
  'sensor-a': 'synthetic-sensor-a-password',
  'sensor-b': 'synthetic-sensor-b-password',
  'sensor-unknown': 'synthetic-unknown-password',
  'iot-bridge': 'synthetic-bridge-password',
};
let caCertificate;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForPort(port) {
  await waitFor(async () => {
    try {
      await new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      return true;
    } catch {
      return false;
    }
  }, `Mosquitto did not listen on ${port}`);
}

function withTimeout(promise, message, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeout);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function endClient(client) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { client.destroy(); resolve(); }, 2000);
    client.end(false, {}, () => { clearTimeout(timer); resolve(); });
  });
}

function publish(client, topic, body, qos = 1) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`publish timed out: ${topic}`)), 3000);
    client.publish(topic, JSON.stringify(body), { qos }, (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
  });
}

async function connectPublisher(url, username, password) {
  return mqtt.connectAsync(url, {
    clientId: `test-${username}-${randomUUID()}`,
    username,
    password,
    protocolVersion: 5,
    reconnectPeriod: 0,
    connectTimeout: 2000,
    ...(url.startsWith('mqtts:') ? { ca: caCertificate } : {}),
  });
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

test('TLS MQTT authentication/ACL, validation, QoS 1 retry, and graceful shutdown', { timeout: 45_000 }, async () => {
  const directory = mkdtempSync('/tmp/opencode/synapsecity-iot-test-');
  const mqttPort = await freePort();
  let tlsPort = await freePort();
  while (tlsPort === mqttPort) tlsPort = await freePort();
  const passwordFile = path.join(directory, 'password_file');
  const aclFile = path.join(directory, 'aclfile');
  const configFile = path.join(directory, 'mosquitto.conf');
  const certFile = path.join(directory, 'server.crt');
  const keyFile = path.join(directory, 'server.key');
  const dataDirectory = path.join(directory, 'data');
  mkdirSync(dataDirectory);
  const mqttUrl = `mqtts://127.0.0.1:${tlsPort}`;
  const bridgeMqttUrl = `mqtt://127.0.0.1:${mqttPort}`;
  const bridgeClientId = `iot-bridge-test-${randomUUID()}`;
  let broker;
  let bridge;
  let bridgeOutput = '';
  let bridgeExit;
  let upstream;
  let publishers = [];

  for (const [index, [username, password]] of Object.entries(credentials).entries()) {
    const args = index === 0 ? ['-b', '-c', passwordFile, username, password] : ['-b', passwordFile, username, password];
    const result = spawnSync(passwdBin, args, { encoding: 'utf8' });
    assert.equal(result.status, 0, `could not create synthetic MQTT credential for ${username}`);
  }
  writeFileSync(aclFile, readFileSync(path.join(root, 'infra/mosquitto/aclfile')));
  const certificate = spawnSync(opensslBin, [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', keyFile, '-out', certFile, '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { encoding: 'utf8' });
  assert.equal(certificate.status, 0, 'could not generate synthetic TLS certificate');
  caCertificate = readFileSync(certFile);
  const productionConfig = readFileSync(path.join(root, 'infra/mosquitto/mosquitto.conf'), 'utf8')
    .replace('listener 1883', `listener ${mqttPort} 127.0.0.1`)
    .replace('listener 8883', `listener ${tlsPort} 127.0.0.1`)
    .replaceAll('/run/secrets/mqtt_password_file', passwordFile)
    .replaceAll('/run/secrets/mqtt_acl_file', aclFile)
    .replaceAll('/run/secrets/mqtt_tls_ca_file', certFile)
    .replaceAll('/run/secrets/mqtt_tls_cert_file', certFile)
    .replaceAll('/run/secrets/mqtt_tls_key_file', keyFile)
    .replace('/mosquitto/data/', `${dataDirectory}/`);
  writeFileSync(configFile, `${productionConfig}\nuser root\n`);

  const state = {
    failIngest: false,
    ingestAttempts: 0,
    ingestBodies: [],
    patches: [],
  };

  try {
    broker = spawn(mosquittoBin, ['-c', configFile], { stdio: ['ignore', 'ignore', 'pipe'] });
    let brokerErrors = '';
    broker.stderr.on('data', (chunk) => { brokerErrors += chunk.toString(); });
    broker.on('error', (error) => { brokerErrors += error.message; });
    await waitForPort(mqttPort);
    await waitForPort(tlsPort);
    assert.equal(broker.exitCode, null, `Mosquitto exited during startup: ${brokerErrors}`);

    await assert.rejects(
      withTimeout(mqtt.connectAsync(mqttUrl, {
        clientId: `anonymous-${randomUUID()}`,
        protocolVersion: 5,
        reconnectPeriod: 0,
        connectTimeout: 2000,
        ca: caCertificate,
      }), 'anonymous MQTT connection was not rejected'),
      /not authorized|connection refused/i,
      'anonymous MQTT connection must fail',
    );

    const sensorA = await connectPublisher(mqttUrl, 'sensor-a', credentials['sensor-a']);
    const sensorB = await connectPublisher(mqttUrl, 'sensor-b', credentials['sensor-b']);
    publishers.push(sensorA, sensorB);
    await assert.rejects(
      publish(sensorA, 'city/sensors/sensor-b/data', { value: 10 }),
      /not authorized|authorized/i,
      'cross-device publish must fail',
    );
    await publish(sensorA, 'city/sensors/sensor-a/data', { value: 10 });
    await publish(sensorB, 'city/sensors/sensor-b/data', { value: 11 });

    const bridgeAccount = await connectPublisher(mqttUrl, 'iot-bridge', credentials['iot-bridge']);
    publishers.push(bridgeAccount);
    await assert.rejects(
      publish(bridgeAccount, 'city/sensors/sensor-a/data', { value: 12 }),
      /not authorized|authorized/i,
      'bridge service account must not publish telemetry',
    );
    await assert.rejects(
      publish(bridgeAccount, 'city/sensors/iot-bridge/data', { value: 12 }),
      /not authorized|authorized/i,
      'bridge service account must not publish even to its reserved topic',
    );
    await endClient(bridgeAccount);

    upstream = http.createServer((request, response) => {
      requestBody(request).then((body) => {
        response.setHeader('content-type', 'application/json');
        if (request.method === 'GET' && request.url === '/v1/capabilities/datasets/city-iot-sensors/records/sensor-a') {
          response.end(JSON.stringify({
            data: {
              id: 'sensor-a',
              status: 'online',
              measurement_unit: 'cm',
              reading_range: { min: 0, max: 100 },
            },
            version: 1,
          }));
          return;
        }
        if (request.method === 'GET' && request.url.endsWith('/records/sensor-unknown')) {
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        if (request.method === 'POST' && request.url === '/v1/capabilities/telemetry/ingest') {
          state.ingestAttempts += 1;
          state.ingestBodies.push(body);
          if (state.failIngest) {
            response.statusCode = 503;
            response.end(JSON.stringify({ error: 'temporarily_unavailable' }));
          } else {
            response.end(JSON.stringify({ total: body.readings.length, stream: { topic: 'synthetic-stream' } }));
          }
          return;
        }
        if (request.method === 'PATCH' && request.url.endsWith('/records/sensor-a')) {
          state.patches.push(body);
          response.end(JSON.stringify({ data: body.data, version: 2 }));
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'not_found' }));
      }).catch((error) => {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: error.message }));
      });
    });
    upstream.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
      upstream.once('listening', resolve);
      upstream.once('error', reject);
    });
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`;

    async function startBridge({ shutdownTimeout = 5000, retryBase = 50, retryMax = 100 } = {}) {
      bridgeOutput = '';
      bridge = spawn(process.execPath, [path.join(root, 'apps/iot-bridge/index.js')], {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'test',
          ALLOW_LOCAL_DEPENDENCIES: 'true',
          MQTT_URL: bridgeMqttUrl,
          MQTT_USERNAME: 'iot-bridge',
          MQTT_PASSWORD: credentials['iot-bridge'],
          MQTT_CLIENT_ID: bridgeClientId,
          MQTT_SESSION_EXPIRY_SECONDS: '60',
          SYNAPSEDX_BASE_URL: upstreamUrl,
          SYNAPSEDX_API_KEY: 'synthetic-test-key',
          UPDATE_SENSORS: 'true',
          BRIDGE_BATCH_MS: '20',
          BRIDGE_BATCH_MAX: '50',
          BRIDGE_QUEUE_MAX: '100',
          BRIDGE_RETRY_BASE_MS: String(retryBase),
          BRIDGE_RETRY_MAX_MS: String(retryMax),
          BRIDGE_SHUTDOWN_TIMEOUT_MS: String(shutdownTimeout),
          BRIDGE_FETCH_TIMEOUT_MS: '1000',
          IOT_SENSOR_CACHE_MS: '500',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      bridge.stdout.on('data', (chunk) => { bridgeOutput += chunk.toString(); });
      bridge.stderr.on('data', (chunk) => { bridgeOutput += chunk.toString(); });
      bridgeExit = new Promise((resolve, reject) => {
        bridge.once('error', reject);
        bridge.once('exit', (code, signal) => resolve({ code, signal }));
      });
      await waitFor(() => bridgeOutput.includes('subscribed city/sensors/+/data qos=1'),
        `bridge did not subscribe at QoS 1: ${bridgeOutput}`);
    }

    await startBridge();

    const unknown = await connectPublisher(mqttUrl, 'sensor-unknown', credentials['sensor-unknown']);
    publishers.push(unknown);
    await publish(unknown, 'city/sensors/sensor-unknown/data', { value: 5 });
    await publish(sensorA, 'city/sensors/sensor-a/data', {
      value: 42,
      timestamp: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    await publish(sensorA, 'city/sensors/sensor-a/data', {
      value: 101,
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => bridgeOutput.includes('sensor_not_registered')
      && bridgeOutput.includes('timestamp_in_future')
      && bridgeOutput.includes('value_out_of_range'),
    `bridge did not reject invalid readings: ${bridgeOutput}`);
    assert.equal(state.ingestAttempts, 0, 'invalid readings must not reach telemetry ingest');
    assert.equal(state.patches.length, 0, 'invalid readings must not mutate the sensor registry');

    await publish(sensorA, 'city/sensors/sensor-a/data', { value: 44 }, 0);
    await waitFor(() => bridgeOutput.includes('qos_0_not_accepted'),
      `bridge did not reject QoS 0 ingress: ${bridgeOutput}`);
    assert.equal(state.ingestAttempts, 0, 'QoS 0 readings must not be forwarded');

    state.ingestAttempts = 0;
    state.ingestBodies.length = 0;
    state.patches.length = 0;
    state.failIngest = true;
    const accepted = { value: 42, timestamp: new Date().toISOString() };
    await publish(sensorA, 'city/sensors/sensor-a/data', accepted);
    await waitFor(() => state.ingestAttempts >= 1, 'bridge did not attempt telemetry ingest');
    assert.equal(bridge.exitCode, null, 'bridge exited before graceful shutdown was requested');

    bridge.kill('SIGTERM');
    await delay(150);
    assert.equal(bridge.exitCode, null, 'bridge must keep retrying during graceful shutdown');
    state.failIngest = false;
    const exit = await withTimeout(bridgeExit, 'bridge did not finish graceful shutdown');
    assert.deepEqual(exit, { code: 0, signal: null }, bridgeOutput);
    assert.ok(state.ingestAttempts >= 2, 'transient upstream failure must be retried');
    const forwarded = state.ingestBodies.at(-1)?.readings || [];
    assert.equal(forwarded.length, 1, 'the acknowledged reading must survive failure and shutdown');
    assert.equal(forwarded[0].sensor_id, 'sensor-a');
    assert.equal(forwarded[0].value, 42);
    assert.equal(state.patches.length, 1, 'approved reading should update the registry once');
    assert.equal(state.patches[0].data.status, 'online');

    // If the graceful deadline expires, the reading must remain unacknowledged
    // at the broker and be redelivered to the same persistent session.
    state.failIngest = true;
    state.ingestAttempts = 0;
    state.ingestBodies.length = 0;
    state.patches.length = 0;
    await startBridge({ shutdownTimeout: 1000, retryBase: 200, retryMax: 200 });
    await publish(sensorA, 'city/sensors/sensor-a/data', {
      value: 43,
      timestamp: new Date().toISOString(),
    });
    await waitFor(() => state.ingestAttempts >= 1, 'restart test bridge did not attempt ingest');
    bridge.kill('SIGTERM');
    const deadlineExit = await withTimeout(bridgeExit, 'bridge did not honor shutdown deadline');
    assert.deepEqual(deadlineExit, { code: 1, signal: null }, bridgeOutput);
    assert.match(bridgeOutput, /shutdown deadline reached with 1 unacknowledged reading/);

    state.failIngest = false;
    state.ingestAttempts = 0;
    state.ingestBodies.length = 0;
    state.patches.length = 0;
    await startBridge();
    await waitFor(() => state.ingestBodies.length === 1,
      `broker did not redeliver the unacknowledged reading: ${bridgeOutput}`);
    const redelivered = state.ingestBodies[0].readings || [];
    assert.equal(redelivered.length, 1, 'restart must redeliver exactly the pending reading');
    assert.equal(redelivered[0].value, 43);
    bridge.kill('SIGTERM');
    const restartedExit = await withTimeout(bridgeExit, 'restarted bridge did not shut down cleanly');
    assert.deepEqual(restartedExit, { code: 0, signal: null }, bridgeOutput);
  } finally {
    for (const publisher of publishers) {
      if (!publisher.disconnected) await endClient(publisher).catch(() => {});
    }
    if (bridge && bridge.exitCode === null && bridge.signalCode === null) {
      bridge.kill('SIGKILL');
      if (bridgeExit) await bridgeExit.catch(() => {});
    }
    if (upstream?.listening) await new Promise((resolve) => upstream.close(resolve));
    if (broker && broker.exitCode === null && broker.signalCode === null) {
      broker.kill('SIGTERM');
      await new Promise((resolve) => broker.once('exit', resolve));
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
