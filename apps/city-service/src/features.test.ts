// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startMockTier2, type MockTier2 } from './mock-tier2';

process.env.ALLOW_LOCAL_DEPENDENCIES = 'true';
process.env.AUTH_SECRET = 'city-features-test-secret';
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';

let tier2: MockTier2;
let server: Server;
let baseUrl: string;
let adminToken: string;
let technicianToken: string;
let otherToken: string;

async function request(path: string, init: RequestInit = {}): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, init);
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function json(method: string, body?: unknown, token?: string): RequestInit {
  return {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

let auth: typeof import('./auth');

before(async () => {
  tier2 = await startMockTier2();
  process.env.SYNAPSEDX_BASE_URL = tier2.url;

  const now = Date.now();
  tier2.seed('city-assets', 'asset-1', {
    id: 'asset-1', asset_code: 'ASSET-1', name: 'Lamp', feature_type: 'street_light', feature_code: 'den_duong',
    status: 'active', geometry: { type: 'Point', coordinates: [105.8, 21.0] },
    preventive_maintenance_plan: {
      id: 'plan-1', asset_id: 'asset-1', cycle_days: 180, warning_days: 7,
      next_maintenance_date: new Date(now - 2 * 86_400_000).toISOString(),
      responsible_team: 'Team A',
    },
  });
  tier2.seed('city-assets', 'asset-2', {
    id: 'asset-2', asset_code: 'ASSET-2', name: 'Signal', feature_type: 'traffic_signal', feature_code: 'den_giao_thong',
    status: 'active', geometry: { type: 'Point', coordinates: [105.81, 21.01] },
    preventive_maintenance_plan: {
      id: 'plan-2', asset_id: 'asset-2', cycle_days: 90, warning_days: 7,
      next_maintenance_date: new Date(now + 30 * 86_400_000).toISOString(),
    },
  });
  tier2.seed('city-maintenance', 'wo-overdue', {
    id: 'wo-overdue', asset_id: 'asset-1', title: 'Overdue preventive', type: 'preventive', status: 'scheduled',
    scheduled_date: new Date(now - 3 * 86_400_000).toISOString(), plan_id: 'plan-1', assigned_to: 'technician-user',
  });
  tier2.seed('city-maintenance', 'wo-due-soon', {
    id: 'wo-due-soon', asset_id: 'asset-1', title: 'Due soon preventive', type: 'preventive', status: 'scheduled',
    scheduled_date: new Date(now + 2 * 86_400_000).toISOString(), assigned_to: 'technician-user',
  });
  tier2.seed('city-maintenance', 'wo-completed', {
    id: 'wo-completed', asset_id: 'asset-1', title: 'Completed preventive', type: 'preventive', status: 'completed',
    scheduled_date: new Date(now - 30 * 86_400_000).toISOString(), completed_at: new Date(now - 30 * 86_400_000).toISOString(),
  });
  tier2.seed('city-maintenance', 'wo-corrective', {
    id: 'wo-corrective', asset_id: 'asset-1', title: 'Corrective repair', type: 'corrective', status: 'scheduled',
    scheduled_date: new Date(now - 1 * 86_400_000).toISOString(),
  });

  tier2.seed('city-iot-sensors', 'sensor-1', {
    id: 'sensor-1', sensor_code: 'S1', asset_id: 'asset-1', sensor_type: 'temperature',
    measurement_unit: 'C', status: 'active', last_seen: new Date(now).toISOString(),
  });
  tier2.seed('city-iot-sensors', 'sensor-2', { id: 'sensor-2', sensor_code: 'S2', asset_id: 'asset-2', sensor_type: 'humidity', status: 'active' });
  tier2.seed('city-iot-sensors', 'sensor-3', {
    id: 'sensor-3', sensor_code: 'S3', asset_id: 'asset-2', sensor_type: 'pressure', status: 'active',
    last_seen: new Date(now - 3 * 3_600_000).toISOString(),
  });
  tier2.seed('city-iot-sensors', 'sensor-4', { id: 'sensor-4', sensor_code: 'S4', asset_id: 'asset-2', sensor_type: 'flow', status: 'active' });
  tier2.seed('city-iot-readings', 'r1', { id: 'r1', sensor_id: 'sensor-1', asset_id: 'asset-1', timestamp: new Date(now).toISOString(), value: 10 });
  tier2.seed('city-iot-readings', 'r2', { id: 'r2', sensor_id: 'sensor-1', asset_id: 'asset-1', timestamp: new Date(now - 3_600_000).toISOString(), value: 20 });
  tier2.seed('city-iot-readings', 'r3', { id: 'r3', sensor_id: 'sensor-2', asset_id: 'asset-2', timestamp: new Date(now).toISOString(), value: 99 });
  tier2.seed('city-iot-readings', 'r4', { id: 'r4', sensor_id: 'sensor-1', asset_id: 'asset-1', timestamp: new Date(now - 48 * 3_600_000).toISOString(), value: 30 });

  tier2.seed('city-incidents', 'inc-1', {
    id: 'inc-1', incident_number: 'INC-2026-000001', incident_code: 'INC-2026-000001', title: 'Broken lamp',
    description: 'dark', category: 'malfunction', severity: 'medium', status: 'open', asset_id: 'asset-1',
    reported_at: new Date(now).toISOString(), created_at: new Date(now).toISOString(),
    assigned_to: 'technician-user',
  });
  tier2.seed('city-incidents', 'inc-2', {
    id: 'inc-2', incident_number: 'INC-2026-000002', incident_code: 'INC-2026-000002', title: 'Resolved lamp',
    description: 'fixed', category: 'malfunction', severity: 'low', status: 'resolved', asset_id: 'asset-1',
    reported_at: new Date(now).toISOString(), created_at: new Date(now).toISOString(),
  });

  auth = await import('./auth');
  const tokenFor = (role: 'admin' | 'technician' | 'citizen', username: string) => auth.signToken({
    sub: `user-${username}`, username, email: `${username}@example.com`, full_name: username,
    role, permissions: auth.permissionsForRole(role), typ: 'access',
  });
  adminToken = tokenFor('admin', 'admin');
  technicianToken = tokenFor('technician', 'technician-user');
  otherToken = tokenFor('technician', 'other-technician');

  const service = await import('./server');
  server = service.createServer().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (tier2) await tier2.close();
});

test('preventive tasks are derived from the plan and preventive work orders', async () => {
  const tasks = await request('/v1/assets/asset-1/preventive-maintenance/tasks', json('GET', undefined, adminToken));
  assert.equal(tasks.status, 200);
  const ids = (tasks.body as Array<{ work_order_id?: string; source: string }>).map((task) => task.work_order_id || task.source);
  assert.ok(ids.includes('wo-overdue'));
  assert.ok(ids.includes('wo-due-soon'));
  assert.equal(ids.includes('wo-completed'), false, 'completed preventive work must not appear as a task');
  assert.equal(ids.includes('wo-corrective'), false, 'corrective work is not preventive');

  const overdue = await request('/v1/assets/asset-1/preventive-maintenance/overdue', json('GET', undefined, adminToken));
  assert.equal(overdue.status, 200);
  assert.ok(overdue.body.length >= 1);
  assert.ok(overdue.body.every((task: { status: string }) => task.status === 'overdue'));
  assert.ok(overdue.body.some((task: { work_order_id: string }) => task.work_order_id === 'wo-overdue'));

  const upcoming = await request('/v1/assets/asset-1/preventive-maintenance/upcoming', json('GET', undefined, adminToken));
  assert.equal(upcoming.status, 200);
  assert.ok(upcoming.body.every((task: { status: string }) => task.status !== 'overdue'));
  assert.ok(upcoming.body.some((task: { work_order_id: string }) => task.work_order_id === 'wo-due-soon'));

  const futurePlan = await request('/v1/assets/asset-2/preventive-maintenance/tasks', json('GET', undefined, adminToken));
  assert.equal(futurePlan.status, 200);
  assert.equal(futurePlan.body[0].source, 'plan');
  assert.equal(futurePlan.body[0].status, 'upcoming');

  assert.equal((await request('/v1/assets/asset-1/preventive-maintenance/nope', json('GET', undefined, adminToken))).status, 404);
});

test('IoT readings are scoped to the sensor and the requested window', async () => {
  const all = await request('/v1/iot/sensors/sensor-1/data', json('GET', undefined, adminToken));
  assert.equal(all.status, 200);
  assert.deepEqual((all.body as Array<{ id: string }>).map((reading) => reading.id).sort(), ['r1', 'r2', 'r4']);
  assert.equal(all.headers.get('x-total-count'), '3');

  const recent = await request('/v1/iot/sensors/sensor-1/data?hours=24', json('GET', undefined, adminToken));
  assert.deepEqual((recent.body as Array<{ id: string }>).map((reading) => reading.id).sort(), ['r1', 'r2']);
  assert.equal(JSON.stringify(recent.body).includes('"r3"'), false);

  const alias = await request('/v1/iot/sensors/sensor-1/readings?hours=24', json('GET', undefined, adminToken));
  assert.equal(alias.status, 200);
  assert.equal(alias.body.total, 2);
  assert.equal(alias.body.readings.length, 2);
});

test('IoT statistics return real min/max/average/count', async () => {
  const stats = await request('/v1/iot/sensors/sensor-1/statistics', json('GET', undefined, adminToken));
  assert.equal(stats.status, 200);
  assert.equal(stats.body.count, 3);
  assert.equal(stats.body.min, 10);
  assert.equal(stats.body.max, 30);
  assert.equal(stats.body.average, 20);
  assert.equal(stats.body.unit, 'C');

  const windowed = await request('/v1/iot/sensors/sensor-1/statistics?hours=24', json('GET', undefined, adminToken));
  assert.equal(windowed.body.count, 2);
  assert.equal(windowed.body.average, 15);
  assert.equal(windowed.body.latest.value, 10);
});

test('asset IoT data matches the documented object contract', async () => {
  const response = await request('/v1/iot/assets/asset-1/iot-data?hours=24', json('GET', undefined, adminToken));
  assert.equal(response.status, 200);
  assert.equal(Array.isArray(response.body), false, 'must be an object, not the old array');
  assert.equal(response.body.asset_id, 'asset-1');
  assert.equal(response.body.sensors.length, 1);
  assert.equal(response.body.sensors[0].id, 'sensor-1');
  assert.equal(response.body.sensors[0].status, 'online');
  assert.equal(response.body.readings.length, 2);
  assert.equal(response.body.summary.total_sensors, 1);
  assert.equal(response.body.summary.total_readings, 2);
  assert.equal(response.body.summary.active_alerts, 0);
});

test('sensor status is derived from the last reading time', async () => {
  const online = await request('/v1/iot/sensors/sensor-1/status', json('GET', undefined, adminToken));
  assert.equal(online.body.status, 'online');
  const offline = await request('/v1/iot/sensors/sensor-3/status', json('GET', undefined, adminToken));
  assert.equal(offline.body.status, 'offline');
  const withReading = await request('/v1/iot/sensors/sensor-2/status', json('GET', undefined, adminToken));
  assert.equal(withReading.body.status, 'online');
  const unknown = await request('/v1/iot/sensors/sensor-4/status', json('GET', undefined, adminToken));
  assert.equal(unknown.body.status, 'unknown');
});

test('acknowledging a critical alert creates exactly one maintenance work order', async () => {
  const created = await request('/v1/alerts', json('POST', {
    id: 'alert-crit', title: 'Transformer overheating', description: 'Temperature above threshold',
    severity: 'critical', status: 'open', asset_id: 'asset-1',
  }, adminToken));
  assert.equal(created.status, 201);

  const acknowledged = await request('/v1/alerts/alert-crit/acknowledge', json('POST', {}, adminToken));
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.status, 'acknowledged');
  assert.equal(acknowledged.body.maintenance_id, 'alert-alert-crit');

  const maintenance = tier2.records.get('city-maintenance')?.get('alert-alert-crit') as Record<string, unknown>;
  assert.ok(maintenance, 'the alert must create a maintenance work order');
  assert.equal(maintenance.source_alert_id, 'alert-crit');
  assert.equal(maintenance.asset_id, 'asset-1');
  assert.equal(maintenance.priority, 'urgent');
  assert.equal(maintenance.type, 'corrective');
  const slaMillis = Date.parse(String(maintenance.sla_due_at)) - Date.now();
  assert.ok(slaMillis > 0 && slaMillis <= 4 * 3_600_000 + 60_000, 'critical SLA must be near four hours');

  const repeated = await request('/v1/alerts/alert-crit/acknowledge', json('POST', {}, adminToken));
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.maintenance_id, 'alert-alert-crit');
  const duplicates = [...(tier2.records.get('city-maintenance')?.values() || [])]
    .filter((row) => String((row as Record<string, unknown>).source_alert_id) === 'alert-crit');
  assert.equal(duplicates.length, 1, 'a retried acknowledgement must not duplicate the work order');
});

