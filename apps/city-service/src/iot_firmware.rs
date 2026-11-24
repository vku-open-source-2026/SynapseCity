// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
//! IoT catalog, ESP32 firmware generator and mock-data helper.
//!
//! Tier-3 owns domain meaning: which sensor fits which asset (e.g. drain ->
//! waterproof water-level). Tier-2/Tier-1 stay generic: they only see
//! dataset records and stream events.

use serde_json::{json, Map, Value};

pub struct Mcu {
    pub id: &'static str,
    pub label: &'static str,
    pub board: &'static str,
    pub notes: &'static str,
}

pub const MCUS: &[Mcu] = &[
    Mcu { id: "esp32", label: "ESP32 DevKit V1 (khuyên dùng)", board: "esp32:esp32:esp32", notes: "WiFi+BT, ADC 12-bit, HTTPS ổn định, đủ GPIO cho hầu hết cảm biến." },
    Mcu { id: "esp32-s3", label: "ESP32-S3", board: "esp32:esp32:esp32s3", notes: "USB-OTG native, nhiều GPIO, phù hợp gateway nhỏ." },
    Mcu { id: "esp32-c3", label: "ESP32-C3 (giá rẻ)", board: "esp32:esp32:esp32c3", notes: "RISC-V, WiFi 2.4GHz, ít GPIO — chỉ 1-2 cảm biến." },
    Mcu { id: "esp8266", label: "ESP8266 NodeMCU", board: "esp8266:esp8266:nodemcuv2", notes: "Rẻ nhất, 1 ADC, HTTPS nặng — chỉ dùng HTTP/thử nghiệm." },
];

pub struct SensorSpec {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: &'static str,
    pub unit: &'static str,
    pub min: f64,
    pub max: f64,
    pub interface: &'static str,
    pub library: &'static str,
    pub description: &'static str,
}

pub const SENSORS: &[SensorSpec] = &[
    SensorSpec { id: "water_level_jsn", label: "Mực nước siêu âm chống nước JSN-SR04T", kind: "water_level", unit: "cm", min: 20.0, max: 600.0, interface: "GPIO pulse (TRIG/ECHO)", library: "none (pulseIn)", description: "Đo khoảng cách mặt nước trong cống/hố ga. Lắp trên nắp, đầu dò hướng xuống." },
    SensorSpec { id: "water_level_float", label: "Phao mực nước (công tắc)", kind: "water_level", unit: "binary", min: 0.0, max: 1.0, interface: "GPIO digital", library: "none", description: "Báo tràn/ngập ON/OFF, rẻ, bền." },
    SensorSpec { id: "dht22", label: "DHT22 nhiệt độ + độ ẩm", kind: "temperature", unit: "°C / %RH", min: -40.0, max: 80.0, interface: "GPIO digital", library: "DHT sensor library", description: "Giám sát môi trường chung." },
    SensorSpec { id: "ds18b20", label: "DS18B20 nhiệt độ chống nước", kind: "temperature", unit: "°C", min: -55.0, max: 125.0, interface: "OneWire", library: "OneWire + DallasTemperature", description: "Nhúng trong nước/bùn." },
    SensorSpec { id: "turbidity", label: "Độ đục TSW-20M", kind: "turbidity", unit: "NTU", min: 0.0, max: 1000.0, interface: "ADC analog", library: "none", description: "Chất lượng nước thải/cống; hiệu chuẩn theo nước sạch." },
    SensorSpec { id: "ph4502c", label: "pH PH-4502C", kind: "ph", unit: "pH", min: 0.0, max: 14.0, interface: "ADC analog", library: "none (calib 2 điểm)", description: "pH nước thải, cần hiệu chuẩn." },
    SensorSpec { id: "rain", label: "Cảm biến mưa + đếm xung", kind: "rainfall", unit: "mm", min: 0.0, max: 500.0, interface: "GPIO interrupt", library: "none", description: "Kết hợp mực nước để cảnh báo ngập; 0.2794 mm mỗi lần lật." },
    SensorSpec { id: "pressure", label: "Áp suất 4-20mA / 0-1MPa", kind: "pressure", unit: "kPa", min: 0.0, max: 1000.0, interface: "ADC + chuyển dòng-áp", library: "none", description: "Trạm bơm, đường ống. Dùng shunt 165Ω." },
    SensorSpec { id: "flow_yfs201", label: "Lưu lượng YF-S201", kind: "flow", unit: "L/min", min: 1.0, max: 30.0, interface: "GPIO interrupt", library: "none", description: "Đếm xung Hall (7.5 xung/lít)." },
    SensorSpec { id: "vibration", label: "Rung SW-420", kind: "vibration", unit: "binary", min: 0.0, max: 1.0, interface: "GPIO digital", library: "none", description: "Cầu, máy bơm, trạm." },
    SensorSpec { id: "mq135", label: "Chất lượng không khí MQ-135", kind: "air_quality", unit: "ppm", min: 10.0, max: 1000.0, interface: "ADC analog", library: "none", description: "Cần warm-up 24h." },
    SensorSpec { id: "soil", label: "Độ ẩm đất capacitive", kind: "soil_moisture", unit: "%", min: 0.0, max: 100.0, interface: "ADC analog", library: "none", description: "Công viên, cây xanh." },
];

