// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { PublicIncident } from '../api/types';
import { distanceMeters } from '../lib/geo';
import { loadSeenIncident, saveSeenIncident, type AppSettings } from '../lib/storage';
import type { AppLocation } from './useLocation';

const CHANNEL_ID = 'city-updates';

async function ensurePermissions(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Cập nhật hạ tầng',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0F9F9A',
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (current.granted) return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.granted;
}

export function useCityNotifications(
  incidents: PublicIncident[] | undefined,
  location: AppLocation,
  settings: AppSettings,
) {
  const initialized = useRef(false);
  const seen = useRef<string | null>(null);

  useEffect(() => {
    if (!settings.notificationsEnabled) return;
    let active = true;
    loadSeenIncident().then((value) => {
      if (active) seen.current = value;
    });
    ensurePermissions().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [settings.notificationsEnabled]);

  useEffect(() => {
    if (!incidents || incidents.length === 0) return;
    const newest = [...incidents].sort(
      (a, b) => Date.parse(b.created_at) - Date.parse(a.created_at),
    )[0];
    if (!newest?.id) return;
    const seenId = seen.current;
    if (!initialized.current) {
      initialized.current = true;
      if (!seenId) {
        seen.current = newest.id;
        saveSeenIncident(newest.id).catch(() => undefined);
      }
      return;
    }
    if (newest.id === seenId) return;
    seen.current = newest.id;
    saveSeenIncident(newest.id).catch(() => undefined);
    if (!settings.notificationsEnabled) return;

    const coords = newest.location?.coordinates;
    const distance = coords
      ? distanceMeters(
          { latitude: location.latitude, longitude: location.longitude },
          coords,
        )
      : null;
    const important =
      newest.severity === 'high' ||
      newest.severity === 'critical' ||
      (distance !== null && distance <= 2_000);
    if (!important) return;

    Notifications.scheduleNotificationAsync({
      content: {
        title:
          newest.severity === 'critical'
            ? 'Sự cố nghiêm trọng gần bạn'
            : 'Cập nhật sự cố hạ tầng',
        body: `${newest.title}${distance !== null ? ` · cách ${Math.round(distance / 100) / 10} km` : ''}`,
        data: { incidentId: newest.incident_number || newest.id },
        sound: true,
      },
      trigger: null,
    }).catch(() => undefined);
  }, [incidents, location.latitude, location.longitude, settings.notificationsEnabled]);
}
