// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, asListPage, httpClient } from "../lib/httpClient";
import type { Alert, AlertResolveRequest } from "../types/alert";

export interface AlertListParams {
    skip?: number;
    limit?: number;
    status?: string;
    severity?: string;
    asset_id?: string;
}

export const alertsApi = {
    list: async (params?: AlertListParams): Promise<Alert[]> => {
        const response = await httpClient.get<Alert[]>("/alerts", { params });
        return asList<Alert>(response.data);
    },

    listPage: async (params?: AlertListParams) => {
        const response = await httpClient.get<Alert[]>("/alerts", { params });
        return asListPage<Alert>(response.data, response.headers["x-total-count"]);
    },

    getById: async (id: string): Promise<Alert> => {
        const response = await httpClient.get<Alert>(`/alerts/${id}`);
        return response.data;
    },

    acknowledge: async (id: string): Promise<Alert> => {
        const response = await httpClient.post<Alert>(
            `/alerts/${id}/acknowledge`
        );
        return response.data;
    },

    resolve: async (id: string, data?: AlertResolveRequest): Promise<Alert> => {
        const response = await httpClient.post<Alert>(
            `/alerts/${id}/resolve`,
            data
        );
        return response.data;
    },

    dismiss: async (id: string): Promise<Alert> => {
        const response = await httpClient.post<Alert>(`/alerts/${id}/dismiss`);
        return response.data;
    },
};