/// Gợi ý cảm biến theo loại hạ tầng (Tier-3 domain knowledge).
pub fn suggest_for_asset(asset_type: &str, sensor_type: &str) -> Vec<&'static SensorSpec> {
    let t = format!("{} {}", asset_type.to_ascii_lowercase(), sensor_type.to_ascii_lowercase());
    let pick = |ids: &[&str]| -> Vec<&'static SensorSpec> {
        ids.iter().filter_map(|id| SENSORS.iter().find(|s| s.id == *id)).collect()
    };
    if t.contains("drain") || t.contains("culvert") || t.contains("sewer") || t.contains("canal") || t.contains("cong") || t.contains("cống") || t.contains("ngap") || t.contains("ngập") {
        return pick(&["water_level_jsn", "rain", "turbidity", "water_level_float"]);
    }
    if t.contains("pump") || t.contains("bom") || t.contains("bơm") {
        return pick(&["pressure", "flow_yfs201", "water_level_jsn", "vibration"]);
    }
    if t.contains("reservoir") || t.contains("tank") || t.contains("be") || t.contains("bể") {
        return pick(&["water_level_jsn", "ph4502c", "turbidity"]);
    }
    if t.contains("bridge") || t.contains("cau") || t.contains("cầu") {
        return pick(&["vibration", "water_level_jsn", "rain"]);
    }
    if t.contains("park") || t.contains("green") || t.contains("cay") || t.contains("cây") {
        return pick(&["soil", "dht22", "rain"]);
    }
    if t.contains("light") || t.contains("den") || t.contains("đèn") {
        return pick(&["dht22", "water_level_float"]);
    }
    if t.contains("road") || t.contains("duong") || t.contains("đường") {
        return pick(&["rain", "vibration", "water_level_jsn"]);
    }
    if t.contains("air") || t.contains("building") || t.contains("toa") || t.contains("tòa") {
        return pick(&["mq135", "dht22"]);
    }
    pick(&["water_level_jsn", "dht22", "rain"])
}

pub fn catalog_json() -> Value {
    json!({
        "mcus": MCUS.iter().map(|m| json!({"id": m.id, "label": m.label, "board": m.board, "notes": m.notes})).collect::<Vec<_>>(),
        "sensors": SENSORS.iter().map(|s| json!({
            "id": s.id, "label": s.label, "kind": s.kind, "unit": s.unit,
            "range": {"min": s.min, "max": s.max},
            "interface": s.interface, "library": s.library, "description": s.description,
        })).collect::<Vec<_>>(),
        "suggestions": {
            "drain|culvert|sewer|canal|cong": ["water_level_jsn", "rain", "turbidity", "water_level_float"],
            "pump_station": ["pressure", "flow_yfs201", "water_level_jsn", "vibration"],
            "reservoir|tank": ["water_level_jsn", "ph4502c", "turbidity"],
            "bridge": ["vibration", "water_level_jsn", "rain"],
            "park|green": ["soil", "dht22", "rain"],
            "default": ["water_level_jsn", "dht22", "rain"],
        },
        "ingest": {
            "mqtt": "mqtt://synapsecity.sbs:1883 topic city/sensors/{sensor_id}/data {value,timestamp?,metadata?}",
            "mqtt_bridge": "topic city/sensors/{sensor_id}/data -> iot-bridge -> Tier-2 telemetry ingest -> Tier-1 Stream",
            "http": "POST /v1/iot/sensors/{id}/data {value, timestamp?, metadata?} + X-API-Key (session-scoped)",
            "batch": "POST /v1/iot/sensors/batch-ingest {readings:[{sensor_id, value, ...}]}",
            "telemetry_tier2": "POST /v1/capabilities/telemetry/ingest {datasetId, readings, source:'mqtt'}",
            "stream_read": "GET /v1/capabilities/telemetry/stream?topic=synapsedx-capability-events-telemetry",
        },
    })
}

