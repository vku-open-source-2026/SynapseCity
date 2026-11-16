// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { Coordinates, Geometry } from '../api/types';

export const DEFAULT_CENTER: Coordinates = { latitude: 16.0544, longitude: 108.2022 };

export interface GeoPoint extends Coordinates {
  id?: string;
}

export function toRadians(value: number): number {
  return (value * Math.PI) / 180;
}

export function distanceMeters(a: Coordinates, b: Coordinates): number {
  const earth = 6_371_000;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function bearingDegrees(from: Coordinates, to: Coordinates): number {
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);
  const dLng = toRadians(to.longitude - from.longitude);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '—';
  if (meters < 950) return `${Math.max(0, Math.round(meters / 10) * 10)} m`;
  return `${(meters / 1000).toFixed(meters < 10_000 ? 1 : 0)} km`;
}

export function firstPoint(geometry: Geometry | undefined | null): Coordinates | null {
  if (!geometry || !('coordinates' in geometry)) return null;
  const walk = (value: unknown): Coordinates | null => {
    if (!Array.isArray(value)) return null;
    if (
      value.length >= 2 &&
      typeof value[0] === 'number' &&
      typeof value[1] === 'number' &&
      Number.isFinite(value[0]) &&
      Number.isFinite(value[1])
    ) {
      return { longitude: value[0], latitude: value[1] };
    }
    for (const child of value) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(geometry.coordinates);
}

export function assetCoordinates(asset: {
  location?: { coordinates?: Coordinates; geometry?: Geometry };
  geometry?: Geometry;
}): Coordinates | null {
  const coordinates = asset.location?.coordinates;
  if (
    coordinates &&
    Number.isFinite(coordinates.latitude) &&
    Number.isFinite(coordinates.longitude)
  ) {
    return coordinates;
  }
  return firstPoint(asset.location?.geometry) ?? firstPoint(asset.geometry);
}

export function incidentCoordinates(incident: {
  location?: { coordinates?: Coordinates; geometry?: Geometry };
}): Coordinates | null {
  const coords = incident.location?.coordinates;
  if (coords && Number.isFinite(coords.latitude) && Number.isFinite(coords.longitude)) {
    return coords;
  }
  return firstPoint(incident.location?.geometry);
}

export function pointInDirection(
  origin: Coordinates,
  point: Coordinates,
  maxRadius: number,
): { x: number; y: number; distance: number } {
  const distance = distanceMeters(origin, point);
  const bearing = toRadians(bearingDegrees(origin, point));
  const ratio = maxRadius > 0 ? Math.min(1, distance / maxRadius) : 0;
  return {
    x: Math.sin(bearing) * ratio,
    y: -Math.cos(bearing) * ratio,
    distance,
  };
}

export function looksStale(timestamp: string | number | null | undefined, minutes = 30): boolean {
  if (!timestamp) return true;
  const value = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp);
  if (!Number.isFinite(value)) return true;
  return Date.now() - value > minutes * 60_000;
}
