// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

/**
 * In-process mock of the Tier-2 capabilities API for City tests.
 *
 * It records every write so tests can assert the exact payload Tier-2 would
 * ingest into SynapseLDS (for example that no reporter PII is present), and it
 * implements the files, notifications, auth and geo contracts the City adapter
 * calls. Behaviour flags (`ai.available`, `files.available`,
 * `notifications.available`) let tests assert the honest degraded path.
 */
export interface MockTier2Write {
  method: string;
  path: string;
  body: unknown;
}

export interface MockFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  checksumSha256?: string;
  owner: string;
  public?: boolean;
  bytes: Buffer;
}

export interface MockNotificationSend {
  channel: string;
  recipient: unknown;
  template?: string;
  variables?: unknown;
  idempotencyKey?: string;
  data?: unknown;
}

export interface MockTier2 {
  server: Server;
  url: string;
  datasets: Map<string, Record<string, unknown>>;
  records: Map<string, Map<string, Record<string, unknown>>>;
  createRequests: Array<{ datasetId: string; id?: string; publish?: boolean; data: Record<string, unknown> }>;
  writes: MockTier2Write[];
  files: Map<string, MockFile>;
  notifications: {
    available: boolean;
    templates: Map<string, Record<string, unknown>>;
    sends: MockNotificationSend[];
    preferences: Map<string, Record<string, unknown>>;
    status: Map<string, Record<string, unknown>>;
  };
  auth: {
    available: boolean;
    sessions: Map<string, { email: string; password: string; user: Record<string, unknown> }>;
    exchanges: Array<Record<string, unknown>>;
    refusedExchange: boolean;
  };
  geo: { available: boolean; results: Array<Record<string, unknown>> };
  approvals: Map<string, Record<string, any>>;
  /** Controls the AI capability contract exposed by the mock. */
  ai: { available: boolean; reply: string };
  seed: (datasetId: string, id: string, data: Record<string, unknown>) => void;
  close: () => Promise<void>;
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(body === null || body === undefined ? '' : JSON.stringify(body));
}

