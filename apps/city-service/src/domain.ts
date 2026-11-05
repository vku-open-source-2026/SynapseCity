// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { Request } from 'express';
import { CapabilitiesClient, CapabilitiesError, Dataset } from '@synapsedx/capabilities';

/** Published City datasets are dedicated to the public domain under CC0 1.0 Universal. */
export const DATA_LICENSE = 'CC0-1.0';

export const DATASETS = {
  // Public datasets: these feed the public asset map and public incident lookup.
  assets: {
    id: 'city-assets', name: 'SynapseCity infrastructure assets', entityType: 'CityAsset',
    license: DATA_LICENSE, description: 'Public projection of city infrastructure assets',
    public: true,
  },
  incidents: {
    id: 'city-incidents', name: 'SynapseCity infrastructure incidents', entityType: 'CityIncident',
    license: DATA_LICENSE, description: 'Public projection of generalized infrastructure incidents',
    public: true,
  },
  // Private sidecar for incident data that must never reach the public
  // projection: reporter identity, contact details and internal comments.
  incidentInternal: { id: 'city-incident-internal', name: 'SynapseCity incident internal records', entityType: 'CityIncidentInternal', license: DATA_LICENSE, description: 'Private reporter identity and internal incident notes', public: false },
  // Private datasets: operational records must never be published to the open
  // data projection. In particular city-users holds operator profiles and must
  // stay private forever.
  maintenance: { id: 'city-maintenance', name: 'SynapseCity maintenance work orders', entityType: 'MaintenanceWorkOrder', license: DATA_LICENSE, description: 'Infrastructure maintenance lifecycle records', public: false },
  sensors: { id: 'city-iot-sensors', name: 'SynapseCity IoT sensors', entityType: 'IoTSensor', license: DATA_LICENSE, description: 'Infrastructure sensor metadata and readings', public: false },
  sensorData: { id: 'city-iot-readings', name: 'SynapseCity IoT readings', entityType: 'SensorReading', license: DATA_LICENSE, description: 'Infrastructure sensor observations', public: false },
  alerts: { id: 'city-alerts', name: 'SynapseCity alerts', entityType: 'InfrastructureAlert', license: DATA_LICENSE, description: 'Operational alerts associated with city infrastructure', public: false },
  budgets: { id: 'city-budgets', name: 'SynapseCity budgets', entityType: 'InfrastructureBudget', license: DATA_LICENSE, description: 'Infrastructure budget records', public: false },
  transactions: { id: 'city-budget-transactions', name: 'SynapseCity budget transactions', entityType: 'BudgetTransaction', license: DATA_LICENSE, description: 'Infrastructure budget transactions', public: false },
  reports: { id: 'city-reports', name: 'SynapseCity reports', entityType: 'InfrastructureReport', license: DATA_LICENSE, description: 'Infrastructure operational reports', public: false },
  files: { id: 'city-files', name: 'SynapseCity file metadata', entityType: 'CityFile', license: DATA_LICENSE, description: 'Metadata for binary files stored through the Tier-2 files capability', public: false },
  notifications: { id: 'city-notifications', name: 'SynapseCity notifications', entityType: 'InfrastructureNotification', license: DATA_LICENSE, description: 'Infrastructure notification records', public: false },
  users: { id: 'city-users', name: 'SynapseCity users', entityType: 'CityUser', license: DATA_LICENSE, description: 'Domain operator profiles', public: false },
  geofences: { id: 'city-geofences', name: 'SynapseCity geofences', entityType: 'CityGeofence', license: DATA_LICENSE, description: 'Infrastructure geofence records', public: false },
  ingest: { id: 'city-ingest-jobs', name: 'SynapseCity ingest jobs', entityType: 'IngestJob', license: DATA_LICENSE, description: 'Infrastructure data ingestion records', public: false },
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
  const headerToken = authorization?.replace(/^Bearer\s+/i, '').trim() || undefined;
  // A City session carries the user-scoped Tier-2 credential minted by the
  // Tier-2 auth capability. The City HMAC token itself is never sent upstream.
  const session = (req as Request & { session?: { tier2_token?: string } }).session;
  const token = session?.tier2_token || (session ? undefined : headerToken) || process.env.SYNAPSEDX_TOKEN;
  const apiKey = req.header('x-api-key') || process.env.SYNAPSEDX_API_KEY;
  return new CapabilitiesClient({ baseUrl: TIER2_URL, token: token || undefined, apiKey: apiKey || undefined });
}

export async function ensureDataset(client: CapabilitiesClient, spec: DatasetSpec): Promise<Dataset> {
  try {
    const existing = await client.datasets.get(spec.id);
    const desiredPublic = spec.public === true;
    const needsReconcile = existing.license !== spec.license
      || existing.public !== desiredPublic
      || existing.name !== spec.name
      || existing.entityType !== spec.entityType
      || (existing.description || '') !== (spec.description || '');
    if (!needsReconcile) return existing;

    // An old operational dataset may still have a public projection. Revoke it
    // before making the dataset private so Tier-2 can never keep exposing it.
    if (existing.public === true && !desiredPublic && existing.status === 'published') {
      await client.datasets.revoke(existing.id);
    }
    return client.datasets.update(existing.id, {
      name: spec.name,
      entityType: spec.entityType,
      license: spec.license,
      description: spec.description,
      public: desiredPublic,
      schemaVersion: existing.schemaVersion || '1.0.0',
    });
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