test('low and high alerts follow the automation threshold correctly', async () => {
  await request('/v1/alerts', json('POST', {
    id: 'alert-low', title: 'Minor noise', severity: 'low', status: 'open', asset_id: 'asset-1',
  }, adminToken));
  const low = await request('/v1/alerts/alert-low/acknowledge', json('POST', {}, adminToken));
  assert.equal(low.status, 200);
  assert.equal(low.body.maintenance_id, undefined);
  assert.equal(tier2.records.get('city-maintenance')?.has('alert-alert-low'), false);

  await request('/v1/alerts', json('POST', {
    id: 'alert-high', title: 'Cracked pole', severity: 'high', status: 'open', asset_id: 'asset-1',
  }, adminToken));
  const high = await request('/v1/alerts/alert-high/acknowledge', json('POST', {}, adminToken));
  assert.equal(high.body.maintenance_id, 'alert-alert-high');
  const order = tier2.records.get('city-maintenance')?.get('alert-alert-high') as Record<string, unknown>;
  assert.equal(order.priority, 'high');
});

test('incident assignment produces an in-app notification for the assignee', async () => {
  const assigned = await request('/v1/incidents/inc-1/assign', json('POST', { assigned_to: 'technician-user' }, adminToken));
  assert.equal(assigned.status, 200);
  assert.equal(assigned.body.assigned_to, 'technician-user');

  const notifications = await request('/v1/notifications', json('GET', undefined, technicianToken));
  assert.equal(notifications.status, 200);
  const forAssignee = (notifications.body as Array<Record<string, unknown>>).filter((entry) => entry.user_id === 'technician-user');
  assert.equal(forAssignee.length, 1);
  assert.equal(forAssignee[0].type, 'incident_assigned');
  assert.equal((forAssignee[0].delivery as Record<string, Record<string, unknown>>).in_app.status, 'delivered');
  // No external channel is configured for this recipient/deployment, so the
  // email channel is honestly reported as not configured, never delivered.
  assert.equal((forAssignee[0].delivery as Record<string, Record<string, unknown>>).email.status, 'not_configured');

  // Idempotent: assigning again must not duplicate the notification.
  await request('/v1/incidents/inc-1/assign', json('POST', { assigned_to: 'technician-user' }, adminToken));
  const afterRetry = await request('/v1/notifications', json('GET', undefined, technicianToken));
  assert.equal((afterRetry.body as Array<Record<string, unknown>>).filter((entry) => entry.type === 'incident_assigned').length, 1);

  const unread = await request('/v1/notifications/unread-count', json('GET', undefined, technicianToken));
  assert.equal(unread.body.unread_count, 1);

  const notificationId = String(forAssignee[0].id);
  const otherRead = await request(`/v1/notifications/${notificationId}/read`, json('POST', {}, otherToken));
  assert.equal(otherRead.status, 404, 'another operator must not read this notification');
  assert.equal((await request('/v1/notifications', json('GET', undefined, otherToken))).body.length, 0);

  const read = await request(`/v1/notifications/${notificationId}/read`, json('POST', {}, technicianToken));
  assert.equal(read.status, 200);
  const afterRead = await request('/v1/notifications/unread-count', json('GET', undefined, technicianToken));
  assert.equal(afterRead.body.unread_count, 0);
});

