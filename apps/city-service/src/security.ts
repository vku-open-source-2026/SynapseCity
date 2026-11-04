// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { NextFunction, Request, Response } from 'express';

/**
 * Edge-abuse and observability helpers for the City service.
 *
 * - a small fixed-window rate limiter for anonymous/auth endpoints;
 * - server-side Cloudflare Turnstile verification (the browser widget alone is
 *   decorative);
 * - Prometheus-style request counters and structured request logs.
 *
 * None of these are domain stores: the counters and limiter buckets are
 * process-local telemetry, not a replacement database.
 */

interface RateLimitOptions {
  name: string;
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export function resetRateLimits(): void {
  buckets.clear();
}

function clientKey(req: Request): string {
  const forwarded = req.header('x-forwarded-for');
  const address = forwarded ? forwarded.split(',')[0].trim() : req.ip;
  return address || 'unknown';
}

export function rateLimit(options: RateLimitOptions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = `${options.name}:${clientKey(req)}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > options.max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      metrics.rateLimited += 1;
      res.setHeader('retry-after', String(retryAfter));
      res.status(429).json({ error: 'rate_limited', detail: `${options.name}_limit_exceeded`, retry_after_seconds: retryAfter });
      return;
    }
    next();
  };
}

export interface TurnstileResult {
  ok: boolean;
  configured: boolean;
  error?: string;
}

/**
 * Verify a Turnstile token server-side.
 *
 * If no secret is configured the call succeeds only when Turnstile is not
 * required (`REQUIRE_TURNSTILE=true` turns it into a hard failure so a
 * production deployment cannot silently run unprotected). The verification URL
 * is overridable for explicit tests.
 */
export async function verifyTurnstile(req: Request): Promise<TurnstileResult> {
  const secret = (process.env.TURNSTILE_SECRET_KEY || '').trim();
  if (!secret) {
    if (process.env.REQUIRE_TURNSTILE === 'true') {
      return { ok: false, configured: false, error: 'turnstile_not_configured' };
    }
    return { ok: true, configured: false };
  }
  const headerToken = req.header('cf-turnstile-response') || '';
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const token = String(headerToken || body.turnstile_token || body['cf-turnstile-response'] || '').trim();
  if (!token) return { ok: false, configured: true, error: 'turnstile_token_required' };
  const url = process.env.TURNSTILE_VERIFY_URL || 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, ...(clientKey(req) !== 'unknown' ? { remoteip: clientKey(req) } : {}) }).toString(),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as { success?: boolean; 'error-codes'?: string[] } | null;
    if (response.ok && payload?.success === true) return { ok: true, configured: true };
    return { ok: false, configured: true, error: 'turnstile_failed' };
  } catch {
    return { ok: false, configured: true, error: 'turnstile_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}

interface MetricsState {
  requests: number;
  errors: number;
  rateLimited: number;
  totalDurationMs: number;
  byStatus: Map<string, number>;
  byRoute: Map<string, number>;
}

const metrics: MetricsState = {
  requests: 0,
  errors: 0,
  rateLimited: 0,
  totalDurationMs: 0,
  byStatus: new Map(),
  byRoute: new Map(),
};

function routeLabel(req: Request): string {
  const path = (req.originalUrl.split('?')[0] || '/').toLowerCase();
  const segments = path.split('/').filter(Boolean).slice(0, 3);
  return `/${segments.join('/')}`;
}

export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const started = Date.now();
  metrics.requests += 1;
  metrics.byRoute.set(routeLabel(req), (metrics.byRoute.get(routeLabel(req)) || 0) + 1);
  res.on('finish', () => {
    metrics.totalDurationMs += Date.now() - started;
    const status = `${Math.floor(res.statusCode / 100)}xx`;
    metrics.byStatus.set(status, (metrics.byStatus.get(status) || 0) + 1);
    if (res.statusCode >= 500) metrics.errors += 1;
    if (process.env.LOG_LEVEL !== 'silent') {
      // Structured single-line logs with the correlation id propagated by the
      // gateway. Tier-2 calls cannot forward it yet (SDK gap), so it is logged
      // locally for correlation.
      console.log(JSON.stringify({
        level: res.statusCode >= 500 ? 'error' : 'info',
        service: 'synapsecity',
        msg: 'request',
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        duration_ms: Date.now() - started,
        correlation_id: String(res.getHeader('x-correlation-id') || req.header('x-correlation-id') || ''),
      }));
    }
  });
  next();
}

export function renderMetrics(): string {
  const lines = [
    '# HELP synapsecity_http_requests_total Total HTTP requests handled by the City service.',
    '# TYPE synapsecity_http_requests_total counter',
    `synapsecity_http_requests_total ${metrics.requests}`,
    '# HELP synapsecity_http_errors_total Total 5xx responses.',
    '# TYPE synapsecity_http_errors_total counter',
    `synapsecity_http_errors_total ${metrics.errors}`,
    '# HELP synapsecity_rate_limited_total Total requests rejected by a rate limiter.',
    '# TYPE synapsecity_rate_limited_total counter',
    `synapsecity_rate_limited_total ${metrics.rateLimited}`,
    '# HELP synapsecity_http_request_duration_ms_sum Sum of request durations in milliseconds.',
    '# TYPE synapsecity_http_request_duration_ms_sum counter',
    `synapsecity_http_request_duration_ms_sum ${metrics.totalDurationMs}`,
  ];
  for (const [status, count] of metrics.byStatus) {
    lines.push(`synapsecity_http_responses_total{status="${status}"} ${count}`);
  }
  for (const [route, count] of metrics.byRoute) {
    lines.push(`synapsecity_http_route_requests_total{route="${route}"} ${count}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Test-only helpers for deterministic metrics assertions. */
export function resetMetrics(): void {
  metrics.requests = 0;
  metrics.errors = 0;
  metrics.rateLimited = 0;
  metrics.totalDurationMs = 0;
  metrics.byStatus.clear();
  metrics.byRoute.clear();
}
