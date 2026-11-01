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

