// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useQuery } from '@tanstack/react-query';
import { asList, httpClient } from '../lib/httpClient';

export interface VndmsHazard {
  id: string;
  lat: number;
  lon: number;
  label: string;
  warning_type:
    | 'water_level'
    | 'warning_rain'
    | 'warning_wind'
    | 'warning_earthquake'
    | 'warning_flood';
  warning_level: number;
  severity: 'low' | 'medium' | 'high';
  value: string;
  popupInfo: string;
  source: string;
}

export function useVndmsHazards(enabled = true) {
  return useQuery({
    queryKey: ['hazards', 'vndms-live'],
    queryFn: async () => {
      const resp = await httpClient.get<VndmsHazard[]>('/hazards/vndms-live');
      return asList<VndmsHazard>(resp.data);
    },
    enabled,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}
