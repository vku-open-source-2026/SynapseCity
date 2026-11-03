// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Request } from 'express';
import { CapabilitiesClient, CapabilitiesError, Dataset } from '@synapsedx/capabilities';

export const DATASETS = {
  // Public datasets: these feed the public asset map and public incident lookup.
  assets: {
    id: 'city-assets', name: 'SynapseCity infrastructure assets', entityType: 'CityAsset',
    license: 'CC-BY-4.0', description: 'Public projection of city infrastructure assets',
    public: true,
  },
  incidents: {
    id: 'city-incidents', name: 'SynapseCity infrastructure incidents', entityType: 'CityIncident',
    license: 'CC-BY-4.0', description: 'Public projection of generalized infrastructure incidents',
    public: true,
  },
  // Private datasets: operational records must never be published to the open
  // data projection. In particular city-users holds operator profiles and must
  // stay private forever.
  maintenance: { id: 'city-maintenance', name: 'SynapseCity maintenance work orders', entityType: 'MaintenanceWorkOrder', license: 'CC-BY-4.0', description: 'Infrastructure maintenance lifecycle records', public: false },
  sensors: { id: 'city-iot-sensors', name: 'SynapseCity IoT sensors', entityType: 'IoTSensor', license: 'CC-BY-4.0', description: 'Infrastructure sensor metadata and readings', public: false },
  sensorData: { id: 'city-iot-readings', name: 'SynapseCity IoT readings', entityType: 'SensorReading', license: 'CC-BY-4.0', description: 'Infrastructure sensor observations', public: false },
  alerts: { id: 'city-alerts', name: 'SynapseCity alerts', entityType: 'InfrastructureAlert', license: 'CC-BY-4.0', description: 'Operational alerts associated with city infrastructure', public: false },
  budgets: { id: 'city-budgets', name: 'SynapseCity budgets', entityType: 'InfrastructureBudget', license: 'CC-BY-4.0', description: 'Infrastructure budget records', public: false },
  transactions: { id: 'city-budget-transactions', name: 'SynapseCity budget transactions', entityType: 'BudgetTransaction', license: 'CC-BY-4.0', description: 'Infrastructure budget transactions', public: false },
  reports: { id: 'city-reports', name: 'SynapseCity reports', entityType: 'InfrastructureReport', license: 'CC-BY-4.0', description: 'Infrastructure operational reports', public: false },
  notifications: { id: 'city-notifications', name: 'SynapseCity notifications', entityType: 'InfrastructureNotification', license: 'CC-BY-4.0', description: 'Infrastructure notification records', public: false },
  users: { id: 'city-users', name: 'SynapseCity users', entityType: 'CityUser', license: 'CC-BY-4.0', description: 'Domain operator profiles', public: false },
  geofences: { id: 'city-geofences', name: 'SynapseCity geofences', entityType: 'CityGeofence', license: 'CC-BY-4.0', description: 'Infrastructure geofence records', public: false },
  ingest: { id: 'city-ingest-jobs', name: 'SynapseCity ingest jobs', entityType: 'IngestJob', license: 'CC-BY-4.0', description: 'Infrastructure data ingestion records', public: false },
} as const;

export interface DatasetSpec {
  id: string;
  name: string;
  entityType: string;
  license: string;
  description: string;
  /** Only public projection datasets are published to the open data layer. */
  public?: boolean;
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
    const existing = await client.datasets.get(spec.id);
    if (spec.public !== true && existing.public === true) {
      // Never silently accept an operational dataset that was previously
      // published. Revoking an existing public projection is an operator
      // action; the service must not keep publishing new records into it.
      console.warn(`[synapsecity] dataset ${spec.id} is public but must be private; revoke its public projection in Tier-2.`);
    }
    return existing;
  } catch (error) {
    if (!(error instanceof CapabilitiesError) || error.status !== 404) throw error;
    // Only the explicit public projection datasets are created as public and
    // published. Operational datasets (city-users, city-budgets, ...) stay
    // private so the Tier-2 open data layer can never expose them.
    const isPublic = spec.public === true;
    const created = await client.datasets.create({
      slug: spec.id,
      name: spec.name,
      entityType: spec.entityType,
      license: spec.license,
      description: spec.description,
      public: isPublic,
      schemaVersion: '1.0.0',
    });
    return isPublic ? client.datasets.publish(created.id) : created;
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

