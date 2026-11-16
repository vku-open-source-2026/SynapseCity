// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, request } from './client';
import type {
  AuthResponse,
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

  login: (username: string, password: string) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: { username: username.trim(), password },
    }),

  register: (input: {
    username: string;
    email: string;
    password: string;
    full_name: string;
    phone?: string;
  }) => request<AuthResponse>('/auth/register', { method: 'POST', body: input }),

  logout: (token: string, refreshToken?: string | null) =>
    request<unknown>('/auth/logout', {
      method: 'POST',
      token,
      body: refreshToken ? { refresh_token: refreshToken } : {},
    }),

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
