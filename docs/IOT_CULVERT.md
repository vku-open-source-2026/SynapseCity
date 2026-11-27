# Cá»‘ng nÆ°á»›c thÃ´ng minh â€” ESP32 â†’ MQTT â†’ Tier-2 â†’ workspace

Production demo of a monitored storm-water culvert (cá»‘ng thoÃ¡t nÆ°á»›c) in
Da Nang. The ESP32 publishes water level over MQTT; the Tier-3 `iot-bridge`
validates and forwards the reading to the Tier-2 telemetry capability. The
workspace and the public IoT Lab read the same records.

## Production resources

| Item | Value |
| --- | --- |
| Asset | `cong-nc-001` â€” Cá»‘ng thoÃ¡t nÆ°á»›c Nguyá»…n LÆ°Æ¡ng Báº±ng, ÄÃ  Náºµng |
| Sensor | `cong-nc-001-wl` â€” `water_level`, unit `cm`, depth 220 cm |
| MQTT topic | `city/sensors/cong-nc-001-wl/data` |
| MQTT broker | `synapsecity.sbs:8883` (TLS, per-device credentials) |
| Public lab | https://synapsecity.sbs/iot |
| Workspace | https://synapsedx.sbs/workspace?product=city&page=city-iot-network |
| Asset page | https://synapsecity.sbs/asset/cong-nc-001 |

Thresholds: warning `â‰¥ 150 cm`, critical `â‰¥ 190 cm` (sensor `thresholds`,
culvert depth 220 cm).

## Data path

```text
JSN-SR04T / MOCK_MODE
   â”‚  pulse / generated cm
ESP32 (WiFi KMGMSAFEHORIFPT)
   â”‚  MQTT publish JSON {value,timestamp?,metadata?}
mosquitto  (compose service "mqtt", TLS 8883; host loopback by default)
   â”‚  topic city/sensors/+/data (QoS 1)
iot-bridge (apps/iot-bridge)
   â”‚  batch â‰¤100, 1 s; bounded retry/backoff; PATCH approved sensors only
Tier-2 POST /v1/capabilities/telemetry/ingest
   â”‚  datasetId=city-iot-readings  source=mqtt
SynapseOne Base (records) + Stream (topic â€¦-telemetry)
   â”‚
   â”œâ”€ DX workspace plugin "City IoT network" (code widget + tables)
   â””â”€ City public projection GET /v1/public/iot/{sensors,readings}
```

The bridge keeps the sensor registry current through a read-merge-CAS PATCH of
`city-iot-sensors`. It first requires a registered, active sensor and a value in
that sensor's configured range; unknown or disabled sensors are rejected before
forwarding or registry mutation.

## Firmware generation

The generator is a pure renderer: it never reads a dataset, a session or a
service key. WiFi/MQTT values are supplied by the caller and only echoed into
the sketch.

```
GET  /v1/public/iot/catalog
POST /v1/public/iot/firmware
```

Example:

```bash
curl -s https://synapsecity.sbs/v1/public/iot/firmware \
  -H 'content-type: application/json' \
  -d '{
    "sensor_id":"cong-nc-001-wl",
    "sensor_code":"CONG-NC-001-WL",
    "asset_id":"cong-nc-001",
    "sensor":"water_level_jsn",
    "mcu":"esp32",
    "wifi_ssid":"KMGMSAFEHORIFPT",
    "wifi_pass":"â€¦",
    "mqtt_host":"synapsecity.sbs",
    "mqtt_port":1883,
    "interval_seconds":30,
    "culvert_depth_cm":220,
    "mock_fallback":true
  }'
```

The sketch uses `PubSubClient`, NTP timestamps, WiFi/MQTT reconnect, a
waterproof JSN-SR04T read (`TRIG=D12`, `ECHO=D13`) and `#define MOCK_MODE 1`
when `mock_fallback` is true. With mock mode the sketch generates a plausible
water level even when no probe is connected.

The generator still renders the legacy plaintext `PubSubClient` sketch. Before
connecting to the hardened broker, adapt it to a TLS-capable MQTT client, trust
the operator CA, set port `8883`, and provision the sensor's unique username and
password. The broker rejects anonymous and cross-sensor publishes; credentials
must never be committed or shared in the sketch repository.

The legacy per-sensor route `POST /v1/iot/sensors/:id/firmware` remains for
session-scoped operators; it now renders the same MQTT template.

## Mock mode

Two independent mock paths:

1. **Device mock** â€” `#define MOCK_MODE 1` in the generated sketch. It sends
   real MQTT publishes from the board, so the full WiFi/broker path is tested.
2. **Virtual ESP32** â€” compose service `iot-mock` (`apps/iot-mock`). It
   publishes a drainage/tide curve every 15 s and occasional storm surges that
   cross the 150/190 cm thresholds. This keeps the public lab and workspace
   alive without hardware.

```bash
docker compose -p synapsecity stop iot-mock     # stop the virtual board
docker compose -p synapsecity start iot-mock    # resume
docker logs -f synapsecity-iot-mock-1
```

## Flash the ESP32

> âš ï¸ **Náº¿u chip nÃ³ng báº¥t thÆ°á»ng, bá»ng tay hoáº·c cÃ³ mÃ¹i khÃ©t: rÃºt USB ngay.
> KhÃ´ng cháº¡m tay vÃ o chip, khÃ´ng cáº¯m láº¡i.** Kiá»ƒm tra 5V/GND vÃ  Ä‘Æ°á»ng ECHO
> trÆ°á»›c khi cáº¥p nguá»“n láº¡i. NÃ³ng kiá»ƒu bá»ng tay khÃ´ng pháº£i tráº¡ng thÃ¡i bÃ¬nh thÆ°á»ng.

