// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { httpClient } from '../lib/httpClient';
import { uploadPublicFile } from '../lib/files';
import type { Incident, IncidentCreateRequest } from '../types/incident';

export interface PublicAssetInfo {
  id?: string;
  asset_code: string;
  name: string;
  feature_type: string;
  category: string;
  status: 'active' | 'inactive' | 'maintenance' | 'decommissioned';
  location: {
    address: string;
    coordinates: {
      longitude: number;
      latitude: number;
    };
    geometry?: {
      type: string;
      coordinates: unknown;
    };
  };
  qr_code: string;
}

export interface AssetQRCodeResponse {
  asset_code: string;
  qr_code: string;
  url: string;
}

export const publicApi = {
  /**
   * List published public assets.
   * GET /public/assets
   */
  listPublicAssets: async (params?: { limit?: number; offset?: number }): Promise<PublicAssetInfo[]> => {
    const response = await httpClient.get<PublicAssetInfo[]>('/public/assets', { params });
    return Array.isArray(response.data) ? response.data : [];
  },

  /**
   * Get public asset information by asset code
   * GET /public/assets/{code}
   */
  getPublicAsset: async (code: string): Promise<PublicAssetInfo> => {
    const response = await httpClient.get<PublicAssetInfo>(`/public/assets/${code}`);
    return response.data;
  },

  /**
   * Create an anonymous incident (no authentication required)
   * POST /public/incidents
   */
  createAnonymousIncident: async (data: IncidentCreateRequest, turnstileToken?: string): Promise<Incident> => {
    const headers: Record<string, string> = {};
    if (turnstileToken) {
      headers['CF-Turnstile-Response'] = turnstileToken;
    }
    const response = await httpClient.post<Incident>('/public/incidents', data, { headers });
    return response.data;
  },

  /**
   * Get a public incident by ID or incident number (only if public_visible is true)
   * GET /public/incidents/{incident_id}
   */
  getPublicIncident: async (incidentRef: string): Promise<Incident> => {
    const response = await httpClient.get<Incident>(`/public/incidents/${encodeURIComponent(incidentRef.trim())}`);
    return response.data;
  },

  /**
   * Lookup a public incident by either ID or incident number.
   */
  lookupPublicIncident: async (reference: string): Promise<Incident> => {
    const response = await httpClient.get<Incident>(`/public/incidents/${encodeURIComponent(reference.trim())}`);
    return response.data;
  },

  /**
   * Get asset QR code
   * GET /public/assets/{code}/qr-code
   */
  getAssetQRCode: async (code: string): Promise<AssetQRCodeResponse> => {
    const response = await httpClient.get<AssetQRCodeResponse>(`/public/assets/${code}/qr-code`);
    return response.data;
  },

  /**
   * Get the public-safe maintenance summary for an asset.
   * GET /public/assets/{code}/maintenance-summary
   */
  getMaintenanceSummary: async (code: string): Promise<{
    asset_code: string;
    work_order_count: number;
    completed_count: number;
    last_completed_at: string | null;
    last_maintenance_type: string | null;
  }> => {
    const response = await httpClient.get(`/public/assets/${encodeURIComponent(code)}/maintenance-summary`);
    return response.data;
  },

  /**
   * Upload photos for a public incident
   * POST /public/incidents/{incident_id}/photos
   */
  uploadPhotos: async (incidentId: string, files: File[]): Promise<Incident> => {
    if (!files.length) throw new Error('At least one photo is required');
    const uploaded = await Promise.all(files.map((file) => uploadPublicFile(file)));
    const response = await httpClient.post<Incident>(
      `/public/incidents/${encodeURIComponent(incidentId)}/photos`,
      { file_ids: uploaded.map((file) => file.file_id) }
    );
    return response.data;
  },
};