test('notification producer endpoint enforces permissions and reports channel capability', async () => {
  const created = await request('/v1/notifications', json('POST', {
    user_id: 'technician-user', type: 'system', title: 'Toolbox talk', message: 'Tomorrow 8am',
  }, adminToken));
  assert.equal(created.status, 201);
  assert.equal(created.body.user_id, 'technician-user');
  assert.equal(created.body.channel, 'in_app');

  const forbidden = await request('/v1/notifications', json('POST', {
    user_id: 'technician-user', type: 'system', title: 'x', message: 'y',
  }, technicianToken));
  assert.equal(forbidden.status, 403);

  const capability = await request('/v1/notifications/capabilities', json('GET', undefined, adminToken));
  assert.equal(capability.status, 200);
  assert.equal(capability.body.in_app, 'available');
  assert.equal(capability.body.external, 'unavailable');
});

test('a resolved incident notifies the assignee', async () => {
  const resolved = await request('/v1/incidents/inc-1/resolve', json('POST', { resolution_notes: 'fixed', resolution_type: 'fixed' }, adminToken));
  assert.equal(resolved.status, 200);
  const notifications = await request('/v1/notifications', json('GET', undefined, technicianToken));
  assert.ok((notifications.body as Array<Record<string, unknown>>).some((entry) => entry.type === 'incident_resolved'));
});

