import express, { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';

const app = express();
const PORT = Number(process.env.PORT || 8080);
const upstream = (process.env.CITY_SERVICE_URL || 'http://city-service:8083').replace(/\/$/, '');

function assertUpstream(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`CITY_SERVICE_URL is not an absolute URL: ${value}`); }
  if (/^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname)) throw new Error('CITY_SERVICE_URL may not point to localhost');
  return value.replace(/\/$/, '');
}
const UPSTREAM = assertUpstream(upstream);

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || '*');
  res.setHeader('access-control-allow-headers', 'authorization,content-type,x-api-key,x-correlation-id');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  res.setHeader('x-correlation-id', req.header('x-correlation-id') || randomUUID());
  next();
});

async function proxy(req: Request, res: Response): Promise<void> {
  const method = req.method.toUpperCase();
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-correlation-id': res.getHeader('x-correlation-id')?.toString() || randomUUID() };
  for (const name of ['authorization', 'x-api-key', 'x-correlation-id']) {
    const value = req.header(name);
    if (value) headers[name] = value;
  }
  const response = await fetch(`${UPSTREAM}${req.originalUrl}`, {
    method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : JSON.stringify(req.body ?? {}),
  });
  const text = await response.text();
  res.status(response.status);
  const type = response.headers.get('content-type');
  if (type) res.setHeader('content-type', type);
  res.send(text);
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
app.use('/v1', (req, res, next) => { proxy(req, res).catch(next); });
app.use((error: Error, _req: Request, res: Response, _next: unknown) => res.status(502).json({ error: 'city_upstream_unavailable', message: error.message }));

if (require.main === module) app.listen(PORT, () => console.log(`[synapsecity-gateway] listening on :${PORT}; upstream=${UPSTREAM}`));
export { app };
