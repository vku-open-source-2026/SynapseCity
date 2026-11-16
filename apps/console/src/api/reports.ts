// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, asListPage, httpClient } from '../lib/httpClient';
import type { Report, ReportCreateRequest, ReportType } from '../types/report';

export interface ReportListParams {
  skip?: number;
  limit?: number;
  type?: string;
  status?: string;
}

/**
 * The City report engine uses the canonical report types. The console's older
 * labels are translated here so the API never receives an unknown type.
 */
const REPORT_TYPE_ALIASES: Record<ReportType, string> = {
  maintenance: 'maintenance_summary',
  incident: 'incident_summary',
  asset: 'lifecycle_overview',
  budget: 'maintenance_summary',
};

function toFilters(parameters: Record<string, unknown>): Record<string, unknown> {
  const filters: Record<string, unknown> = { ...parameters };
  // The report UI names the range from_date/to_date; the engine uses
  // date_from/date_to. Preserve both spellings for compatibility.
  if (filters.from_date && !filters.date_from) filters.date_from = filters.from_date;
  if (filters.to_date && !filters.date_to) filters.date_to = filters.to_date;
  delete filters.from_date;
  delete filters.to_date;
  return filters;
}

export const reportsApi = {
  list: async (params?: ReportListParams): Promise<Report[]> => {
    const response = await httpClient.get<Report[]>('/reports', { params });
    return asList<Report>(response.data);
  },

  listPage: async (params?: ReportListParams) => {
    const response = await httpClient.get<Report[]>('/reports', { params });
    return asListPage<Report>(response.data, response.headers['x-total-count']);
  },

  getById: async (id: string): Promise<Report> => {
    const response = await httpClient.get<Report>(`/reports/${id}`);
    return response.data;
  },

  create: async (data: ReportCreateRequest): Promise<Report> => {
    const response = await httpClient.post<Report>('/reports', {
      report_type: REPORT_TYPE_ALIASES[data.type] || data.type,
      format: data.format,
      filters: toFilters(data.parameters || {}),
    });
    return response.data;
  },

  generate: async (id: string): Promise<Report> => {
    const response = await httpClient.post<Report>(`/reports/${id}/generate`);
    return response.data;
  },

  /**
   * Download the generated artifact as a Blob URL. The download route requires
   * the City session, so a plain window.open would lose the Authorization
   * header and return 401.
   */
  download: async (id: string): Promise<{ url: string; filename: string }> => {
    const response = await httpClient.get(`/reports/${id}/download`, { responseType: 'blob' });
    const disposition = String(response.headers['content-disposition'] || '');
    const match = /filename="?([^";]+)"?/i.exec(disposition);
    return {
      url: URL.createObjectURL(response.data as Blob),
      filename: match ? match[1] : `report-${id}`,
    };
  },
};