pub fn sensor_kind(sensor_id: &str) -> &'static SensorSpec {
    SENSORS.iter().find(|s| s.id == sensor_id).unwrap_or(&SENSORS[0])
}

fn escape_cpp(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

fn safe_comment(s: &str) -> String {
    s.replace(['\n', '\r'], " ").replace("*/", "* /")
}

fn mock_defaults(spec: &SensorSpec, depth_cm: f64) -> (f64, f64, f64, f64) {
    match spec.id {
        "water_level_jsn" | "water_level_float" => ((depth_cm * 0.45).clamp(5.0, depth_cm), 0.8, 5.0, depth_cm),
        "dht22" | "ds18b20" => (28.0, 0.05, -5.0, 60.0),
        "turbidity" => (35.0, 0.25, 0.0, 1000.0),
        "ph4502c" => (7.2, 0.01, 0.0, 14.0),
        "pressure" => (180.0, 0.2, 0.0, 1000.0),
        "flow_yfs201" => (12.0, 0.1, 0.0, 30.0),
        "mq135" => (450.0, 1.5, 10.0, 1000.0),
        "soil" => (55.0, 0.1, 0.0, 100.0),
        "rain" => (0.0, 0.02, 0.0, 500.0),
        _ => (50.0, 0.5, spec.min, spec.max),
    }
}

fn pins_for_mcu(mcu: &str) -> (u8, u8) {
    match mcu {
        "esp32-s3" | "esp32-c3" => (4, 5),
        "esp8266" => (12, 13),
        _ => (18, 19),
    }
}

fn sensor_block(spec: &SensorSpec, mcu: &str) -> String {
    let (trig, echo) = pins_for_mcu(mcu);
    let block = match spec.id {
        "water_level_jsn" => r#"
#define TRIG_PIN @@TRIG@@
#define ECHO_PIN @@ECHO@@

// JSN-SR04T ECHO là 5V. BẮT BUỘC cầu phân áp trước GPIO:
//   ECHO --1kΩ-- GPIO_ECHO --2kΩ-- GND  (5V -> ~3.3V)
// Không nối ECHO trực tiếp vào ESP32; GPIO chỉ chịu 3.3V.

void sensorSetup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
  digitalWrite(TRIG_PIN, LOW);
}

// JSN-SR04T gắn trên nắp cống, đầu dò hướng xuống mặt nước.
// CULVERT_DEPTH_CM là khoảng cách từ đầu dò tới đáy cống khi cạn.
float readSensor() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (us <= 0) return NAN;
  float distanceCm = us / 58.0f;
  float level = CULVERT_DEPTH_CM - distanceCm;
  if (level < 0) level = 0;
  if (level > CULVERT_DEPTH_CM) level = CULVERT_DEPTH_CM;
  return level;
}
"#
        .to_string(),
        "water_level_float" => r#"
#define DIGITAL_PIN 13

void sensorSetup() {
  pinMode(DIGITAL_PIN, INPUT_PULLUP);
}

float readSensor() {
  return digitalRead(DIGITAL_PIN) == LOW ? 1.0f : 0.0f;
}
"#
        .to_string(),
        "dht22" => r#"
#include <DHT.h>
#define DHTPIN 15
#define DHTTYPE DHT22
DHT dht(DHTPIN, DHTTYPE);

void sensorSetup() { dht.begin(); }

float readSensor() {
  float t = dht.readTemperature();
  if (isnan(t)) return NAN;
  return t;
}
"#
        .to_string(),
        "ds18b20" => r#"
#include <OneWire.h>
#include <DallasTemperature.h>
#define ONEWIRE_PIN 4
OneWire oneWire(ONEWIRE_PIN);
DallasTemperature ds(&oneWire);

void sensorSetup() { ds.begin(); }

float readSensor() {
  ds.requestTemperatures();
  return ds.getTempCByIndex(0);
}
"#
        .to_string(),
        "flow_yfs201" => r#"
#define FLOW_PIN 14
volatile unsigned long pulseCount = 0;
void IRAM_ATTR onPulse() { pulseCount++; }

void sensorSetup() {
  pinMode(FLOW_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(FLOW_PIN), onPulse, FALLING);
}

float readSensor() {
  unsigned long c = pulseCount;
  pulseCount = 0;
  return (c * 60.0f / 7.5f); // L/min; 7.5 xung/lít
}
"#
        .to_string(),
        "rain" => r#"
#define RAIN_PIN 14
volatile unsigned long rainTips = 0;
void IRAM_ATTR onRainTip() { rainTips++; }

void sensorSetup() {
  pinMode(RAIN_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(RAIN_PIN), onRainTip, FALLING);
}

float readSensor() {
  unsigned long tips = rainTips;
  return tips * 0.2794f; // mm mỗi lần lật
}
"#
        .to_string(),
        "ph4502c" => r#"
#define ANALOG_PIN 34

void sensorSetup() { pinMode(ANALOG_PIN, INPUT); }

float readSensor() {
  int raw = analogRead(ANALOG_PIN);
  float voltage = raw * (3.3f / ADC_MAX);
  // Hiệu chuẩn 2 điểm: chỉnh 2.5V và 0.18V/pH theo dung dịch chuẩn.
  return 7.0f + ((2.5f - voltage) / 0.18f);
}
"#
        .to_string(),
        "turbidity" => r#"
#define ANALOG_PIN 34

void sensorSetup() { pinMode(ANALOG_PIN, INPUT); }

float readSensor() {
  int raw = analogRead(ANALOG_PIN);
  float voltage = raw * (3.3f / ADC_MAX);
  float ntu = ((4.5f - voltage) / 4.5f) * 1000.0f;
  if (ntu < 0) ntu = 0;
  if (ntu > 1000) ntu = 1000;
  return ntu;
}
"#
        .to_string(),
        "pressure" => r#"
#define ANALOG_PIN 34
#define SHUNT_OHMS 165.0f

void sensorSetup() { pinMode(ANALOG_PIN, INPUT); }

float readSensor() {
  int raw = analogRead(ANALOG_PIN);
  float voltage = raw * (3.3f / ADC_MAX);
  float currentMa = (voltage / SHUNT_OHMS) * 1000.0f;
  return (currentMa - 4.0f) * 62.5f; // 4-20mA -> 0-1000 kPa
}
"#
        .to_string(),
        "mq135" => r#"
#define ANALOG_PIN 34

void sensorSetup() { pinMode(ANALOG_PIN, INPUT); }

float readSensor() {
  int raw = analogRead(ANALOG_PIN);
  return 10.0f + (raw / ADC_MAX) * 990.0f;
}
"#
        .to_string(),
        "soil" => r#"
#define ANALOG_PIN 34

void sensorSetup() { pinMode(ANALOG_PIN, INPUT); }

float readSensor() {
  int raw = analogRead(ANALOG_PIN);
  return (1.0f - (raw / ADC_MAX)) * 100.0f;
}
"#
        .to_string(),
        "vibration" => r#"
#define DIGITAL_PIN 13

void sensorSetup() { pinMode(DIGITAL_PIN, INPUT_PULLUP); }

float readSensor() {
  return digitalRead(DIGITAL_PIN) == LOW ? 1.0f : 0.0f;
}
"#
        .to_string(),
        _ => r#"
#define TRIG_PIN @@TRIG@@
#define ECHO_PIN @@ECHO@@

// ECHO (JSN-SR04T) là 5V: dùng cầu phân áp 1kΩ nối tiếp + 2kΩ xuống GND.
void sensorSetup() {
  pinMode(TRIG_PIN, OUTPUT);
  pinMode(ECHO_PIN, INPUT);
}

float readSensor() {
  digitalWrite(TRIG_PIN, LOW);
  delayMicroseconds(2);
  digitalWrite(TRIG_PIN, HIGH);
  delayMicroseconds(10);
  digitalWrite(TRIG_PIN, LOW);
  long us = pulseIn(ECHO_PIN, HIGH, 30000UL);
  if (us <= 0) return NAN;
  float distanceCm = us / 58.0f;
  float level = CULVERT_DEPTH_CM - distanceCm;
  if (level < 0) level = 0;
  if (level > CULVERT_DEPTH_CM) level = CULVERT_DEPTH_CM;
  return level;
}
"#
        .to_string(),
    };
    block
        .replace("@@TRIG@@", &trig.to_string())
        .replace("@@ECHO@@", &echo.to_string())
}

