// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useState, useEffect, useCallback, useMemo } from 'react';
import type { Asset } from '../api';
import { api } from '../api';
import { asList } from '../lib/httpClient';

// Types for IoT data - matching actual API response
export interface Sensor {
    id: string;
    _id?: string;
    sensor_code: string;
    asset_id: string;
    sensor_type: string;
    manufacturer?: string;
    model?: string;
    measurement_unit?: string;
    status: string;
    thresholds?: {
        min_value?: number;
        max_value?: number;
        critical_min?: number;
        critical_max?: number;
        warning_min?: number;
        warning_max?: number;
    };
    // Legacy config format
    config?: {
        thresholds: {
            min: number;
            max: number;
            critical_min: number;
            critical_max: number;
        };
        sampling_interval: number;
    };
    last_seen?: string;
    last_reading?: number;
    created_at: string;
}

export interface SensorReading {
    id?: string;
    _id?: string;
    sensor_id: string;
    asset_id?: string;
    timestamp: string;
    value?: number;
    readings?: {
        water_level?: number;
        flow_rate?: number;
        [key: string]: number | undefined;
    };
    battery?: number;
    rssi?: number;
    metadata?: Record<string, unknown>;
}

export interface IoTAlert {
    _id: string;
    sensor_id: string;
    asset_id: string;
    alert_type: string;
    severity: 'info' | 'warning' | 'critical';
    message: string;
    value: number;
    threshold: number;
    created_at: string;
    acknowledged: boolean;
}

export interface AssetIoTData {
    asset_id: string;
    asset: {
        id: string;
        feature_type: string;
        feature_code: string;
    };
    sensors: Sensor[];
    readings: SensorReading[];
    alerts: IoTAlert[];
    summary: {
        total_sensors: number;
        total_readings: number;
        active_alerts: number;
    };
}

type AssetWithIoTStatus = Omit<Asset, 'status'> & {
    status: string;
    lastPing: string;
};

const getErrorMessage = (error: unknown, fallback: string): string => {
    if (error instanceof Error && error.message) {
        return error.message;
    }
    return fallback;
};

// API functions
export const iotApi = {
    async getSensors(assetId?: string): Promise<Sensor[]> {
        const params = assetId ? `?asset_id=${assetId}` : '';
        const response = await api.get(`/iot/sensors${params}`);
        return asList<Sensor>(response.data);
    },

    async getSensorReadings(sensorId: string, hours: number = 24): Promise<SensorReading[]> {
        const response = await api.get(`/iot/sensors/${sensorId}/readings?limit=${hours * 12}`);
        return asList<SensorReading>(response.data?.readings);
    },

    async getAssetIoTData(assetId: string, hours: number = 24): Promise<AssetIoTData> {
        const response = await api.get(`/iot/assets/${assetId}/iot-data?hours=${hours}`);
        const payload = response.data;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            return {
                asset_id: assetId,
                asset: { id: assetId, feature_type: 'infrastructure', feature_code: assetId },
                sensors: [],
                readings: [],
                alerts: [],
                summary: { total_sensors: 0, total_readings: 0, active_alerts: 0 },
            };
        }
        const record = payload as Partial<AssetIoTData>;
        return {
            asset_id: record.asset_id || assetId,
            asset: record.asset || { id: assetId, feature_type: 'infrastructure', feature_code: assetId },
            sensors: asList<Sensor>(record.sensors),
            readings: asList<SensorReading>(record.readings),
            alerts: asList<IoTAlert>(record.alerts),
            summary: record.summary || { total_sensors: 0, total_readings: 0, active_alerts: 0 },
        };
    },

    async getAlerts(acknowledged?: boolean): Promise<IoTAlert[]> {
        const params = acknowledged !== undefined ? `?acknowledged=${acknowledged}` : '';
        const response = await api.get(`/iot/alerts${params}`);
        return asList<IoTAlert>(response.data);
    },

    async acknowledgeAlert(alertId: string): Promise<void> {
        await api.post(`/iot/alerts/${alertId}/acknowledge`);
    }
};

// Legacy asset-status view backed by persisted asset fields. It never invents
// online/offline transitions or alerts: sensor connectivity is reported by the
// IoT endpoints, and alerts come from /v1/alerts.
export const useIoT = (initialAssets: Asset[] | undefined) => {
    const assetsWithStatus = useMemo<AssetWithIoTStatus[]>(
        () => (Array.isArray(initialAssets) ? initialAssets : []).map((asset) => ({
            ...asset,
            status: String((asset as Asset & { status?: string }).status || 'active'),
            lastPing: String((asset as Asset & { updated_at?: string }).updated_at || ''),
        })),
        [initialAssets]
    );

    return { assetsWithStatus, alerts: [] as string[] };
};

// Hook for real IoT sensor data
export const useSensorData = (assetId: string | null, refreshInterval: number = 60000) => {
    const [data, setData] = useState<AssetIoTData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const fetchData = useCallback(async () => {
        if (!assetId) {
            setData(null);
            return;
        }

        setLoading(true);
        setError(null);

        try {
            const iotData = await iotApi.getAssetIoTData(assetId, 24);
            setData(iotData);
        } catch (err: unknown) {
            setError(getErrorMessage(err, 'Failed to fetch IoT data'));
            setData(null);
        } finally {
            setLoading(false);
        }
    }, [assetId]);

    useEffect(() => {
        const initialFetch = window.setTimeout(() => void fetchData(), 0);

        if (refreshInterval > 0 && assetId) {
            const interval = setInterval(fetchData, refreshInterval);
            return () => {
                window.clearTimeout(initialFetch);
                clearInterval(interval);
            };
        }

        return () => window.clearTimeout(initialFetch);
    }, [assetId, refreshInterval, fetchData]);

    return { data, loading, error, refetch: fetchData };
};

// Hook for IoT alerts
export const useIoTAlerts = (refreshInterval: number = 30000) => {
    const [alerts, setAlerts] = useState<IoTAlert[]>([]);
    const [loading, setLoading] = useState(false);

    const fetchAlerts = useCallback(async () => {
        setLoading(true);
        try {
            const data = await iotApi.getAlerts(false); // Only unacknowledged
            setAlerts(data);
        } catch (err) {
            console.error('Failed to fetch alerts:', err);
        } finally {
            setLoading(false);
        }
    }, []);

    const acknowledgeAlert = useCallback(async (alertId: string) => {
        try {
            await iotApi.acknowledgeAlert(alertId);
            setAlerts(prev => prev.filter(a => a._id !== alertId));
        } catch (err) {
            console.error('Failed to acknowledge alert:', err);
        }
    }, []);

    useEffect(() => {
        const initialFetch = window.setTimeout(() => void fetchAlerts(), 0);

        if (refreshInterval > 0) {
            const interval = setInterval(fetchAlerts, refreshInterval);
            return () => {
                window.clearTimeout(initialFetch);
                clearInterval(interval);
            };
        }

        return () => window.clearTimeout(initialFetch);
    }, [refreshInterval, fetchAlerts]);

    return { alerts, loading, acknowledgeAlert, refetch: fetchAlerts };
};
