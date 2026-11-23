// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, request } from './client';
import type {
  CreateIncidentInput,
  MaintenanceSummary,
  MapConfig,
  ProductInfo,
  PublicAsset,
  PublicIncident,
} from './types';

export const cityApi = {
  getProductInfo: () => request<ProductInfo>('/city'),

  getMapConfig: () => request<MapConfig>('/map/config'),

  listPublicAssets: async (params?: { limit?: number; offset?: number }): Promise<PublicAsset[]> => {
    const query = new URLSearchParams();
    query.set('limit', String(params?.limit ?? 100));
    if (params?.offset) query.set('offset', String(params.offset));
    return asList<PublicAsset>(await request(`/public/assets?${query.toString()}`));
  },

  /**
   * Read every public asset page. The public projection pages at 500 rows, so
   * the map/nearby views must not stop at the first 200 rows.
   */
  listAllPublicAssets: async (): Promise<PublicAsset[]> => {
    const pageSize = 500;
    const all: PublicAsset[] = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await cityApi.listPublicAssets({ limit: pageSize, offset });
      if (page.length === 0) break;
      all.push(...page);
    }
    return all;
  },

  getPublicAsset: (code: string) =>
    request<PublicAsset>(`/public/assets/${encodeURIComponent(code.trim())}`),

  getMaintenanceSummary: (code: string) =>
    request<MaintenanceSummary>(`/public/assets/${encodeURIComponent(code.trim())}/maintenance-summary`),

  listPublicIncidents: async (params?: { limit?: number; offset?: number }): Promise<PublicIncident[]> => {
    const query = new URLSearchParams();
    query.set('limit', String(params?.limit ?? 100));
    if (params?.offset) query.set('offset', String(params.offset));
    return asList<PublicIncident>(await request(`/public/incidents?${query.toString()}`));
  },

  getPublicIncident: (reference: string) =>
    request<PublicIncident>(`/public/incidents/${encodeURIComponent(reference.trim())}`),

  /**
   * Anonymous citizen report. Mirrors the web console (`publicApi.createAnonymousIncident`):
   * the Turnstile token is threaded via `CF-Turnstile-Response` when available,
   * and the response carries a one-time `edit_token` used for photo appends.
   *
   * TODO(mobile-turnstile): no Turnstile widget exists in the native app yet,
   * so callers currently pass `turnstileToken` through when one becomes
   * available (e.g. via a WebView challenge). Until then the server still
   * enforces Turnstile when `REQUIRE_TURNSTILE=true`.
   */
  createPublicIncident: (input: CreateIncidentInput, options?: { turnstileToken?: string }) =>
    request<PublicIncident>('/public/incidents', {
      method: 'POST',
      body: input,
      ...(options?.turnstileToken
        ? { headers: { 'CF-Turnstile-Response': options.turnstileToken } }
        : {}),
    }),

  /**
   * Upload one anonymous report photo (raw bytes) and return its file id.
   * Mirrors `uploadPublicFile` in the web console: bytes go to
   * `POST /v1/public/files` with `X-File-Name` (+ optional report binding and
   * Turnstile), never as a data URL inside the incident record.
   */
  uploadPublicPhoto: async (
    bytes: Uint8Array | ArrayBuffer,
    filename: string,
    contentType: string,
    options?: { reportId?: string; editToken?: string; turnstileToken?: string },
  ): Promise<{ file_id: string; id: string }> => {
    const { API_BASE } = await import('./client');
    const headers: Record<string, string> = {
      'Content-Type': contentType || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(filename),
      'X-File-Visibility': 'public',
      ...(options?.reportId ? { 'X-Report-Id': options.reportId } : {}),
      ...(options?.editToken ? { 'X-Report-Edit-Token': options.editToken } : {}),
      ...(options?.turnstileToken ? { 'CF-Turnstile-Response': options.turnstileToken } : {}),
    };
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes as ArrayBuffer);
    const response = await fetch(`${API_BASE}/public/files`, {
      method: 'POST',
      headers,
      // React Native fetch accepts Uint8Array as body.
      body: body as unknown as BodyInit,
    });
    const parsed: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const record = (parsed || {}) as Record<string, unknown>;
      throw new Error(String(record.detail || record.error || `http_${response.status}`));
    }
    const record = (parsed || {}) as Record<string, unknown>;
    const id = String(record.file_id || record.id || '');
    if (!id) throw new Error('invalid_upload_response');
    return { file_id: id, id };
  },

  /**
   * Append already-uploaded public photo file ids to a report. Requires the
   * one-time `edit_token` returned by `createPublicIncident` (sent as
   * `X-Report-Edit-Token`) plus a fresh Turnstile token, mirroring
   * `publicApi.uploadPhotos` in the web console. Caps at 10 photos total.
   */
  appendPublicIncidentPhotos: (
    incidentId: string,
    fileIds: string[],
    editToken: string,
    turnstileToken?: string,
  ) =>
    request<PublicIncident>(`/public/incidents/${encodeURIComponent(incidentId)}/photos`, {
      method: 'POST',
      body: { file_ids: fileIds },
      headers: {
        'X-Report-Edit-Token': editToken,
        ...(turnstileToken ? { 'CF-Turnstile-Response': turnstileToken } : {}),
      },
    }),
};