function sendBytes(res: ServerResponse, status: number, bytes: Buffer, contentType: string, checksum?: string): void {
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', String(bytes.length));
  if (checksum) res.setHeader('x-checksum-sha256', checksum);
  res.end(bytes);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function startMockTier2(): Promise<MockTier2> {
  const datasets = new Map<string, Record<string, unknown>>();
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  const createRequests: MockTier2['createRequests'] = [];
  const writes: MockTier2Write[] = [];
  const ai = { available: false, reply: 'Asset ASSET-1 is in good condition.' };
  const files = new Map<string, MockFile>();
  const notifications = {
    available: true,
    templates: new Map<string, Record<string, unknown>>(),
    sends: [] as MockNotificationSend[],
    preferences: new Map<string, Record<string, unknown>>(),
    status: new Map<string, Record<string, unknown>>(),
  };
  const auth = {
    available: true,
    sessions: new Map<string, { email: string; password: string; user: Record<string, unknown> }>(),
    exchanges: [] as Array<Record<string, unknown>>,
    refusedExchange: false,
  };
  const geo = { available: true, results: [] as Array<Record<string, unknown>> };
  const approvals = new Map<string, Record<string, any>>();

  const recordsFor = (datasetId: string): Map<string, Record<string, unknown>> => {
    if (!records.has(datasetId)) records.set(datasetId, new Map());
    return records.get(datasetId) as Map<string, Record<string, unknown>>;
  };

  function issueAuthSession(email: string, password: string): Record<string, unknown> {
    const id = `user-${email.split('@')[0].replace(/[^a-z0-9_-]/gi, '-')}`;
    const accessToken = `tier2-access-${randomUUID()}`;
    const refreshToken = `tier2-refresh-${randomUUID()}`;
    const user = { id, email, display_name: email.split('@')[0] };
    auth.sessions.set(refreshToken, { email, password, user });
    return { accessToken, refreshToken, expiresIn: 3600, user };
  }

  const server = http.createServer(async (req, res) => {
    const raw = await readRaw(req);
    let body: any = null;
    try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
    const url = new URL(req.url || '/', 'http://fake');
    const path = url.pathname;
    if (req.method !== 'GET') writes.push({ method: req.method || 'GET', path, body: Buffer.isBuffer(raw) && !body ? '<binary>' : body });

    if (path === '/health' || path === '/v1/capabilities/health') {
      return send(res, 200, {
        status: 'ok',
        service: 'fake-tier2',
        tier: 2,
        dependencies: [{ name: 'base', status: 'ok', critical: true, latency_ms: 1 }],
      });
    }

    // ---- HITL approvals (#30) ----
    if (path === '/v1/capabilities/approvals' && req.method === 'POST') {
      const id = String(body?.id || randomUUID());
      const now = new Date().toISOString();
      const approval = {
        id, tenant: 'demo', title: String(body?.title || 'Approval'), module: String(body?.module || ''),
        action: String(body?.action || ''), entityType: body?.entityType, entityId: body?.entityId,
        payload: body?.payload, requester: String(body?.requester || 'city-user'),
        approverRoles: Array.isArray(body?.approverRoles) ? body.approverRoles : [],
        requiredApprovals: Number(body?.requiredApprovals || 1), status: 'pending', decisions: [],
        dueAt: body?.dueAt, createdAt: now, updatedAt: now,
      };
      approvals.set(id, approval);
      return send(res, 201, { approval });
    }
    if (path === '/v1/capabilities/approvals' && req.method === 'GET') {
      const items = [...approvals.values()].filter((item) => !url.searchParams.get('status') || item.status === url.searchParams.get('status'));
      return send(res, 200, { items, total: items.length });
    }
    const approvalMatch = path.match(/^\/v1\/capabilities\/approvals\/([^/]+)$/);
    if (approvalMatch && req.method === 'GET') {
      const item = approvals.get(approvalMatch[1]);
      return item ? send(res, 200, { approval: item }) : send(res, 404, { error: { code: 'approval_not_found' } });
    }
    const decideMatch = path.match(/^\/v1\/capabilities\/approvals\/([^/]+)\/decide$/);
    if (decideMatch && req.method === 'POST') {
      const item = approvals.get(decideMatch[1]);
      if (!item) return send(res, 404, { error: { code: 'approval_not_found' } });
      if (item.status !== 'pending') return send(res, 409, { error: { code: 'approval_not_pending' } });
      const decision = String(body?.decision || '');
      if (!['approve', 'reject'].includes(decision)) return send(res, 400, { error: { code: 'invalid_request' } });
      item.decisions.push({ actor: String(body?.actor || 'approver'), decision, note: body?.note, at: new Date().toISOString() });
      item.status = decision === 'approve' ? 'approved' : 'rejected';
      item.updatedAt = new Date().toISOString();
      approvals.set(item.id, item);
      return send(res, 200, { approval: item });
    }

    // ---- auth ----
    if (path === '/v1/capabilities/auth/login' && req.method === 'POST') {
      if (!auth.available) return send(res, 503, { error: { code: 'authentication_unavailable' } });
      const email = String(body?.email || '').toLowerCase();
      const password = String(body?.password || '');
      if (!email || !password) return send(res, 400, { error: { code: 'field_required' } });
      return send(res, 200, issueAuthSession(email, password));
    }
    if (path === '/v1/capabilities/auth/register' && req.method === 'POST') {
      if (!auth.available) return send(res, 503, { error: { code: 'authentication_unavailable' } });
      const email = String(body?.email || '').toLowerCase();
      if (!email) return send(res, 400, { error: { code: 'field_required' } });
      return send(res, 201, issueAuthSession(email, String(body?.password || '')));
    }
    if (path === '/v1/capabilities/auth/refresh' && req.method === 'POST') {
      const token = String(body?.refreshToken || '');
      const session = auth.sessions.get(token);
      if (!session) return send(res, 401, { error: { code: 'invalid_credentials' } });
      auth.sessions.delete(token);
      return send(res, 200, issueAuthSession(session.email, session.password));
    }
    if (path === '/v1/capabilities/auth/logout' && req.method === 'POST') {
      auth.sessions.delete(String(body?.refreshToken || ''));
      return send(res, 200, { ok: true });
    }
    if (path === '/v1/capabilities/auth/exchange' && req.method === 'POST') {
      if (auth.refusedExchange) return send(res, 403, { error: { code: 'exchange_forbidden' } });
      const userId = String(body?.userId || '');
      if (!userId) return send(res, 400, { error: { code: 'field_required' } });
      auth.exchanges.push({ ...(body || {}) });
      return send(res, 201, {
        accessToken: `tier2-delegated-${randomUUID()}`,
        expiresIn: 1800,
        tokenType: 'Bearer',
        delegated: true,
        userId,
        orgId: 'org-city',
        accountId: 'account-city',
        scopes: Array.isArray(body?.scopes) ? body.scopes : [],
        audience: body?.audience,
      });
    }
    if (path === '/v1/capabilities/auth/me' && req.method === 'GET') {
      return send(res, 200, { id: 'user-current', email: 'operator@city.test' });
    }
    if (path === '/v1/capabilities/auth/password/change' && req.method === 'POST') {
      return send(res, 200, { ok: true, revokedSessions: 1 });
    }
    if (path.startsWith('/v1/capabilities/auth/')) {
      return send(res, 404, { error: { code: 'route_not_found' } });
    }

    if (path === '/v1/capabilities/ai/status' && ai.available) {
      return send(res, 200, { capability: 'ai', status: 'ok', dependency: 'synapseone-inference', upstream: { status: 'ok' } });
    }
    if (path === '/v1/capabilities/ai/chat' && ai.available) {
      return send(res, 200, { model: 'fake-model', choices: [{ message: { role: 'assistant', content: ai.reply } }] });
    }
    if (path.startsWith('/v1/capabilities/ai/')) {
      return send(res, 404, { error: { code: 'route_not_found' } });
    }

    // ---- geo ----
    if (path.startsWith('/v1/capabilities/geo/')) {
      if (!geo.available) return send(res, 503, { error: { code: 'geocoder_unavailable', message: 'SYNAPSEDX_GEOCODER_BASE_URL is not configured' } });
      if (path === '/v1/capabilities/geo/autocomplete') return send(res, 200, { items: geo.results });
      if (path === '/v1/capabilities/geo/geocode') return send(res, 200, { items: geo.results });
      if (path === '/v1/capabilities/geo/reverse') return send(res, 200, { items: geo.results });
      if (path === '/v1/capabilities/geo/place') return send(res, 200, { result: geo.results[0] || null });
      return send(res, 404, { error: { code: 'route_not_found' } });
    }

    // ---- notifications ----
    if (path.startsWith('/v1/capabilities/notifications')) {
      if (!notifications.available) return send(res, 503, { error: { code: 'notification_delivery_unavailable' } });
      const parts = path.split('/').filter(Boolean);
      if (parts[3] === 'templates') {
        const templateId = parts[4] ? decodeURIComponent(parts[4]) : '';
        if (!templateId && req.method === 'GET') return send(res, 200, { items: Array.from(notifications.templates.values()), total: notifications.templates.size, nextCursor: null });
        if (!templateId && req.method === 'POST') {
          const id = String(body?.id || `tpl-${randomUUID()}`);
          if (notifications.templates.has(id)) return send(res, 409, { error: { code: 'template_invalid' } });
          const template = { ...(body || {}), id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
          notifications.templates.set(id, template);
          return send(res, 201, template);
        }
        const template = notifications.templates.get(templateId);
        if (!template) return send(res, 404, { error: { code: 'template_not_found' } });
        if (req.method === 'GET') return send(res, 200, template);
        if (req.method === 'PATCH') {
          const updated = { ...template, ...(body || {}), id: templateId };
          notifications.templates.set(templateId, updated);
          return send(res, 200, updated);
        }
        if (req.method === 'DELETE') { notifications.templates.delete(templateId); return send(res, 204, null); }
      }
      if (parts[3] === 'preferences' && parts[4]) {
        const recipient = decodeURIComponent(parts[4]);
        if (req.method === 'GET') {
          return send(res, 200, notifications.preferences.get(recipient) || { recipient, channels: [], unsubscribed: false });
        }
        if (req.method === 'PUT') {
          const preference = { recipient, channels: body?.channels || [], unsubscribed: Boolean(body?.unsubscribed) };
          notifications.preferences.set(recipient, preference);
          return send(res, 200, preference);
        }
      }
      if (parts[3] === 'unsubscribe' && req.method === 'POST') {
        const recipient = String(body?.recipient || '');
        const preference = { recipient, channels: [], unsubscribed: true };
        notifications.preferences.set(recipient, preference);
        return send(res, 200, preference);
      }
      if (parts[3] === 'send' && req.method === 'POST') {
        const channels: string[] = Array.isArray(body?.channels) ? body.channels.map(String) : body?.channel ? [String(body.channel)] : [];
        const sent = channels.map((channel) => {
          const id = `notif-${randomUUID()}`;
          const record = {
            id, channel, status: 'queued', recipient: body?.recipient,
            subject: body?.subject, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          };
          notifications.status.set(id, record);
          notifications.sends.push({
            channel,
            recipient: body?.recipient,
            ...(body?.template ? { template: String(body.template) } : {}),
            ...(body?.variables ? { variables: body.variables } : {}),
            ...(body?.idempotencyKey ? { idempotencyKey: String(body.idempotencyKey) } : {}),
            ...(body?.data ? { data: body.data } : {}),
          });
          return record;
        });
        return send(res, 202, { notifications: sent, requested: channels.length });
      }
      if (parts[3] && req.method === 'GET') {
        const record = notifications.status.get(decodeURIComponent(parts[3]));
        return record ? send(res, 200, record) : send(res, 404, { error: { code: 'notification_not_found' } });
      }
      if (parts[3] && parts[4] === 'cancel' && req.method === 'POST') {
        const id = decodeURIComponent(parts[3]);
        const record = notifications.status.get(id);
        if (!record) return send(res, 404, { error: { code: 'notification_not_found' } });
        const updated = { ...record, status: 'cancelled' };
        notifications.status.set(id, updated);
        return send(res, 200, updated);
      }
      if (req.method === 'GET') return send(res, 200, { items: Array.from(notifications.status.values()), count: notifications.status.size });
    }

    // ---- files ----
    if (path.startsWith('/v1/capabilities/files')) {
      const parts = path.split('/').filter(Boolean);
      const fileId = parts[3] ? decodeURIComponent(parts[3]) : '';
      if (!fileId && req.method === 'GET') {
        const items = Array.from(files.values()).map((file) => fileView(file));
        return send(res, 200, { items, total: items.length, limit: 100, offset: 0 });
      }
      if (parts[3] === 'quota' && req.method === 'GET') {
        const used = Array.from(files.values()).reduce((total, file) => total + file.size, 0);
        return send(res, 200, { usedBytes: used, quotaBytes: 1024 * 1024 * 1024, remainingBytes: 1024 * 1024 * 1024 - used, files: files.size, maxFileBytes: 25 * 1024 * 1024, allowedTypes: [] });
      }
      if (!fileId && req.method === 'POST') {
        if (!body?.filename) return send(res, 400, { error: { code: 'field_required' } });
        const id = String(body.id || randomUUID());
        if (files.has(id)) return send(res, 409, { error: { code: 'file_already_exists' } });
        const file: MockFile = {
          id, filename: String(body.filename), contentType: String(body.contentType || 'application/octet-stream'),
          size: Number(body.size || 0), owner: 'tenant', bytes: Buffer.alloc(0),
          ...(body.checksumSha256 ? { checksumSha256: String(body.checksumSha256) } : {}),
        };
        files.set(id, file);
        return send(res, 201, {
          ...fileView(file),
          upload: {
            method: 'PUT',
            url: `/v1/capabilities/files/${id}/content`,
            contentType: file.contentType,
            ...(file.checksumSha256 ? { checksumSha256: file.checksumSha256 } : {}),
          },
        });
      }
      const file = files.get(fileId);
      if (fileId && !file) return send(res, 404, { error: { code: 'file_not_found' } });
      if (parts[4] === 'content' && req.method === 'PUT') {
        const checksum = sha256(raw);
        const expected = String(req.headers['x-checksum-sha256'] || '');
        if (expected && expected !== checksum) return send(res, 400, { error: { code: 'invalid_request', message: 'checksum mismatch' } });
        file!.bytes = raw;
        file!.size = raw.length;
        file!.checksumSha256 = checksum;
        return send(res, 200, fileView(file!));
      }
      if (parts[4] === 'content' && req.method === 'GET') {
        return sendBytes(res, 200, file!.bytes, file!.contentType, file!.checksumSha256);
      }
      if (parts[4] === 'presign' && req.method === 'POST') {
        return send(res, 501, { error: { code: 'presign_unsupported' } });
      }
      if (parts[4] === 'complete' && req.method === 'POST') {
        if (!file!.bytes.length) return send(res, 409, { error: { code: 'upload_incomplete' } });
        return send(res, 200, fileView(file!));
      }
      if (req.method === 'GET') return send(res, 200, fileView(file!));
      if (req.method === 'DELETE') { files.delete(fileId); return send(res, 204, null); }
      return send(res, 404, { error: { code: 'route_not_found' } });
    }

    const parts = path.split('/').filter(Boolean);
    if (parts[0] === 'v1' && parts[1] === 'capabilities' && parts[2] === 'datasets') {
      const datasetId = decodeURIComponent(parts[3] || '');
      if (parts.length === 4 && req.method === 'GET') {
        const dataset = datasets.get(datasetId);
        return dataset ? send(res, 200, dataset) : send(res, 404, { error: 'dataset_not_found' });
      }
      if (parts.length === 4 && req.method === 'PATCH') {
        const dataset = datasets.get(datasetId);
        if (!dataset) return send(res, 404, { error: 'dataset_not_found' });
        const updated = { ...dataset, ...(body as Record<string, unknown>) };
        datasets.set(datasetId, updated);
        return send(res, 200, updated);
      }
      if (parts.length === 3 && req.method === 'POST') {
        const input = (body || {}) as Record<string, unknown>;
        const id = String(input.slug || '');
        const dataset = { ...input, id, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        datasets.set(id, dataset);
        return send(res, 201, dataset);
      }
      if (parts.length === 5 && parts[4] === 'publish' && req.method === 'POST') {
        const dataset = datasets.get(datasetId) || { id: datasetId };
        datasets.set(datasetId, { ...dataset, status: 'published' });
        return send(res, 200, datasets.get(datasetId));
      }
      if (parts.length === 5 && parts[4] === 'revoke' && req.method === 'POST') {
        const dataset = datasets.get(datasetId) || { id: datasetId };
        datasets.set(datasetId, { ...dataset, status: 'revoked' });
        return send(res, 200, datasets.get(datasetId));
      }
      if (parts.length === 5 && parts[4] === 'entities' && req.method === 'GET') {
        return send(res, 200, Array.from(recordsFor(datasetId).values()));
      }
      if (parts.length === 5 && parts[4] === 'records' && req.method === 'GET') {
        const items = Array.from(recordsFor(datasetId).entries()).map(([id, data]) => ({ id, data }));
        const limit = Number(url.searchParams.get('limit') || 100);
        const offset = Number(url.searchParams.get('offset') || 0);
        return send(res, 200, { items: items.slice(offset, offset + limit), total: items.length, limit, offset });
      }
      if (parts.length === 5 && parts[4] === 'records' && req.method === 'POST') {
        const input = (body || {}) as { id?: string; data?: Record<string, unknown>; publish?: boolean };
        const id = String(input.id || `record-${recordsFor(datasetId).size + 1}`);
        if (recordsFor(datasetId).has(id)) return send(res, 409, { error: 'record_exists' });
        const data = { ...(input.data || {}), id };
        recordsFor(datasetId).set(id, data);
        createRequests.push({ datasetId, id, publish: input.publish, data });
        return send(res, 201, { id, data });
      }
      if (parts.length === 6 && parts[4] === 'records' && req.method === 'GET') {
        const recordId = decodeURIComponent(parts[5]);
        const data = recordsFor(datasetId).get(recordId);
        return data ? send(res, 200, { id: recordId, data }) : send(res, 404, { error: 'record_not_found' });
      }
      if (parts.length === 6 && parts[4] === 'records' && req.method === 'PATCH') {
        const recordId = decodeURIComponent(parts[5]);
        const input = (body || {}) as { data?: Record<string, unknown> };
        const data = { ...(input.data || {}), id: recordId };
        recordsFor(datasetId).set(recordId, data);
        return send(res, 200, { id: recordId, data });
      }
      if (parts.length === 6 && parts[4] === 'records' && req.method === 'DELETE') {
        recordsFor(datasetId).delete(decodeURIComponent(parts[5]));
        return send(res, 204, null);
      }
    }
    return send(res, 404, { error: 'not_found' });
  });

  function fileView(file: MockFile): Record<string, unknown> {
    return {
      id: file.id,
      filename: file.filename,
      contentType: file.contentType,
      size: file.size,
      owner: file.owner,
      ...(file.checksumSha256 ? { checksumSha256: file.checksumSha256 } : {}),
      downloadUrl: `/v1/capabilities/files/${file.id}/content`,
    };
  }

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    server,
    url,
    datasets,
    records,
    createRequests,
    writes,
    files,
    notifications,
    auth,
    geo,
    approvals,
    ai,
    seed: (datasetId, id, data) => { recordsFor(datasetId).set(id, { ...data, id }); },
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}
