// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * City-owned geospatial predicates and distance calculations.
 *
 * These are pure functions so the server applies exactly the same rules in the
 * nearby/bounds/polygon/geofence endpoints and the unit tests can assert exact
 * membership on small fixtures.
 */

export interface Point {
  longitude: number;
  latitude: number;
}

export interface BoundingBox {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
}

const EARTH_RADIUS_METERS = 6_371_000;

export function haversineMeters(a: Point, b: Point): number {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function isValidPoint(point: Partial<Point> | null | undefined): point is Point {
  return Boolean(point)
    && Number.isFinite(point?.longitude)
    && Number.isFinite(point?.latitude)
    && Math.abs(Number(point?.longitude)) <= 180
    && Math.abs(Number(point?.latitude)) <= 90;
}

/**
 * Callers may use `lng|lon|longitude` and `lat|latitude` query names. Returns
 * null when a coordinate is missing or out of range.
 */
export function parsePoint(input: Record<string, unknown>): Point | null {
  const longitude = Number(input.lng ?? input.lon ?? input.longitude);
  const latitude = Number(input.lat ?? input.latitude);
  const point = { longitude, latitude };
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
  if (longitude === 0 && latitude === 0 && input.lng === undefined && input.lon === undefined && input.longitude === undefined) return null;
  return isValidPoint(point) ? point : null;
}

export function pointInBoundingBox(point: Point, box: BoundingBox): boolean {
  return point.longitude >= Math.min(box.minLng, box.maxLng)
    && point.longitude <= Math.max(box.minLng, box.maxLng)
    && point.latitude >= Math.min(box.minLat, box.maxLat)
    && point.latitude <= Math.max(box.minLat, box.maxLat);
}

/** Ray-casting point-in-polygon test. The polygon is a list of [lng, lat]. */
export function pointInPolygon(point: Point, polygon: Array<[number, number]>): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects = (yi > point.latitude) !== (yj > point.latitude)
      && point.longitude < ((xj - xi) * (point.latitude - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Accept either a bare coordinate ring or a GeoJSON Polygon/MultiPolygon. */
export function polygonCoordinates(value: unknown): Array<[number, number]> | null {
  const extractRing = (ring: unknown): Array<[number, number]> | null => {
    if (!Array.isArray(ring) || ring.length < 3) return null;
    const points: Array<[number, number]> = [];
    for (const entry of ring) {
      if (!Array.isArray(entry) || entry.length < 2) return null;
      const lng = Number(entry[0]);
      const lat = Number(entry[1]);
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
      points.push([lng, lat]);
    }
    return points;
  };
  if (Array.isArray(value)) {
    const direct = extractRing(value);
    if (direct) return direct;
  }
  if (value && typeof value === 'object') {
    const geometry = value as { type?: string; coordinates?: unknown };
    if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
      return extractRing((geometry.coordinates as unknown[])[0]);
    }
    if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
      return extractRing(((geometry.coordinates as unknown[])[0] as unknown[])?.[0]);
    }
  }
  return null;
}

/** Straight-line travel-time estimate used only when no routing provider is configured. */
export function estimatedDurationSeconds(distanceMeters: number, speedKmh = 30): number {
  return Math.round((distanceMeters / 1000 / speedKmh) * 3600);
}

export function withinRadius(point: Point, center: Point, radiusMeters: number): boolean {
  return haversineMeters(point, center) <= radiusMeters;
}
