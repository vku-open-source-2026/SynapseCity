// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
export type SensorStatus =
  | 'active'
  | 'inactive'
  | 'maintenance'
  | 'online'
  | 'offline'
  | 'error';
export type SensorType = 'temperature' | 'humidity' | 'pressure' | 'vibration' | 'noise' | 'air_quality' | 'water_level' | 'turbidity' | 'ph' | 'rainfall' | 'flow' | 'soil_moisture' | 'other';

export interface SensorLocation {
  longitude: number;
  latitude: number;
}

export interface SensorThresholds {
  warning_min?: number;
  warning_max?: number;
  critical_min?: number;
  critical_max?: number;
}

export interface IoTSensor {
  id: string;
  sensor_code: string;
  asset_id: string;
  sensor_type: SensorType;
  status: SensorStatus;
  location: SensorLocation;
  measurement_unit?: string;
  thresholds?: SensorThresholds;
  last_seen?: string;
  last_reading?: number | { value: number; timestamp: string; status: string };
  created_at: string;
}

export interface SensorReading {
  sensor_id: string;
  timestamp: string;
  value: number;
  metadata?: Record<string, unknown>;
}

export interface SensorStatistics {
  sensor_id: string;
  granularity: 'minute' | 'hour' | 'day';
  data: Array<{
    timestamp: string;
    avg: number;
    min: number;
    max: number;
    count: number;
  }>;
}

export interface SensorCreateRequest {
  sensor_code: string;
  asset_id: string;
  sensor_type: SensorType;
  location: SensorLocation;
  measurement_unit?: string;
  thresholds?: SensorThresholds;
}

export interface SensorUpdateRequest {
  sensor_type?: SensorType;
  status?: SensorStatus;
  location?: SensorLocation;
  measurement_unit?: string;
  thresholds?: SensorThresholds;
}

export interface SensorReadingIngestRequest {
  timestamp?: string;
  value: number;
  metadata?: Record<string, unknown>;
}

export interface McuOption { id: string; label: string; board: string; notes?: string }
export interface SensorOption {
  id: string; label: string; kind: string; unit: string;
  range?: { min: number; max: number }; interface?: string; library?: string; description?: string;
}
export interface IoTCatalog {
  mcus: McuOption[];
  sensors: SensorOption[];
  suggestions: Record<string, string[]>;
  ingest: Record<string, string>;
}
export interface FirmwareRequest {
  mcu: string; sensor: string; wifi_ssid: string; wifi_pass?: string;
  base_url?: string; api_key: string; interval_seconds?: number; mock_fallback?: boolean;
}
export interface FirmwareResponse {
  sensor_id: string; filename: string; language: string; mcu: string; sensor: string;
  interval_seconds: number; code: string; suggestions?: Array<{ id: string; label: string; unit: string }>;
  mqtt?: { topic: string; note: string }; warning?: string;
}
export interface MockRequest { count?: number; min?: number; max?: number; interval_seconds?: number }
