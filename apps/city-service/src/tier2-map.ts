// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 map/security proxy.
 *
 * City holds no VietMap or CAPTCHA provider key. Raster tiles and Turnstile
 * verification are Tier-2 capabilities; this module only forwards the
 * deployment credential over the public HTTPS boundary.
 */
import type { Response } from 'express';
function tier2Base(): string {
  return (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/$/, '');
}

function serviceHeaders(): Record<string, string> {
  const headers: Record<string, string> = { accept: '*/*' };
  const apiKey = process.env.SYNAPSEDX_API_KEY?.trim();
  const token = process.env.SYNAPSEDX_TOKEN?.trim();
  if (apiKey) headers['x-api-key'] = apiKey;
  else if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export function tier2MapConfigured(): boolean {
  return Boolean(process.env.SYNAPSEDX_API_KEY?.trim() || process.env.SYNAPSEDX_TOKEN?.trim());
}

function timeoutMs(): number {
  const value = Number(process.env.SYNAPSEDX_TIMEOUT_MS || 20_000);
  return Math.min(Math.max(Number.isFinite(value) ? value : 20_000, 1_000), 120_000);
}

export async function proxyTier2Tile(z: number, x: number, y: number, res: Response): Promise<void> {
  if (!tier2MapConfigured()) {
    res.status(503).json({ error: 'map_tiles_unavailable', dependency: 'synapsedx' });
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs());
  try {
    const response = await fetch(`${tier2Base()}/v1/capabilities/geo/tiles/${z}/${x}/${y}.png`, {
      headers: serviceHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) {
      res.status(response.status === 429 ? 429 : 503).json({
        error: 'map_tiles_unavailable',
        dependency: 'synapsedx',
        upstreamStatus: response.status,
        ...(response.headers.get('retry-after') ? { retryAfter: response.headers.get('retry-after') } : {}),
      });
      return;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('content-type', response.headers.get('content-type') || 'image/png');
    res.setHeader('cache-control', 'public, max-age=86400, immutable');
    const cache = response.headers.get('x-tier2-cache');
    if (cache) res.setHeader('x-tier2-cache', cache);
    res.send(buffer);
  } catch {
    res.status(503).json({ error: 'map_tiles_unavailable', dependency: 'synapsedx' });
  } finally {
    clearTimeout(timer);
  }
}

export interface TurnstileVerification {
  ok: boolean;
  configured: boolean;
  error?: string;
}

export async function verifyTier2Turnstile(token: string, remoteip?: string): Promise<TurnstileVerification> {
  if (!tier2MapConfigured()) {
    return { ok: false, configured: false, error: 'turnstile_not_configured' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs(), 10_000));
  try {
    const response = await fetch(`${tier2Base()}/v1/capabilities/security/turnstile/verify`, {
      method: 'POST',
      headers: { ...serviceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...(remoteip ? { remoteip } : {}) }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload) {
      return { ok: false, configured: true, error: response.status === 429 ? 'turnstile_rate_limited' : 'turnstile_unavailable' };
    }
    const errorValue = payload.error;
    const errorCode = typeof errorValue === 'string'
      ? errorValue
      : (errorValue && typeof errorValue === 'object' && typeof (errorValue as Record<string, unknown>).code === 'string'
        ? String((errorValue as Record<string, unknown>).code)
        : undefined);
    if (!response.ok) {
      return { ok: false, configured: true, error: errorCode || (response.status === 429 ? 'turnstile_rate_limited' : 'turnstile_unavailable') };
    }
    return {
      ok: payload.ok === true,
      configured: payload.configured !== false,
      ...(errorCode ? { error: errorCode } : {}),
    };
  } catch {
    return { ok: false, configured: true, error: 'turnstile_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