test('reports generate real CSV/JSON bytes and reject unsupported formats', async () => {
  const created = await request('/v1/reports', json('POST', {
    report_type: 'incident_summary', format: 'csv',
  }, adminToken));
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'completed');
  assert.ok(created.body.row_count >= 2);
  assert.equal(created.body.content_type, 'text/csv; charset=utf-8');
  assert.equal(typeof created.body.content_sha256, 'string');

  const download = await request(`/v1/reports/${created.body.id}/download`, json('GET', undefined, adminToken));
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-type') || '', /text\/csv/);
  assert.match(download.headers.get('content-disposition') || '', /attachment; filename=/);
  assert.match(String(download.body), /incident_id,incident_number,title/);
  assert.match(String(download.body), /Broken lamp/);
  assert.equal(download.headers.get('x-content-sha256'), created.body.content_sha256);

  // Regeneration is deterministic for the same data and filters.
  const regenerated = await request(`/v1/reports/${created.body.id}/generate`, json('POST', {}, adminToken));
  assert.equal(regenerated.status, 200);
  assert.equal(regenerated.body.content_sha256, created.body.content_sha256);

  const jsonReport = await request('/v1/reports', json('POST', {
    report_type: 'maintenance_summary', format: 'json',
  }, adminToken));
  assert.equal(jsonReport.status, 201);
  const jsonDownload = await request(`/v1/reports/${jsonReport.body.id}/download`, json('GET', undefined, adminToken));
  const parsed = (typeof jsonDownload.body === 'string' ? JSON.parse(jsonDownload.body) : jsonDownload.body) as { rows: unknown[]; row_count: number };
  assert.equal(parsed.row_count, jsonReport.body.row_count);
  assert.ok(parsed.rows.length >= 1);

  const unsupported = await request('/v1/reports', json('POST', {
    report_type: 'incident_summary', format: 'pdf',
  }, adminToken));
  assert.equal(unsupported.status, 415);
  assert.match(String(unsupported.body.error), /unsupported_report_format/);
});

