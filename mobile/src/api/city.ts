// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, request } from './client';
import type {
  CityAlert,
  CityNotification,
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

  createPublicIncident: (input: CreateIncidentInput) =>
    request<PublicIncident>('/public/incidents', { method: 'POST', body: input }),

  listAlerts: async (token: string): Promise<CityAlert[]> =>
    asList<CityAlert>(await request('/alerts?limit=50', { token })),

  listNotifications: async (token: string): Promise<CityNotification[]> =>
    asList<CityNotification>(await request('/notifications?limit=50', { token })),

  markNotificationRead: (token: string, id: string) =>
    request<CityNotification>(`/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
      token,
    }),
};
