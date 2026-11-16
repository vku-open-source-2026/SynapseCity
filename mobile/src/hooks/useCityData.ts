// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useMemo, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cityApi } from '../api/city';
import type { PublicAsset, PublicIncident } from '../api/types';
import { assetCoordinates, distanceMeters } from '../lib/geo';
import { buildWidgetSnapshot, syncCityWidget } from '../lib/widget';
import type { AppLocation } from './useLocation';

export const queryKeys = {
  product: ['city', 'product'] as const,
  assets: ['city', 'assets'] as const,
  incidents: ['city', 'incidents'] as const,
  asset: (code: string) => ['city', 'asset', code] as const,
  maintenance: (code: string) => ['city', 'maintenance', code] as const,
  incident: (reference: string) => ['city', 'incident', reference] as const,
  alerts: ['city', 'alerts'] as const,
  notifications: ['city', 'notifications'] as const,
  mapConfig: ['city', 'map-config'] as const,
};

export function useProductInfo() {
  return useQuery({
    queryKey: queryKeys.product,
    queryFn: cityApi.getProductInfo,
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function usePublicAssets() {
  return useQuery({
    queryKey: queryKeys.assets,
    queryFn: () => cityApi.listPublicAssets({ limit: 200 }),
    staleTime: 60_000,
    retry: 1,
  });
}

export function usePublicIncidents() {
  return useQuery({
    queryKey: queryKeys.incidents,
    queryFn: () => cityApi.listPublicIncidents({ limit: 100 }),
    staleTime: 60_000,
    retry: 1,
  });
}

export function usePublicAsset(code: string | null) {
  return useQuery({
    queryKey: queryKeys.asset(code || 'none'),
    queryFn: () => cityApi.getPublicAsset(code as string),
    enabled: Boolean(code),
    staleTime: 60_000,
    retry: 1,
  });
}

export function useMaintenanceSummary(code: string | null) {
  return useQuery({
    queryKey: queryKeys.maintenance(code || 'none'),
    queryFn: () => cityApi.getMaintenanceSummary(code as string),
    enabled: Boolean(code),
    staleTime: 5 * 60_000,
    retry: 1,
  });
}

export function usePublicIncident(reference: string | null) {
  return useQuery({
    queryKey: queryKeys.incident(reference || 'none'),
    queryFn: () => cityApi.getPublicIncident(reference as string),
    enabled: Boolean(reference),
    staleTime: 60_000,
    retry: 1,
  });
}

export interface NearbyAsset {
  asset: PublicAsset;
  distance: number;
  bearing: number;
  coordinates: { latitude: number; longitude: number };
}

export function useNearbyAssets(
  assets: PublicAsset[] | undefined,
  location: AppLocation,
  radiusMeters = 5_000,
): NearbyAsset[] {
  return useMemo(() => {
    const origin = { latitude: location.latitude, longitude: location.longitude };
    return (assets ?? [])
      .map((asset) => {
        const coordinates = assetCoordinates(asset);
        if (!coordinates) return null;
        const distance = distanceMeters(origin, coordinates);
        return { asset, distance, coordinates, bearing: 0 };
      })
      .filter((entry): entry is NearbyAsset => Boolean(entry))
      .filter((entry) => entry.distance <= radiusMeters)
      .sort((a, b) => a.distance - b.distance);
  }, [assets, location.latitude, location.longitude, radiusMeters]);
}

export function useNearbyIncidents(
  incidents: PublicIncident[] | undefined,
  location: AppLocation,
  radiusMeters = 10_000,
): Array<{ incident: PublicIncident; distance: number }> {
  return useMemo(() => {
    const origin = { latitude: location.latitude, longitude: location.longitude };
    return (incidents ?? [])
      .map((incident) => {
        const coords = incident.location?.coordinates;
        if (!coords) return null;
        const distance = distanceMeters(origin, coords);
        return distance <= radiusMeters ? { incident, distance } : null;
      })
      .filter((entry): entry is { incident: PublicIncident; distance: number } => Boolean(entry))
      .sort((a, b) => b.distance - a.distance)
      .sort((a, b) => Date.parse(b.incident.created_at) - Date.parse(a.incident.created_at));
  }, [incidents, location.latitude, location.longitude, radiusMeters]);
}

export function useCityWidgetSync(
  location: AppLocation,
  assets: PublicAsset[] | undefined,
  online: boolean,
  locationLabel?: string,
) {
  const lastSignature = useRef('');
  useEffect(() => {
    if (!assets || location.updatedAt === 0) return;
    const snapshot = buildWidgetSnapshot(
      {
        latitude: location.latitude,
        longitude: location.longitude,
        accuracy: location.accuracy,
        updatedAt: location.updatedAt,
        label: locationLabel || location.label,
      },
      assets,
      {
        locationLabel: locationLabel || location.label,
        locationIsFallback: location.isFallback,
        online,
      },
    );
    const signature = JSON.stringify({
      lat: snapshot.latitude.toFixed(5),
      lng: snapshot.longitude.toFixed(5),
      count: snapshot.totalNearby,
      nearest: snapshot.nearestCode,
      online: snapshot.online,
      label: snapshot.locationLabel,
    });
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    syncCityWidget(snapshot).catch(() => undefined);
  }, [assets, location, online, locationLabel]);
}
