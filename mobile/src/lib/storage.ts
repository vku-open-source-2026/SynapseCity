// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import type { AuthResponse } from '../api/types';

const KEYS = {
  session: 'synapsecity.session.v1',
  lastLocation: 'synapsecity.lastLocation.v1',
  settings: 'synapsecity.settings.v1',
  seenIncident: 'synapsecity.seenIncident.v1',
  widgetSnapshot: 'synapsecity.widgetSnapshot.v1',
};

export interface StoredLocation {
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  updatedAt: number;
  label?: string;
}

export interface AppSettings {
  notificationsEnabled: boolean;
  severityThreshold: 'all' | 'high' | 'critical';
  useMetric: boolean;
}

export const defaultSettings: AppSettings = {
  notificationsEnabled: true,
  severityThreshold: 'all',
  useMetric: true,
};

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: AuthResponse['user'];
}

async function readJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is best effort; the UI keeps working from memory.
  }
}

export async function loadLocation(): Promise<StoredLocation | null> {
  return readJson<StoredLocation>(KEYS.lastLocation);
}

export async function saveLocation(location: StoredLocation): Promise<void> {
  await writeJson(KEYS.lastLocation, location);
}

export async function loadSettings(): Promise<AppSettings> {
  return { ...defaultSettings, ...(await readJson<Partial<AppSettings>>(KEYS.settings)) };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await writeJson(KEYS.settings, settings);
}

export async function loadWidgetSnapshot<T>(): Promise<T | null> {
  return readJson<T>(KEYS.widgetSnapshot);
}

export async function saveWidgetSnapshot(snapshot: unknown): Promise<void> {
  await writeJson(KEYS.widgetSnapshot, snapshot);
}

export async function loadSeenIncident(): Promise<string | null> {
  return AsyncStorage.getItem(KEYS.seenIncident);
}

export async function saveSeenIncident(id: string): Promise<void> {
  await AsyncStorage.setItem(KEYS.seenIncident, id);
}

export async function loadSession(): Promise<Session | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEYS.session);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export async function saveSession(session: Session): Promise<void> {
  await SecureStore.setItemAsync(KEYS.session, JSON.stringify(session), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function clearSession(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(KEYS.session);
  } catch {
    // Ignore; callers clear in-memory state regardless.
  }
}
