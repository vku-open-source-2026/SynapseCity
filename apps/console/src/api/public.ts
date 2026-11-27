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
  feature_code: string;
  category: string;
  status: 'active' | 'inactive' | 'maintenance' | 'decommissioned';
  location: {
    address: string;
    /** Omitted when the asset has no usable location; never `null`. */
    coordinates?: {
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

export interface PublicIncidentDraft {
    draft_id: string;
    upload_token: string;
    upload_token_expires_at: number;
    max_photos: number;
}

export type PublicAnonymousIncidentRequest = IncidentCreateRequest & {
    photos?: string[];
    file_ids?: string[];
    draft_id?: string;
    draft_token?: string;
};

export const publicApi = {
  /**
   * List published public assets.
   * GET /public/assets
   */
  listPublicAssets: async (params?: { limit?: number; offset?: number; include_inactive?: boolean }): Promise<PublicAssetInfo[]> => {
    const response = await httpClient.get<PublicAssetInfo[]>('/public/assets', { params });
    return Array.isArray(response.data) ? response.data : [];
  },

  /**
   * Read every page of the public projection. The map needs the complete
   * inventory, not just the first 500-row page.
   */
  listAllPublicAssets: async (params?: { include_inactive?: boolean }): Promise<PublicAssetInfo[]> => {
    const pageSize = 500;
    const all: PublicAssetInfo[] = [];
    let offset = 0;
    for (;;) {
      const response = await httpClient.get<PublicAssetInfo[]>('/public/assets', {
        params: {
          limit: pageSize,
          offset,
          ...(params?.include_inactive ? { include_inactive: true } : {}),
        },
      });
      const items = Array.isArray(response.data) ? response.data : [];
      if (items.length === 0) break;
      all.push(...items);
      const total = Number(response.headers['x-total-count']);
      // Offset advances by the requested page size because the server may
      // filter retired rows out of a page after querying Tier-2.
      offset += pageSize;
      if (Number.isFinite(total) && offset >= total) break;
      if (items.length < pageSize) break;
    }
    return all;
  },

  /**
   * Number of published public assets, read from the `x-total-count` header so
   * anonymous visitors do not need the operator-only /assets endpoint.
   * GET /public/assets?limit=1
   */
  countPublicAssets: async (params?: { include_inactive?: boolean }): Promise<number> => {
    const response = await httpClient.get<PublicAssetInfo[]>('/public/assets', {
      params: { limit: 1, ...(params?.include_inactive ? { include_inactive: true } : {}) },
    });
    const total = Number(response.headers['x-total-count']);
    if (Number.isFinite(total)) return total;
    return Array.isArray(response.data) ? response.data.length : 0;
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
   * Validate a citizen report and issue a short-lived capability for private
   * pre-report photo uploads. Photos are attached only when the final report
   * presents the same draft capability.
   */
  createAnonymousIncidentDraft: async (data: IncidentCreateRequest, turnstileToken?: string): Promise<PublicIncidentDraft> => {
    const headers: Record<string, string> = {};
    if (turnstileToken) headers['CF-Turnstile-Response'] = turnstileToken;
    const response = await httpClient.post<PublicIncidentDraft>('/public/incidents/drafts', data, { headers });
    return response.data;
  },

  /**
   * Create an anonymous incident (no authentication required). Reports with
   * photos must include the server-issued draft returned above.
   */
  createAnonymousIncident: async (
    data: PublicAnonymousIncidentRequest,
    turnstileToken?: string,
    draft?: PublicIncidentDraft,
  ): Promise<Incident> => {
    const headers: Record<string, string> = {};
    if (turnstileToken && !draft) headers['CF-Turnstile-Response'] = turnstileToken;
    const response = await httpClient.post<Incident>('/public/incidents', {
      ...data,
      ...(draft ? { draft_id: draft.draft_id, draft_token: draft.upload_token } : {}),
    }, { headers });
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
  uploadPhotos: async (
    incidentId: string,
    files: File[],
    editToken?: string,
    turnstileToken?: string,
  ): Promise<Incident> => {
    if (!files.length) throw new Error('At least one photo is required');
    if (!editToken) {
      throw new Error('The report edit token is required to append photos.');
    }
    const turnstile = turnstileToken
      ? { 'CF-Turnstile-Response': turnstileToken }
      : {};
    const uploaded = await Promise.all(
      files.map((file) =>
        uploadPublicFile(file, { reportId: incidentId, editToken, turnstileToken }),
      ),
    );
    const response = await httpClient.post<Incident>(
      `/public/incidents/${encodeURIComponent(incidentId)}/photos`,
      { file_ids: uploaded.map((file) => file.file_id) },
      { headers: { 'X-Report-Edit-Token': editToken, ...turnstile } },
    );
    return response.data;
  },
};
