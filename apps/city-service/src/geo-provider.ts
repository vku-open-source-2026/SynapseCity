// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { CapabilitiesError, type CapabilitiesClient } from '@synapsedx/capabilities';

/**
 * Geocoding boundary.
 *
 * City always uses the shared, provider-neutral Tier-2 `geo` capability. The
 * deployment owns one provider credential in Tier 2; City holds no provider key
 * and has no local provider fallback.
 */
export type GeoProviderMode = 'tier2';

export interface GeoHit {
  address: string;
  label: string;
  coordinates: { latitude: number; longitude: number };
  city: string;
  country: string;
  id?: string;
  ref_id?: string;
  raw?: unknown;
}

export function geoProviderMode(): GeoProviderMode {
  return 'tier2';
}

export class GeoProviderError extends Error {
  status: number;
  code: string;
  provider: GeoProviderMode;
  detail: string;
  constructor(code: string, status: number, provider: GeoProviderMode, detail = code) {
    super(code);
    this.name = 'GeoProviderError';
    this.code = code;
    this.status = status;
    this.provider = provider;
    this.detail = detail;
  }
}

interface Tier2GeoItem {
  id?: string;
  label?: string;
  address?: string;
  lat?: number;
  lon?: number;
  raw?: unknown;
}

function toHit(item: Tier2GeoItem, fallback = ''): GeoHit {
  const latitude = Number(item.lat);
  const longitude = Number(item.lon);
  const address = String(item.address || item.label || fallback);
  return {
    address,
    label: String(item.label || item.address || fallback),
    coordinates: { latitude, longitude },
    city: String((item.raw as Record<string, unknown> | undefined)?.city || ''),
    country: String((item.raw as Record<string, unknown> | undefined)?.country || 'Vietnam'),
    ...(item.id ? { id: item.id, ref_id: item.id } : {}),
    ...(item.raw !== undefined ? { raw: item.raw } : {}),
  };
}

function hasCoordinates(hit: GeoHit): boolean {
  return Number.isFinite(hit.coordinates.latitude)
    && Number.isFinite(hit.coordinates.longitude)
    && !(hit.coordinates.latitude === 0 && hit.coordinates.longitude === 0);
}

/** Map a Tier-2 geo error to the City error contract. */
export function geoError(error: unknown): GeoProviderError {
  if (error instanceof CapabilitiesError) {
    if (error.status === 429) return new GeoProviderError('rate_limited', 429, 'tier2', 'The geocoder rate limit was reached.');
    if (error.status === 503) return new GeoProviderError('geocoder_unavailable', 503, 'tier2', 'The geocoder is not configured or unavailable.');
    if (error.status === 401 || error.status === 403) return new GeoProviderError('geocoder_unauthorized', 503, 'tier2', 'The Tier-2 credential may not use the geocoder.');
  }
  return new GeoProviderError('geocoder_unavailable', 503, 'tier2', 'The geocoder is unavailable.');
}

export async function tier2Autocomplete(client: CapabilitiesClient, query: string, limit = 5): Promise<GeoHit[]> {
  try {
    const items = await client.geo.autocomplete({ q: query, limit }) as Tier2GeoItem[];
    return items.map((item) => toHit(item, query)).filter(hasCoordinates);
  } catch (error) {
    throw geoError(error);
  }
}

export async function tier2Geocode(client: CapabilitiesClient, address: string): Promise<GeoHit | null> {
  try {
    const items = await client.geo.geocode(address) as Tier2GeoItem[];
    const hit = items.map((item) => toHit(item, address)).find(hasCoordinates);
    return hit || null;
  } catch (error) {
    throw geoError(error);
  }
}

export async function tier2Reverse(client: CapabilitiesClient, latitude: number, longitude: number): Promise<GeoHit | null> {
  try {
    const items = await client.geo.reverse(latitude, longitude) as Tier2GeoItem[];
    const hit = items.map((item) => toHit(item)).find((entry) => entry.address);
    return hit || null;
  } catch (error) {
    throw geoError(error);
  }
}

export function geoCoderStatus(): Record<string, unknown> {
  return {
    status: 'shared',
    provider: 'tier2',
    detail: 'Address search/geocode use the Tier-2 provider-neutral geo capability; City holds no provider key.',
  };
}
