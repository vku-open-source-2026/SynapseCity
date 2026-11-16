// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const upstream = (process.env.CITY_SERVICE_URL || 'http://city-service:8083').replace(/\/$/, '');
const consoleUpstream = (process.env.CONSOLE_URL || 'http://console:80').replace(/\/$/, '');

function assertUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`CITY_SERVICE_URL is not an absolute URL: ${value}`); }
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname)) throw new Error('CITY_SERVICE_URL may not point to localhost');
  return value.replace(/\/$/, '');
}
const UPSTREAM = assertUpstream(upstream);
const CONSOLE = assertUpstream(consoleUpstream);

// SynapseCity owns city/infrastructure namespaces only. Every other /v1 path
// belongs to another product (SynapseCitySOS owns emergency/hazards/sos) or is
// not part of the public contract. The gateway rejects them locally so a
// misrouted request can never reach the City service or its Tier-2 datasets.
const BOUNDARY_PRODUCT = 'synapsecity';
const OWNED_V1_PREFIXES: readonly string[] = [
  '/v1/city',
  '/v1/auth',
  '/v1/assets',
  '/v1/incidents',
  '/v1/maintenance',
  '/v1/preventive-maintenance',
  '/v1/iot',
  '/v1/alerts',
  '/v1/budgets',
  '/v1/reports',
  '/v1/notifications',
  '/v1/files',
  '/v1/users',
  '/v1/geofences',
  '/v1/geo',
  '/v1/ingest',
  '/v1/map',
  '/v1/ai',
  '/v1/public/assets',
  '/v1/public/incidents',
  '/v1/public/files',
];
const NOT_FOUND_BODY = { error: 'not_found', product: BOUNDARY_PRODUCT } as const;

function decodedPath(value: string): string | null {
  let current = value;
  for (let round = 0; round < 3; round += 1) {
    try {
      const decoded = decodeURIComponent(current);
      if (decoded === current) return current;
      current = decoded;
    } catch { return null; }
  }
  return current;
}

/**
 * Decode and canonicalize a request path while preserving the case of record
 * identifiers. `/v1` is lowercased only for ownership checks, never for the
 * upstream resource path.
 */
export function canonicalV1Path(raw: string): string | null {
  const withoutQuery = (raw.split('?')[0] || '/').split('#')[0];
  const decoded = decodedPath(withoutQuery);
  if (decoded === null) return null;
  const segments: string[] = [];
  for (const segment of decoded.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') { segments.pop(); continue; }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

// Canonicalize before the ownership check: decode percent escapes, resolve dot
// segments, collapse duplicate separators, lowercase and strip trailing
// slashes. This closes /v1/%65mergency, /v1/EMERGENCY, /v1/emergency/ and
// /v1/assets/../emergency style bypasses.
export function normalizeV1Path(raw: string): string {
  const canonical = canonicalV1Path(raw);
  if (canonical === null) return '/__invalid_path__';
  return `/${canonical.split('/').filter(Boolean).map((segment) => segment.toLowerCase()).join('/')}`;
}

function within(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

export function isOwnedV1Path(raw: string): boolean {
  const path = normalizeV1Path(raw);
  return OWNED_V1_PREFIXES.some((prefix) => within(path, prefix));
}

// Anonymous surface: health/readiness is outside /v1, and only the public
// projection, auth shell, product metadata, map tiles and the citizen AI
// assistant may be called without a City session. Every operator namespace is
// rejected here before proxying as defence in depth; the City service still
// verifies the session itself and rate-limits the public assistant.
const PUBLIC_V1_PREFIXES: readonly string[] = [
  '/v1/auth',
  '/v1/city',
  '/v1/map',
  '/v1/public/assets',
  '/v1/public/incidents',
  '/v1/public/files',
];
const PUBLIC_AI_PATHS = new Set(['/v1/ai/status', '/v1/ai/chat']);

export function isPublicV1Path(raw: string): boolean {
  const path = normalizeV1Path(raw);
  return PUBLIC_AI_PATHS.has(path) || PUBLIC_V1_PREFIXES.some((prefix) => within(path, prefix));
}

/**
 * Read an upstream response as raw bytes. `response.text()` must never be used
 * for proxying: it decodes binary payloads (PNG/PDF/octet-stream) as UTF-8 and
 * corrupts them.
 */
export async function proxyResponseBody(response: Awaited<ReturnType<typeof fetch>>): Promise<Buffer> {
  if (response.status === 204 || response.status === 304) return Buffer.alloc(0);
  return Buffer.from(await response.arrayBuffer());
}

app.disable('x-powered-by');
// Binary uploads cannot be represented as JSON. Parse them as raw bytes before
// the JSON parser so a PNG/PDF reaches the City service byte-for-byte, even if
// the file's content type happens to be application/json.
const rawUpload = express.raw({ type: () => true, limit: Number(process.env.GATEWAY_UPLOAD_LIMIT_BYTES || 26 * 1024 * 1024) });
app.use((req, res, next) => {
  const path = normalizeV1Path(req.originalUrl);
  const isUpload = path === '/v1/files/upload'
    || path === '/v1/public/files'
    || /^\/v1\/files\/[^/]+\/content$/.test(path);
  if (!isUpload || (req as Request & { _body?: boolean })._body) return next();
  return rawUpload(req, res, next);
});
app.use(express.json({ limit: '10mb' }));
const CORRELATION_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || 'https://synapsecity.sbs');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  if (req.method === 'OPTIONS') return res.status(204).end();
  // Never echo an unsanitized client correlation id into response headers/logs.
  const incoming = req.header('x-correlation-id');
  res.setHeader('x-correlation-id', incoming && CORRELATION_ID_RE.test(incoming) ? incoming : randomUUID());
  next();
});

