// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relative) => readFileSync(path.join(root, relative), 'utf8');

test('Compose defaults MQTT host exposure to loopback TLS only', () => {
  const compose = read('docker-compose.yml');
  assert.ok(compose.includes('"${MQTT_HOST_PORT:-127.0.0.1:8883}:8883"'));
  assert.doesNotMatch(compose, /0\.0\.0\.0:1883/);
  assert.doesNotMatch(compose, /\$\{MQTT_HOST_PORT:-[^}]*\}:1883/);
  assert.match(compose, /MQTT_USERNAME: \$\{IOT_BRIDGE_MQTT_USERNAME:-iot-bridge\}/);
  assert.match(compose, /MQTT_PASSWORD: \$\{IOT_BRIDGE_MQTT_PASSWORD:-\}/);
  assert.match(compose, /MQTT_USERNAME: \$\{MOCK_SENSOR_ID:-cong-nc-001-wl\}/);
  assert.match(compose, /MQTT_PASSWORD: \$\{IOT_MOCK_MQTT_PASSWORD:-\}/);
});

test('Mosquitto fails closed on both listeners and requires TLS for devices', () => {
  const config = read('infra/mosquitto/mosquitto.conf');
  assert.equal((config.match(/allow_anonymous false/g) || []).length, 2);
  assert.doesNotMatch(config, /allow_anonymous true/);
  assert.equal((config.match(/password_file \/run\/secrets\/mqtt_password_file/g) || []).length, 2);
  assert.equal((config.match(/acl_file \/run\/secrets\/mqtt_acl_file/g) || []).length, 2);
  assert.equal((config.match(/max_qos 1/g) || []).length, 2);
  assert.equal((config.match(/use_username_as_clientid true/g) || []).length, 2);
  assert.match(config, /listener 1883\nprotocol mqtt\nallow_anonymous false/);
  assert.match(config, /listener 8883\nprotocol mqtt\nallow_anonymous false/);
  assert.match(config, /cafile \/run\/secrets\/mqtt_tls_ca_file/);
  assert.match(config, /certfile \/run\/secrets\/mqtt_tls_cert_file/);
  assert.match(config, /keyfile \/run\/secrets\/mqtt_tls_key_file/);
  assert.match(config, /tls_version tlsv1\.2/);
  assert.match(config, /persistence true/);
  assert.match(config, /max_queued_messages 10000/);
  assert.match(config, /max_queued_bytes 67108864/);
});

test('ACL binds device publish topics to authenticated usernames', () => {
  const acl = read('infra/mosquitto/aclfile');
  assert.match(acl, /^pattern write city\/sensors\/%u\/data$/m);
  assert.match(acl, /^pattern deny city\/sensors\/iot-bridge\/data$/m);
  assert.match(acl, /^user iot-bridge\ntopic read city\/sensors\/\+\/data$/m);
  assert.doesNotMatch(acl, /topic (write|readwrite) city\/sensors\/\+/);
});

test('example configuration contains no anonymous or plaintext host default', () => {
  const example = read('.env.example');
  assert.match(example, /^MQTT_HOST_PORT=127\.0\.0\.1:8883$/m);
  assert.doesNotMatch(example, /0\.0\.0\.0:1883/);
  assert.match(example, /^IOT_BRIDGE_MQTT_PASSWORD=$/m);
  assert.match(example, /^IOT_MOCK_MQTT_PASSWORD=$/m);
  assert.match(example, /^IOT_TIMESTAMP_MAX_FUTURE_MS=300000$/m);
});
