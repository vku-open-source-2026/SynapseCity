// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { httpClient } from '../lib/httpClient';

export interface CSVIngestError {
  row: number;
  message: string;
}

export interface CSVIngestResponse {
  message: string;
  job_id?: string;
  accepted: number;
  created: number;
  errors: CSVIngestError[];
}

export const ingestApi = {
  /**
   * Upload CSV file for asset ingestion.
   *
   * POST /ingest/csv
   *
   * The file is read in the browser and posted as JSON text; the City service
   * parses the CSV, creates assets through Tier-2 and returns a summary. No
   * multipart dependency is required.
   */
  uploadCSV: async (file: File): Promise<CSVIngestResponse> => {
    const content = await file.text();
    const response = await httpClient.post<CSVIngestResponse>('/ingest/csv', {
      filename: file.name,
      content,
    });

    return response.data;
  },
};