test('AI endpoints report the missing capability instead of returning canned text', async () => {
  const status = await request('/v1/ai/status', json('GET', undefined, adminToken));
  assert.equal(status.status, 503);
  assert.equal(status.body.status, 'unavailable');
  assert.match(String(status.body.dependency), /SynapseDX\/issues\/11/);

  const chat = await request('/v1/ai/chat', json('POST', { message: 'What is the health of ASSET-1?' }, adminToken));
  assert.equal(chat.status, 503);
  assert.equal(chat.body.error, 'ai_capability_unavailable');
  assert.match(String(chat.body.dependency), /SynapseDX\/issues\/11/);
  assert.equal(typeof chat.body.message, 'undefined', 'no static answer may be returned');
});

test('AI chat proxies the Tier-2 capability when it is available', async () => {
  tier2.ai.available = true;
  try {
    const status = await request('/v1/ai/status', json('GET', undefined, adminToken));
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'ready');
    assert.equal(status.body.configured, true);

    const chat = await request('/v1/ai/chat', json('POST', {
      message: 'What is the health of ASSET-1?', asset_id: 'asset-1',
    }, adminToken));
    assert.equal(chat.status, 200);
    assert.equal(chat.body.message, tier2.ai.reply);
    assert.equal(chat.body.provider, 'synapsedx');
    assert.deepEqual(chat.body.citations, []);
    assert.equal(chat.body.model, 'fake-model');
  } finally {
    tier2.ai.available = false;
  }
});