async function proxy(req: Request, res: Response): Promise<void> {
  const method = req.method.toUpperCase();
  const rawBody = Buffer.isBuffer(req.body);
  const headers: Record<string, string> = {
    'content-type': rawBody ? String(req.header('content-type') || 'application/octet-stream') : 'application/json',
    'x-correlation-id': res.getHeader('x-correlation-id')?.toString() || randomUUID(),
  };
  for (const name of [
    'authorization', 'x-api-key', 'x-correlation-id',
    'x-file-name', 'x-filename', 'x-checksum-sha256', 'x-file-visibility',
    'x-entity-type', 'x-entity-id', 'x-request-id',
  ]) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  // Preserve the client address so the City rate limiter keys on the caller,
  // not on the gateway.
  headers['x-forwarded-for'] = req.header('x-forwarded-for') || req.ip || '';
  if (!headers['x-forwarded-for']) delete headers['x-forwarded-for'];
  const response = await fetch(`${UPSTREAM}${req.originalUrl}`, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD'
      ? undefined
      : rawBody
        ? (req.body as unknown as BodyInit)
        : JSON.stringify(req.body ?? {}),
  });
  const type = response.headers.get('content-type');
  res.status(response.status);
  if (type) res.setHeader('content-type', type);
  // Pagination and download metadata are part of the City contract. Forward the
  // upstream headers instead of dropping them at the public edge.
  for (const name of ['cache-control', 'x-total-count', 'etag', 'x-dataset-version', 'content-disposition']) {
    const value = response.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  if (response.status === 204 || response.status === 304) {
    res.end();
    return;
  }
  // Read the upstream body as bytes. Using response.text() corrupts binary
  // payloads such as VietMap PNG tiles (0x89 becomes the UTF-8 replacement
  // character and the image no longer decodes).
  const body = await proxyResponseBody(response);
  res.setHeader('content-length', String(body.length));
  res.end(body);
}

async function health(path: string, res: Response): Promise<void> {
  try {
    const response = await fetch(`${UPSTREAM}${path}`);
    const text = await response.text();
    const upstreamBody = JSON.parse(text);
    res.status(response.ok ? 200 : 503).json({ status: response.ok ? (path === '/ready' ? 'ready' : 'ok') : 'degraded', service: 'synapsecity-gateway', upstream: upstreamBody });
  } catch (error) { res.status(503).json({ status: 'degraded', service: 'synapsecity-gateway', error: (error as Error).message }); }
}
app.get('/health', (_req, res) => { health('/health', res).catch(() => undefined); });
app.get('/ready', (_req, res) => { health('/ready', res).catch(() => undefined); });
app.use((req, res, next) => {
  const path = normalizeV1Path(req.originalUrl);
  if (path === '/__invalid_path__') {
    // A malformed percent escape must never fall through to the SPA either.
    return res.status(404).json(NOT_FOUND_BODY);
  }
  if (path !== '/v1' && !path.startsWith('/v1/')) return next();
  if (!isOwnedV1Path(req.originalUrl)) {
    // Foreign or unknown namespace: answer at the edge, never call the upstream.
    return res.status(404).json(NOT_FOUND_BODY);
  }
  // An encoded /v1 prefix (for example /%76%31/assets) is an API path written
  // in an ambiguous spelling. Reject it with JSON instead of proxying or, worse,
  // letting the SPA fallback answer with index.html.
  const rawPath = (req.originalUrl.split('?')[0] || '/');
  if (!/^\/v1(\/|$)/i.test(rawPath) && /^\/v1(\/|$)/i.test(path)) {
    return res.status(404).json(NOT_FOUND_BODY);
  }
  // Canonicalize duplicated separators and non-prefix escapes before the /v1
  // mount so owned paths cannot miss the proxy and reach the console.
  const canonical = canonicalV1Path(req.originalUrl);
  if (canonical) {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    const rewritten = `${canonical}${query}`;
    if (rewritten !== req.originalUrl) {
      req.url = rewritten;
      req.originalUrl = rewritten;
    }
  }
  if (!isPublicV1Path(req.originalUrl) && !req.header('authorization')) {
    return res.status(401).json({ error: 'unauthorized', detail: 'authentication_required', product: BOUNDARY_PRODUCT });
  }
  next();
});
app.use('/v1', (req, res, next) => { proxy(req, res).catch(next); });
app.use(async (req, res, next) => {
  if (!['GET', 'HEAD'].includes(req.method.toUpperCase())) return next();
  // Defence in depth: no decoded /v1 spelling may ever receive the console
  // index.html, even if a future middleware ordering change misses the guard.
  const decoded = canonicalV1Path(req.originalUrl);
  if (decoded && /^\/v1(\/|$)/i.test(decoded)) return res.status(404).json(NOT_FOUND_BODY);
  try {
    const response = await fetch(`${CONSOLE}${req.originalUrl}`, { method: req.method, headers: { accept: req.header('accept') || 'text/html' } });
    res.status(response.status);
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('content-type', contentType);
    res.send(await response.text());
  } catch (error) { next(error); }
});
app.use((error: Error, _req: Request, res: Response, _next: unknown) => res.status(502).json({ error: 'city_upstream_unavailable', message: error.message }));

if (require.main === module) app.listen(PORT, () => console.log(`[synapsecity-gateway] listening on :${PORT}; upstream=${UPSTREAM}; console=${CONSOLE}`));
export { app };