/// Sinh code .ino nạp cho ESP32/ESP8266. WiFi/MQTT lấy từ body do người dùng
/// nhập; firmware chỉ publish lên topic MQTT công khai của broker City, không
/// nhúng service key của server.
#[allow(clippy::too_many_arguments)]
pub fn firmware_ino(
    sensor_id: &str,
    sensor_code: &str,
    sensor_row: &Map<String, Value>,
    mcu: &str,
    sensor: &str,
    wifi_ssid: &str,
    wifi_pass: &str,
    mqtt_host: &str,
    mqtt_port: u16,
    interval: u64,
    mock_fallback: bool,
    culvert_depth_cm: f64,
) -> (String, String) {
    let spec = sensor_kind(sensor);
    let depth = culvert_depth_cm.clamp(20.0, 1000.0);
    let filename = format!(
        "{}_{}_{}.ino",
        sensor_code.replace(|c: char| !c.is_alphanumeric(), "_"),
        mcu,
        spec.id
    );
    let board = MCUS.iter().find(|m| m.id == mcu).map(|m| m.board).unwrap_or("esp32:esp32:esp32");
    let asset = sensor_row.get("asset_id").and_then(Value::as_str).unwrap_or("");
    let (mock_base, mock_amp, mock_min, mock_max) = mock_defaults(spec, depth);
    let binary_mock = matches!(spec.id, "water_level_float" | "vibration");
    let mock_define = if mock_fallback { "#define MOCK_MODE 1" } else { "// #define MOCK_MODE 1" };
    let mock_block = if binary_mock {
        "  static bool state = false;\n  static unsigned long lastToggle = 0;\n  if (millis() - lastToggle > 45000UL) { state = !state; lastToggle = millis(); }\n  return state ? 1.0f : 0.0f;".to_string()
    } else {
        format!(
            "  static float mockValue = {mock_base:.2}f;\n  static unsigned long lastMock = 0;\n  unsigned long now = millis();\n  float dt = lastMock ? (now - lastMock) / 1000.0f : 1.0f;\n  lastMock = now;\n  mockValue += sin(now / 45000.0f) * {mock_amp:.3}f * dt + (random(-10, 11) / 100.0f) * dt;\n  if (mockValue < {mock_min:.2}f) mockValue = {mock_min:.2}f;\n  if (mockValue > {mock_max:.2}f) mockValue = {mock_max:.2}f;\n  return mockValue;"
        )
    };
    let sensor_block = sensor_block(spec, mcu);
    let template = r##"// Auto-generated by SynapseCity IoT firmware generator
// Sensor: @@SENSOR_CODE@@ (@@SENSOR_LABEL@@)
// Asset: @@ASSET@@
// Board: @@MCU@@ (@@BOARD@@)
// MQTT: @@MQTT_HOST@@:@@MQTT_PORT@@ topic @@MQTT_TOPIC@@
// Libraries: PubSubClient (Arduino Library Manager)
// - Mở Arduino IDE / arduino-cli, chọn board "@@BOARD@@".
// - Cài thư viện: PubSubClient. Thư viện cảm biến: @@LIB@@.
// - WiFi và broker đã điền sẵn; nạp firmware rồi mở Serial Monitor 115200.
// - Chưa có cảm biến thật: giữ #define MOCK_MODE 1 để bắn dữ liệu giả.
//
// Compile:
//   arduino-cli compile --fqbn @@BOARD@@ @@FILENAME@@
// Upload:
//   arduino-cli upload -p COMx --fqbn @@BOARD@@ @@FILENAME@@

#if defined(ESP8266)
#include <ESP8266WiFi.h>
#else
#include <WiFi.h>
#endif
#include <PubSubClient.h>
#include <time.h>

#define WIFI_SSID "@@WIFI_SSID@@"
#define WIFI_PASS "@@WIFI_PASS@@"
#define MQTT_HOST "@@MQTT_HOST@@"
#define MQTT_PORT @@MQTT_PORT@@
#define MQTT_TOPIC "@@MQTT_TOPIC@@"
#define SENSOR_ID "@@SENSOR_ID@@"
#define SENSOR_CODE "@@SENSOR_CODE@@"
#define INTERVAL_MS @@INTERVAL_MS@@
#define CULVERT_DEPTH_CM @@CULVERT_DEPTH@@
#define MEASUREMENT_UNIT "@@UNIT@@"
@@MOCK_DEFINE@@

#if defined(ESP8266)
#define ADC_MAX 1023.0f
#else
#define ADC_MAX 4095.0f
#endif

#ifdef MOCK_MODE
const char* MODE = "mock";
#else
const char* MODE = "sensor";
#endif

WiFiClient net;
PubSubClient mqtt(net);
@@SENSOR_BLOCK@@

String chipId() {
#if defined(ESP8266)
  return String(ESP.getChipId(), HEX);
#else
  uint64_t mac = ESP.getEfuseMac();
  char buf[17];
  snprintf(buf, sizeof(buf), "%04X%08X", (uint16_t)(mac >> 32), (uint32_t)mac);
  return String(buf);
#endif
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  Serial.printf("[wifi] connecting to %s", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 20000UL) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(WiFi.status() == WL_CONNECTED ? " ok" : " FAILED (will retry)");
}

void connectMqtt() {
  if (WiFi.status() != WL_CONNECTED || mqtt.connected()) return;
  String clientId = String("city-") + chipId();
  Serial.printf("[mqtt] connecting %s:%d as %s ...", MQTT_HOST, MQTT_PORT, clientId.c_str());
  if (mqtt.connect(clientId.c_str())) {
    Serial.println(" ok");
  } else {
    Serial.printf(" failed rc=%d\n", mqtt.state());
    delay(3000);
  }
}

String isoTimestamp() {
  time_t now = time(nullptr);
  if (now < 1700000000) return "";
  struct tm timeinfo;
  gmtime_r(&now, &timeinfo);
  char buf[25];
  strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &timeinfo);
  return String(buf);
}

