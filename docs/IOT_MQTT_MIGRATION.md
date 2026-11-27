# IoT MQTT authentication and reliability rollout

This note covers the H1/M15 bridge hardening. It is a **breaking security
change** for existing devices: anonymous MQTT and host-published plaintext port
1883 are removed. No credential or private key is included in this repository.

## What changes

- Mosquitto rejects anonymous connections on every listener.
- Devices connect with TLS on port **8883** and a unique username/password.
- The device username must exactly equal its sensor id. The shipped ACL permits
  only `write city/sensors/<username>/data`, so one device cannot publish to a
  different sensor's topic.
- The `iot-bridge` service account can read `city/sensors/+/data` but has no
  wildcard publish permission. The virtual mock uses the sensor's device
  account and publishes at QoS 1.
- Compose publishes TLS port 8883 on `127.0.0.1` by default. Port 1883 remains
  internal to the Compose network and is never host-published.
- The bridge requires a registered, non-disabled sensor before ingest. It checks
  timestamp age/future skew and the sensor's value range. Invalid, unknown,
  inactive, or decommissioned sensors are not forwarded and do not mutate the
  sensor registry.
- MQTT ingress and subscription use QoS 1. The bridge uses MQTT 5 persistent
  sessions and delays PUBACK until Tier-2 telemetry ingest returns success.
- A bounded in-memory transport queue retains readings across transient Tier-2
  failures. Retry delay grows exponentially and is capped. SIGTERM/SIGINT drain
  the queue; if the shutdown deadline expires, readings remain unacknowledged
  so the broker can redeliver them after restart.

## Operator prerequisites

1. Inventory every sensor and confirm its `city-iot-sensors` record id and
   active status. Configure an explicit physical validity range, for example:

   ```json
   {
     "reading_range": { "min": 0, "max": 220 },
     "thresholds": { "warning_max": 150, "critical_max": 190 }
   }
   ```

   `reading_range` (or legacy `valid_range`) is preferred. Direct `min_value` /
   `max_value` and legacy `thresholds.min_value` / `thresholds.max_value` are
   also honored. Without an explicit range, the bridge uses `IOT_VALUE_MIN` and
   `IOT_VALUE_MAX` (default `-1000000` to `1000000`). Alert thresholds should be
   chosen carefully if used as validity bounds: values outside them are
   rejected rather than recorded as alert-worthy extremes.

2. Issue a TLS server certificate for the broker hostname/IP, signed by an
   operator-controlled CA. Install only the CA public certificate on devices;
   keep the server private key in protected storage. The certificate must cover
   the exact DNS name or IP devices use.

3. Create a Mosquitto password file outside git. Use interactive
   `mosquitto_passwd /secure/synapsecity/password_file <username>` so the
   password is not placed in shell history. Create one entry per sensor using
   the sensor id as the username, plus the `iot-bridge` service account and the
   mock sensor's account. Do not reuse one credential across sensors.

4. Keep the shipped `infra/mosquitto/aclfile`. If the bridge username is changed
   from `iot-bridge`, update both its explicit read-only ACL entry and the
   reserved `pattern deny` line before rollout. Device entries need no
   per-sensor ACL lines because the `%u` pattern binds the topic to the
   authenticated username. The username `iot-bridge` is reserved and must not
   be used as a sensor id.

5. Provide the password, ACL, CA, certificate, and private-key file paths in the
   deployment environment. Defaults under `infra/mosquitto/` are ignored by git
   except for the non-secret ACL template. Prefer a protected directory outside
   the repository. Set `IOT_BRIDGE_MQTT_PASSWORD` and
   `IOT_MOCK_MQTT_PASSWORD` out of band; the mock username defaults to
   `MOCK_SENSOR_ID`.

6. Use durable storage for the `mqtt-data` volume and back it up. Broker
   persistence retains QoS 1 sessions and queued messages across bridge
   restarts. File permissions must allow the Mosquitto container to read the
   Compose secrets; never make the private key world-writable.

## Cutover

1. Provision and test the new certificate, password file, and ACL without
   printing or copying secrets into tickets or logs.
2. Update firmware to a TLS-capable MQTT client, trust the CA, connect to 8883,
   and supply that sensor's credentials. The existing public firmware generator
   still renders a legacy plaintext `PubSubClient` sketch; its output must be
   adapted before it can use the hardened broker.
3. Update the mock/bridge environment and start the authenticated broker and
   bridge during a maintenance window. There is intentionally no anonymous
   compatibility listener.
4. Set `MQTT_HOST_PORT` to loopback or a specific private interface. If remote
   field devices need access, restrict 8883 at the firewall to their source
   network and keep TLS verification enabled. Do not expose plaintext 1883.
5. Verify all three cases before reopening telemetry:
   - anonymous connect fails;
   - sensor A publishing to sensor B's topic fails;
   - sensor A publishing its own topic at QoS 1 is accepted and appears in
     Tier-2 after the bridge acknowledges it.
6. Revoke the old port 1883 route/firewall rule and rotate any credential that
   was ever used on the anonymous broker.

## Reliability and rollback

- QoS 1 is **at least once**. A crash after Tier-2 commit but before PUBACK can
  cause a duplicate reading; this is preferable to losing telemetry.
- The bridge queue is bounded and is not a local durable database. A hard process
  crash before PUBACK is recovered through the broker's persistent session. A
  broker/host crash before Mosquitto persists its state can still lose recent
  messages; durable storage and backups remain operational requirements. The
  broker queue is also bounded (10,000 messages or 64 MiB per client), so size
  it for the longest expected Tier-2 outage and alert on queue/drop metrics.
- If Tier-2 is unavailable at the shutdown deadline, the bridge exits nonzero
  without acknowledging queued readings. Keep the persistent session and volume
  so they are redelivered on restart.
- Roll back the bridge application only if necessary, but **do not restore
  anonymous access, broad topic ACLs, or plaintext host exposure**. Keep the
  authenticated/TLS broker configuration during an application rollback.

## Local verification

With Node dependencies and Mosquitto tools installed:

```bash
node --test scripts/iot-config.test.mjs
npm test --prefix apps/iot-bridge
npm run build --prefix apps/iot-bridge
npm run build --prefix apps/iot-mock
npm run lint --prefix apps/iot-bridge
npm run lint --prefix apps/iot-mock
docker compose config --quiet
```

The integration suite starts a local Mosquitto process with synthetic test
credentials. It does not contact production or use production secrets.
