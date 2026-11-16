// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Shared tile configuration helper.
 * Fetches the Tier-2 tile URL from the backend. There is no browser-side
 * fallback to a third-party map provider: an outage renders neutral tiles and
 * an explicit attribution instead of leaking a direct vendor request.
 */

const BASE_API: string = import.meta.env.VITE_BASE_API_URL ?? "";

export interface TileConfig {
  tileUrl: string;
  attribution: string;
  maxZoom: number;
  maxNativeZoom?: number;
  provider: string;
}

let _cachedTileConfig: TileConfig | null = null;

export async function fetchTileConfig(): Promise<TileConfig> {
  if (_cachedTileConfig) return _cachedTileConfig;
  try {
    const res = await fetch(`${BASE_API}/map/config`);
    const cfg: TileConfig = await res.json();
    // If tileUrl is relative, prepend the API origin so Leaflet resolves correctly
    if (cfg.tileUrl && !cfg.tileUrl.startsWith("http") && !cfg.tileUrl.startsWith("/")) {
      const apiOrigin = BASE_API.replace(/\/api\/v1$/, "");
      cfg.tileUrl = `${apiOrigin}${cfg.tileUrl}`;
    }
    _cachedTileConfig = cfg;
  } catch {
    _cachedTileConfig = {
      tileUrl:
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXQAAAAASUVORK5CYII=",
      attribution: "Map unavailable",
      maxZoom: 20,
      maxNativeZoom: 20,
      provider: "unavailable",
    };
  }
  return _cachedTileConfig!;
}