float readValue() {
#ifdef MOCK_MODE
@@MOCK_BLOCK@@
#else
  return readSensor();
#endif
}

void publishValue(float value) {
  String payload = String("{\"value\":") + String(value, 2);
  String ts = isoTimestamp();
  if (ts.length()) payload += String(",\"timestamp\":\"") + ts + "\"";
  payload += String(",\"metadata\":{\"source\":\"esp32\",\"mode\":\"") + MODE +
             "\",\"sensor_code\":\"" SENSOR_CODE "\",\"rssi\":" + String(WiFi.RSSI()) +
             ",\"uptime_s\":" + String(millis() / 1000) + "}}";
  bool ok = mqtt.publish(MQTT_TOPIC, payload.c_str());
  Serial.printf("[iot] %s value=%.2f %s payload=%s\n", ok ? "publish" : "PUBLISH_FAILED", value, MEASUREMENT_UNIT, payload.c_str());
}

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println();
  Serial.println("[iot] SynapseCity firmware boot");
  Serial.printf("[iot] sensor=%s id=%s mode=%s\n", SENSOR_CODE, SENSOR_ID, MODE);
  sensorSetup();
  WiFi.mode(WIFI_STA);
  int found = WiFi.scanNetworks();
  Serial.printf("[wifi] scan: %d networks\n", found);
  for (int i = 0; i < found && i < 15; i++) {
    Serial.printf("[wifi] %s (%d dBm) ch=%d\n", WiFi.SSID(i).c_str(), WiFi.RSSI(i), WiFi.channel(i));
  }
  WiFi.scanDelete();
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.google.com");
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setKeepAlive(30);
  mqtt.setBufferSize(768);
  connectMqtt();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) connectWifi();
  connectMqtt();
  float value = readValue();
  if (isnan(value)) {
    Serial.println("[iot] sensor NAN, skip cycle");
  } else if (mqtt.connected()) {
    publishValue(value);
  } else {
    Serial.println("[iot] mqtt offline, skip cycle");
  }
  delay(INTERVAL_MS);
}
"##;
    let code = template
        .replace("@@SENSOR_CODE@@", &escape_cpp(sensor_code))
        .replace("@@SENSOR_ID@@", &escape_cpp(sensor_id))
        .replace("@@SENSOR_LABEL@@", &safe_comment(spec.label))
        .replace("@@ASSET@@", &safe_comment(asset))
        .replace("@@MCU@@", mcu)
        .replace("@@BOARD@@", board)
        .replace("@@LIB@@", spec.library)
        .replace("@@WIFI_SSID@@", &escape_cpp(wifi_ssid))
        .replace("@@WIFI_PASS@@", &escape_cpp(wifi_pass))
        .replace("@@MQTT_HOST@@", &escape_cpp(mqtt_host))
        .replace("@@MQTT_PORT@@", &mqtt_port.to_string())
        .replace("@@MQTT_TOPIC@@", &escape_cpp(&format!("city/sensors/{sensor_id}/data")))
        .replace("@@INTERVAL_MS@@", &(interval.clamp(5, 3600) * 1000).to_string())
        .replace("@@CULVERT_DEPTH@@", &format!("{depth:.1}"))
        .replace("@@UNIT@@", &escape_cpp(spec.unit))
        .replace("@@MOCK_DEFINE@@", mock_define)
        .replace("@@MOCK_BLOCK@@", &mock_block)
        .replace("@@SENSOR_BLOCK@@", &sensor_block)
        .replace("@@FILENAME@@", &filename);
    (filename, code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firmware_uses_mqtt_sensor_topic_and_mock_mode() {
        let (filename, code) = firmware_ino(
            "cong-nc-001-wl",
            "CONG-NC-001-WL",
            &Map::new(),
            "esp32",
            "water_level_jsn",
            "KMGSAFEHORIFPT",
            "secret",
            "synapsecity.sbs",
            1883,
            30,
            true,
            220.0,
        );
        assert_eq!(filename, "CONG_NC_001_WL_esp32_water_level_jsn.ino");
        assert!(code.contains("city/sensors/cong-nc-001-wl/data"));
        assert!(code.contains("#define MOCK_MODE 1"));
        assert!(code.contains("#include <PubSubClient.h>"));
        assert!(code.contains("#define CULVERT_DEPTH_CM 220.0"));
        assert!(code.contains("#define MQTT_PORT 1883"));
        assert!(code.contains("#define TRIG_PIN 18"));
        assert!(code.contains("#define ECHO_PIN 19"));
        assert!(code.contains("cầu phân áp"));
        assert!(code.contains("Mực nước siêu âm chống nước JSN-SR04T"));
        assert!(!code.contains("api_key"));
        assert!(!code.contains("X-API-Key"));
    }

    #[test]
    fn mock_mode_can_be_disabled() {
        let (_, code) = firmware_ino(
            "sensor-1",
            "SENSOR-1",
            &Map::new(),
            "esp32",
            "water_level_jsn",
            "wifi",
            "",
            "synapsecity.sbs",
            1883,
            60,
            false,
            180.0,
        );
        assert!(code.contains("// #define MOCK_MODE 1"));
        assert!(code.contains("#define CULVERT_DEPTH_CM 180.0"));
    }
}
