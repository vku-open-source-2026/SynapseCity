// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
export type ReportType = 'maintenance' | 'budget' | 'incident' | 'asset';
export type ReportFormat = 'csv' | 'json';
export type ReportStatus = 'pending' | 'generating' | 'completed' | 'failed';

export interface Report {
  id: string;
  report_code: string;
  type: ReportType;
  format: ReportFormat;
  status: ReportStatus;
  parameters: Record<string, unknown>;
  file_url?: string;
  download_url?: string;
  row_count?: number;
  created_at: string;
  completed_at?: string;
}

export interface ReportCreateRequest {
  type: ReportType;
  format: ReportFormat;
  parameters: Record<string, unknown>;
}
