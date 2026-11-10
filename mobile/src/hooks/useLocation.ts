// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { DEFAULT_CENTER } from '../lib/geo';
import { loadLocation, saveLocation, type StoredLocation } from '../lib/storage';

export type LocationState = 'loading' | 'ready' | 'denied' | 'fallback' | 'error';

export interface AppLocation {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  updatedAt: number;
  label: string;
  isFallback: boolean;
}

const fallbackLocation: AppLocation = {
  ...DEFAULT_CENTER,
  accuracy: null,
  updatedAt: 0,
  label: 'Đà Nẵng · vị trí mặc định',
  isFallback: true,
};

function fromStored(stored: StoredLocation): AppLocation {
  return {
    latitude: stored.latitude,
    longitude: stored.longitude,
    accuracy: stored.accuracy ?? null,
    updatedAt: stored.updatedAt,
    label: stored.label || 'Vị trí đã lưu',
    isFallback: false,
  };
}

export function useLocation() {
  const [location, setLocation] = useState<AppLocation>(fallbackLocation);
  const [state, setState] = useState<LocationState>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async (requestPermission = true) => {
    setMessage(null);
    const cached = await loadLocation();
    if (cached && mounted.current) {
      setLocation(fromStored(cached));
      setState('ready');
    }

    try {
      const existing = await Location.getForegroundPermissionsAsync();
      let permission = existing;
      if (permission.status !== 'granted' && requestPermission) {
        permission = await Location.requestForegroundPermissionsAsync();
      }
      if (permission.status !== 'granted') {
        if (mounted.current) {
          setLocation((current) => (current.updatedAt > 0 ? current : fallbackLocation));
          setState(cached ? 'ready' : 'fallback');
          setMessage('Chưa cấp quyền vị trí. Đang dùng trung tâm Đà Nẵng.');
        }
        return;
      }

      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      if (!mounted.current) return;
      const next: AppLocation = {
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
        accuracy: current.coords.accuracy ?? null,
        updatedAt: Date.now(),
        label: 'Vị trí hiện tại',
        isFallback: false,
      };
      setLocation(next);
      setState('ready');
      await saveLocation({
        latitude: next.latitude,
        longitude: next.longitude,
        accuracy: next.accuracy,
        updatedAt: next.updatedAt,
        label: next.label,
      });
    } catch (error) {
      if (!mounted.current) return;
      setState(cached ? 'ready' : 'error');
      setMessage(
        error instanceof Error
          ? 'Không lấy được vị trí. Kiểm tra GPS hoặc thử lại.'
          : 'Không lấy được vị trí.',
      );
    }
  }, []);

  useEffect(() => {
    refresh(true).catch(() => undefined);
  }, [refresh]);

  return { location, state, message, refresh };
}
