// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from '@tanstack/react-router';
import PublicMap from '../pages/PublicMap';

export const Route = createFileRoute('/map')({
  component: PublicMap,
  validateSearch: (search: Record<string, unknown>): {
    assetId?: string;
    lat?: number;
    lng?: number;
    zoom?: number;
  } => {
    const lat = Number(search.lat);
    const lng = Number(search.lng);
    const zoom = Number(search.zoom);
    return {
      assetId: search.assetId as string | undefined,
      lat: Number.isFinite(lat) ? lat : undefined,
      lng: Number.isFinite(lng) ? lng : undefined,
      zoom: Number.isFinite(zoom) ? zoom : undefined,
    };
  },
});
