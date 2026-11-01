// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Request } from 'express';
import { CapabilitiesClient, CapabilitiesError, Dataset } from '@synapsedx/capabilities';

export const DATASETS = {
  assets: {
    id: 'city-assets', name: 'SynapseCity infrastructure assets', entityType: 'CityAsset',
    license: 'CC-BY-4.0', description: 'Public projection of city infrastructure assets',
  },
  incidents: {
    id: 'city-incidents', name: 'SynapseCity infrastructure incidents', entityType: 'CityIncident',
    license: 'CC-BY-4.0', description: 'Public projection of generalized infrastructure incidents',
  },
  maintenance: { id: 'city-maintenance', name: 'SynapseCity maintenance work orders', entityType: 'MaintenanceWorkOrder', license: 'CC-BY-4.0', description: 'Infrastructure maintenance lifecycle records' },
  sensors: { id: 'city-iot-sensors', name: 'SynapseCity IoT sensors', entityType: 'IoTSensor', license: 'CC-BY-4.0', description: 'Infrastructure sensor metadata and readings' },
  sensorData: { id: 'city-iot-readings', name: 'SynapseCity IoT readings', entityType: 'SensorReading', license: 'CC-BY-4.0', description: 'Infrastructure sensor observations' },
  alerts: { id: 'city-alerts', name: 'SynapseCity alerts', entityType: 'InfrastructureAlert', license: 'CC-BY-4.0', description: 'Operational alerts associated with city infrastructure' },
  budgets: { id: 'city-budgets', name: 'SynapseCity budgets', entityType: 'InfrastructureBudget', license: 'CC-BY-4.0', description: 'Infrastructure budget records' },
  transactions: { id: 'city-budget-transactions', name: 'SynapseCity budget transactions', entityType: 'BudgetTransaction', license: 'CC-BY-4.0', description: 'Infrastructure budget transactions' },
  reports: { id: 'city-reports', name: 'SynapseCity reports', entityType: 'InfrastructureReport', license: 'CC-BY-4.0', description: 'Infrastructure operational reports' },
  notifications: { id: 'city-notifications', name: 'SynapseCity notifications', entityType: 'InfrastructureNotification', license: 'CC-BY-4.0', description: 'Infrastructure notification records' },
  users: { id: 'city-users', name: 'SynapseCity users', entityType: 'CityUser', license: 'CC-BY-4.0', description: 'Domain operator profiles' },
  geofences: { id: 'city-geofences', name: 'SynapseCity geofences', entityType: 'CityGeofence', license: 'CC-BY-4.0', description: 'Infrastructure geofence records' },
  ingest: { id: 'city-ingest-jobs', name: 'SynapseCity ingest jobs', entityType: 'IngestJob', license: 'CC-BY-4.0', description: 'Infrastructure data ingestion records' },
} as const;

export interface DatasetSpec {
  id: string;
  name: string;
  entityType: string;
  license: string;
  description: string;
}

function assertPublicDependency(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`SYNAPSEDX_BASE_URL is not an absolute URL: ${raw}`); }
  const local = /^(localhost|127\.0\.0\.1|::1)$/i.test(url.hostname);
  if (local && process.env.ALLOW_LOCAL_DEPENDENCIES !== 'true') {
    throw new Error('SYNAPSEDX_BASE_URL must be a public HTTPS endpoint');
  }
  if (url.protocol !== 'https:' && !local) throw new Error('SYNAPSEDX_BASE_URL must use HTTPS');
  return raw.replace(/\/$/, '');
}

export const TIER2_URL = assertPublicDependency(process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs');

export function capabilitiesFromRequest(req: Request): CapabilitiesClient {
  const authorization = req.header('authorization');
  const token = authorization?.replace(/^Bearer\s+/i, '').trim() || process.env.SYNAPSEDX_TOKEN;
  const apiKey = req.header('x-api-key') || process.env.SYNAPSEDX_API_KEY;
  return new CapabilitiesClient({ baseUrl: TIER2_URL, token: token || undefined, apiKey: apiKey || undefined });
}

export async function ensureDataset(client: CapabilitiesClient, spec: DatasetSpec): Promise<Dataset> {
  try {
    return await client.datasets.get(spec.id);
  } catch (error) {
    if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    const created = await client.datasets.create({ slug: spec.id, name: spec.name, entityType: spec.entityType, license: spec.license, description: spec.description, public: true, schemaVersion: '1.0.0' });
    return client.datasets.publish(created.id);
  }
}

export function validationError(message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status: 400 });
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw validationError('request_body_must_be_an_object');
  return value as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, field: string): string {
  const value = String(body[field] || '').trim();
  if (!value) throw validationError(`field_required:${field}`);
  return value;
}

