// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { NativeModules, Platform } from 'react-native';
import type { PublicAsset } from '../api/types';
import { assetCoordinates, distanceMeters } from './geo';
import { saveWidgetSnapshot, type StoredLocation } from './storage';

export interface WidgetAsset {
  code: string;
  name: string;
  status: string;
  distanceM: number;
  latitude: number;
  longitude: number;
}

export interface CityWidgetSnapshot {
  generatedAt: number;
  source: 'app' | 'background';
  latitude: number;
  longitude: number;
  locationLabel: string;
  locationIsFallback: boolean;
  nearestCode: string | null;
  nearestName: string | null;
  nearestDistanceM: number | null;
  nearestStatus: string | null;
  totalNearby: number;
  assets: WidgetAsset[];
  online: boolean;
}

type WidgetBridgeModule = {
  sync(snapshotJson: string): void;
  refresh(): void;
};

const WidgetBridge = NativeModules.WidgetBridge as WidgetBridgeModule | undefined;

export function buildWidgetSnapshot(
  location: StoredLocation,
  assets: PublicAsset[],
  options: { locationLabel?: string; locationIsFallback?: boolean; online?: boolean } = {},
): CityWidgetSnapshot {
  const origin = { latitude: location.latitude, longitude: location.longitude };
  const nearby = assets
    .map((asset) => {
      const coordinates = assetCoordinates(asset);
      if (!coordinates) return null;
      return {
        asset,
        coordinates,
        distance: distanceMeters(origin, coordinates),
      };
    })
    .filter((entry): entry is { asset: PublicAsset; coordinates: { latitude: number; longitude: number }; distance: number } => Boolean(entry))
    .filter((entry) => entry.distance <= 5_000)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 20);

  const nearest = nearby[0];
  return {
    generatedAt: Date.now(),
    source: 'app',
    latitude: location.latitude,
    longitude: location.longitude,
    locationLabel: options.locationLabel || 'Vị trí hiện tại',
    locationIsFallback: Boolean(options.locationIsFallback),
    nearestCode: nearest?.asset.asset_code ?? null,
    nearestName: nearest?.asset.name ?? null,
    nearestDistanceM: nearest?.distance ?? null,
    nearestStatus: nearest?.asset.status ?? null,
    totalNearby: nearby.length,
    online: options.online ?? true,
    assets: nearby.slice(0, 12).map((entry) => ({
      code: entry.asset.asset_code,
      name: entry.asset.name,
      status: entry.asset.status,
      distanceM: Math.round(entry.distance),
      latitude: entry.coordinates.latitude,
      longitude: entry.coordinates.longitude,
    })),
  };
}

export async function syncCityWidget(snapshot: CityWidgetSnapshot): Promise<void> {
  await saveWidgetSnapshot(snapshot);
  if (Platform.OS !== 'android' || !WidgetBridge) return;
  try {
    WidgetBridge.sync(JSON.stringify(snapshot));
  } catch {
    // Widget bridge is an enhancement; never block the app on it.
  }
}

export function requestWidgetRefresh(): void {
  if (Platform.OS !== 'android' || !WidgetBridge) return;
  try {
    WidgetBridge.refresh();
  } catch {
    // Ignore.
  }
}
