// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { Response } from 'express';

const VIETMAP_BASE_URL = 'https://maps.vietmap.vn';
const TILE_STYLES = new Set(['tm', 'lm', 'dm', 'hm', 'st']);

export type VietMapSuggestion = {
  ref_id?: string;
  display?: string;
  address?: string;
  name?: string;
  boundaries?: Array<{ full_name?: string; name?: string }>;
};

export type VietMapPlace = {
  display?: string;
  address?: string;
  city?: string;
  ward?: string;
  lat?: number;
  lng?: number;
};

export function vietMapKey(): string | null {
  const value = process.env.VIETMAP_API_KEY?.trim();
  return value || null;
}

export function vietMapTileStyle(): string {
  const configured = process.env.VIETMAP_TILE_STYLE?.trim().toLowerCase() || 'tm';
  return TILE_STYLES.has(configured) ? configured : 'tm';
}

export function vietMapConfigured(): boolean {
  return vietMapKey() !== null;
}

async function vietMapGet<T>(pathname: string, params: Record<string, string>): Promise<T> {
  const key = vietMapKey();
  if (!key) {
    throw Object.assign(new Error('VIETMAP_API_KEY is not configured'), { status: 503 });
  }
  const query = new URLSearchParams({ ...params, apikey: key });
  const response = await fetch(`${VIETMAP_BASE_URL}${pathname}?${query}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'application/json', 'user-agent': 'SynapseCity/0.1' },
  });
  const text = await response.text();
  if (!response.ok) {
    throw Object.assign(new Error(`VietMap request failed with status ${response.status}`), { status: response.status });
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw Object.assign(new Error('VietMap returned invalid JSON'), { status: 502 });
  }
}

export async function vietMapAutocomplete(text: string): Promise<VietMapSuggestion[]> {
  const result = await vietMapGet<unknown>('/api/autocomplete/v4', { text, display_type: '5' });
  return Array.isArray(result) ? result as VietMapSuggestion[] : [];
}

export async function vietMapGeocode(text: string): Promise<VietMapSuggestion[]> {
  const result = await vietMapGet<unknown>('/api/search/v4', { text, display_type: '5' });
  return Array.isArray(result) ? result as VietMapSuggestion[] : [];
}

export async function vietMapPlace(refid: string): Promise<VietMapPlace> {
  return vietMapGet<VietMapPlace>('/api/place/v4', { refid });
}

export async function vietMapReverse(lat: number, lng: number): Promise<VietMapPlace[]> {
  const result = await vietMapGet<unknown>('/api/reverse/v4', {
    lat: String(lat),
    lng: String(lng),
    display_type: '5',
  });
  return Array.isArray(result) ? result as VietMapPlace[] : [];
}

export async function proxyVietMapTile(z: number, x: number, y: number, res: Response): Promise<void> {
  const key = vietMapKey();
  if (!key) {
    res.status(503).json({ error: 'vietmap_not_configured' });
    return;
  }
  const style = vietMapTileStyle();
  const query = new URLSearchParams({ apikey: key });
  const response = await fetch(`${VIETMAP_BASE_URL}/maps/tiles/${style}/${z}/${x}/${y}.png?${query}`, {
    signal: AbortSignal.timeout(10_000),
    headers: { accept: 'image/png', 'user-agent': 'SynapseCity/0.1' },
  });
  if (!response.ok) {
    res.status(response.status).json({ error: 'vietmap_tile_unavailable' });
    return;
  }
  res.status(200);
  // Keep the binary content type exact; charset must not be attached to PNG.
  res.type('png');
  res.setHeader('cache-control', 'public, max-age=86400, stale-while-revalidate=604800');
  res.end(Buffer.from(await response.arrayBuffer()));
}
