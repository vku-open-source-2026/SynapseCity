// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { httpClient } from "../lib/httpClient";

export interface CoverageArea {
  name: string;
  population: number;
  bbox?: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  polygon?: Array<[number, number]>;
  asset_types?: string[];
}

export interface CoverageAreaResult {
  area: string;
  population: number;
  asset_count: number;
  assets_by_type: Record<string, number>;
  missing_asset_types: string[];
  population_per_asset: number;
  incident_count: number;
  open_incident_count: number;
  gap_score: number;
  priority: "critical" | "high" | "medium" | "low";
}

export interface CoverageReport {
  generated_at: string;
  service_radius_meters: number;
  target_population_per_asset: number;
  areas: CoverageAreaResult[];
}

export const analyticsApi = {
  coverage: async (payload: {
    areas: CoverageArea[];
    service_radius_meters?: number;
    target_population_per_asset?: number;
  }): Promise<CoverageReport> => {
    const response = await httpClient.post<CoverageReport>("/geo/coverage", payload);
    return response.data;
  },
};