test('inline base64 attachments are rejected instead of being stored', async () => {
  const response = await request('/v1/assets/asset-1/documents', json('POST', {
    file_name: 'manual.pdf', content_base64: 'aGVsbG8=', file_type: 'application/pdf',
  }, adminToken));
  assert.equal(response.status, 415);
  assert.equal(response.body.error, 'inline_binary_not_accepted');
  assert.equal((tier2.records.get('city-assets')?.get('asset-1') as Record<string, unknown> | undefined)?.attachments !== undefined, false);
});

test('external delivery sends through the Tier-2 notifications capability with templates', async () => {
  tier2.seed('city-users', 'tech-mail', {
    id: 'tech-mail', username: 'tech-mail', email: 'tech-mail@example.com', role: 'technician', status: 'active',
  });
  process.env.CITY_NOTIFY_EXTERNAL = 'true';
  try {
    const assigned = await request('/v1/incidents/inc-2/assign', json('POST', { assigned_to: 'tech-mail' }, adminToken));
    assert.equal(assigned.status, 200);
    const stored = Array.from((tier2.records.get('city-notifications') || new Map()).values());
    const entry = stored.find((row) => row.user_id === 'tech-mail' && row.type === 'incident_assigned');
    assert.ok(entry, 'the in-app projection is still written');
    const delivery = entry!.delivery as Record<string, Record<string, unknown>>;
    assert.equal(delivery.in_app.status, 'delivered');
    assert.equal(delivery.email.status, 'queued', 'Tier-2 accepted the email send');
    assert.ok(String(delivery.email.notification_id || '').startsWith('notif-'));
    const send = tier2.notifications.sends.find((item) => item.recipient && (item.recipient as Record<string, unknown>).email === 'tech-mail@example.com');
    assert.ok(send, 'the adapter called notifications.send');
    assert.match(String(send!.template), /^city-incident-assigned-email$/);
    assert.equal(JSON.stringify(send!.variables).includes('tech-mail@example.com'), false, 'variables contain no recipient PII');
    const status = await request(`/v1/notifications/${String(entry!.id)}/delivery`, json('GET', undefined, adminToken));
    assert.equal(status.status, 200);
    assert.equal((status.body.delivery as Record<string, Record<string, unknown>>).email.status, 'queued');
  } finally {
    delete process.env.CITY_NOTIFY_EXTERNAL;
  }
});

test('a Tier-2 notification outage is reported as unsupported, not delivered', async () => {
  tier2.seed('city-users', 'tech-outage', {
    id: 'tech-outage', username: 'tech-outage', email: 'tech-outage@example.com', role: 'technician', status: 'active',
  });
  process.env.CITY_NOTIFY_EXTERNAL = 'true';
  tier2.notifications.available = false;
  try {
    const assigned = await request('/v1/incidents/inc-2/assign', json('POST', { assigned_to: 'tech-outage' }, adminToken));
    assert.equal(assigned.status, 200, 'the domain transition must not fail because a channel is down');
    const stored = Array.from((tier2.records.get('city-notifications') || new Map()).values())
      .find((row) => row.user_id === 'tech-outage' && row.type === 'incident_assigned');
    assert.ok(stored);
    const delivery = stored!.delivery as Record<string, Record<string, unknown>>;
    assert.equal(delivery.in_app.status, 'delivered');
    assert.equal(delivery.email.status, 'unsupported');
    assert.match(String(delivery.email.dependency), /SynapseDX\/issues\/10/);
  } finally {
    tier2.notifications.available = true;
    delete process.env.CITY_NOTIFY_EXTERNAL;
  }
});

test('notification preferences are read and written through Tier-2', async () => {
  const initial = await request('/v1/notifications/preferences', json('GET', undefined, technicianToken));
  assert.equal(initial.status, 200);
  assert.equal(initial.body.recipient, `user:user-technician-user`);
  const updated = await request('/v1/notifications/preferences', json('PUT', { channels: ['email'] }, technicianToken));
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.channels, ['email']);
  assert.equal(tier2.notifications.preferences.get('user:user-technician-user')?.channels instanceof Array, true);
});
