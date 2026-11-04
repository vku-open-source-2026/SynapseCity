// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, httpClient } from '../lib/httpClient';
import type { Notification } from '../types/notification';

export interface NotificationListParams {
  skip?: number;
  limit?: number;
  unread_only?: boolean;
}

export const notificationsApi = {
  list: async (params?: NotificationListParams): Promise<Notification[]> => {
    const response = await httpClient.get<Notification[]>('/notifications', { params });
    return asList<Notification>(response.data);
  },

  getUnreadCount: async (): Promise<{ unread_count: number }> => {
    const response = await httpClient.get<{ unread_count: number }>('/notifications/unread-count');
    return response.data;
  },

  markAsRead: async (id: string): Promise<Notification> => {
    const response = await httpClient.post<Notification>(`/notifications/${id}/read`);
    return response.data;
  },

  markAllAsRead: async (): Promise<{ message: string }> => {
    const response = await httpClient.post<{ message: string }>('/notifications/mark-all-read');
    return response.data;
  },

  getDelivery: async (id: string): Promise<{ notification_id: string; delivery: Record<string, unknown> }> => {
    const response = await httpClient.get<{ notification_id: string; delivery: Record<string, unknown> }>(
      `/notifications/${encodeURIComponent(id)}/delivery`
    );
    return response.data;
  },

  getPreferences: async (): Promise<{ recipient: string; channels: string[]; unsubscribed: boolean }> => {
    const response = await httpClient.get<{ recipient: string; channels: string[]; unsubscribed: boolean }>(
      '/notifications/preferences'
    );
    return response.data;
  },

  setPreferences: async (input: { channels?: string[]; unsubscribed?: boolean }): Promise<{ recipient: string; channels: string[]; unsubscribed: boolean }> => {
    const response = await httpClient.put<{ recipient: string; channels: string[]; unsubscribed: boolean }>(
      '/notifications/preferences',
      input
    );
    return response.data;
  },
};