Drivers: CP210x (Silicon Labs) or CH340, depending on the DevKit. The CP210x
package is kept outside the repository in
`%USERPROFILE%\Tools\drivers\CP210x` (signed by Silicon Laboratories).

```powershell
arduino-cli core install esp32:esp32
arduino-cli lib install PubSubClient
arduino-cli compile --fqbn esp32:esp32:esp32 .\CONG_NC_001_WL_esp32_water_level_jsn
arduino-cli board list
arduino-cli upload -p COMx --fqbn esp32:esp32:esp32 .\CONG_NC_001_WL_esp32_water_level_jsn
```

Serial monitor at 115200 baud prints WiFi/MQTT state and each publish. The
board needs 2.4 GHz WiFi; 5 GHz-only SSIDs will not associate.

**This board's CP2102 only wires EN/RTS, not GPIO0/DTR**, so auto-reset does
not enter download mode (`boot:0x13`). Hold **BOOT**, tap **RST/EN** once, then
release **BOOT**; `scripts/flash-when-bootloader.ps1` waits for that state and
writes the four images with esptool (`--before no-reset --after hard-reset`).

Wiring (JSN-SR04T, 4-pin module): VCC 5V, GND, TRIG â†’ GPIO18, ECHO â†’ **1kÎ© ná»‘i
tiáº¿p** â†’ GPIO19, **2kÎ© xuá»‘ng GND**. ÄÃ¢y lÃ  cáº§u phÃ¢n Ã¡p báº¯t buá»™c: ECHO cá»§a
JSN-SR04T lÃ  5V, GPIO ESP32 chá»‰ chá»‹u 3.3V â€” ná»‘i trá»±c tiáº¿p cÃ³ thá»ƒ lÃ m cháº¿t chip.
Vá»›i ESP32-S3/C3 dÃ¹ng TRIG=4, ECHO=5. Mount the probe on the culvert cover
pointing down; set `CULVERT_DEPTH_CM` to the distance from the probe face to the
dry culvert floor.

## Configuration

`.env` (SynapseCity):

```text
PUBLIC_IOT_SENSORS=cong-nc-001-wl
MOCK_SENSOR_ID=cong-nc-001-wl
MOCK_SENSOR_CODE=CONG-NC-001-WL
MOCK_INTERVAL_MS=15000
MOCK_MODE=culvert
MOCK_DEPTH_CM=220
IOT_BRIDGE_UPDATE_SENSORS=true
MQTT_HOST_PORT=127.0.0.1:8883
MQTT_PASSWORD_FILE=/secure/synapsecity/mosquitto/password_file
MQTT_ACL_FILE=./infra/mosquitto/aclfile
MQTT_TLS_CA_FILE=/secure/synapsecity/mosquitto/ca.crt
MQTT_TLS_CERT_FILE=/secure/synapsecity/mosquitto/server.crt
MQTT_TLS_KEY_FILE=/secure/synapsecity/mosquitto/server.key
IOT_BRIDGE_MQTT_USERNAME=iot-bridge
IOT_BRIDGE_MQTT_PASSWORD=<set-out-of-band>
IOT_MOCK_MQTT_PASSWORD=<set-out-of-band>
```

`PUBLIC_IOT_SENSORS` is an explicit allowlist; empty means the public live
endpoints return no data. Only fields in `public_iot_sensor_view` are exposed.
See [`IOT_MQTT_MIGRATION.md`](IOT_MQTT_MIGRATION.md) for credential, certificate,
ACL, cutover, and rollback requirements.

## Security notes

- MQTT authentication is mandatory. External devices use TLS on port 8883;
  plaintext 1883 is available only inside the Compose network. The default host
  binding is `127.0.0.1:8883`.
- Device usernames must equal their sensor id. The Mosquitto ACL permits each
  device to write only `city/sensors/<its-id>/data`; the bridge account has
  read-only access to the telemetry wildcard.
- The bridge accepts QoS 1 only, validates registry membership, sensor status,
  timestamp skew, and configured value ranges, and delays MQTT PUBACK until
  Tier-2 ingest succeeds. Retries are bounded by a capped backoff and queue
  size; graceful shutdown drains or leaves readings unacknowledged for broker
  redelivery.
- The generated `.ino` contains the WiFi password. Do not commit it or share it
  publicly. MQTT credentials and TLS private keys must also stay out of git.
- The public firmware endpoint is stateless and rate-limited by the City
  public-read limiter. It cannot read datasets.
- The public telemetry endpoint only serves record ids in
  `PUBLIC_IOT_SENSORS`.

## Verification

```bash
curl -s https://synapsecity.sbs/v1/public/iot/catalog | jq '.sensors | length'
curl -s https://synapsecity.sbs/v1/public/iot/sensors | jq .
curl -s 'https://synapsecity.sbs/v1/public/iot/readings?sensor_id=cong-nc-001-wl&limit=3' | jq .
docker logs --tail 10 synapsecity-iot-bridge-1
docker logs --tail 10 synapsecity-iot-mock-1
```

The workspace code widget (`plugins/widgets/city-iot-culvert-live.js`) uses the
declared `iot-table` and `readings-table` inputs, queries the latest 100
readings with `sortBy=timestamp&sortDirection=desc`, and refreshes every 15 s.
