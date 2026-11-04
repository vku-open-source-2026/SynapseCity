// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { haversineMeters, pointInBoundingBox, pointInPolygon, type Point } from './geo';

/**
 * City-owned GIS coverage analysis and population-weighted prioritisation.
 *
 * Input is City data only: assets, incidents and operator-supplied public
 * population figures for an area. The calculation is deterministic and
 * documented here so the API response can be reproduced:
 *
 *   requiredAssets   = ceil(population / targetPopulationPerAsset)
 *   coverageRatio    = min(1, assetCount / requiredAssets)
 *   coverageGap      = 1 - coverageRatio
 *   incidentPressure = min(1, openIncidents / max(1, assetCount))
 *   demandPressure   = min(1, (population / max(1, assetCount)) / targetPopulationPerAsset)
 *   gapScore         = round(100 * (0.5*coverageGap + 0.3*incidentPressure + 0.2*demandPressure))
 *
 * An asset serves an area when its point lies inside the area geometry or within
 * `serviceRadiusMeters` of it (vertex distance). Missing asset types requested by
 * the caller are reported in `missing_asset_types`.
 */

export interface CoverageAreaInput {
  name: string;
  population: number;
  bbox?: { minLng: number; minLat: number; maxLng: number; maxLat: number };
  polygon?: Array<[number, number]>;
  asset_types?: string[];
}

export interface CoverageAsset {
  id: string;
  feature_type: string;
  point: Point | null;
}

export interface CoverageIncident {
  id: string;
  status: string;
  point: Point | null;
  reported_at?: string;
}

export interface AreaCoverage {
  area: string;
  population: number;
  asset_count: number;
  assets_by_type: Record<string, number>;
  missing_asset_types: string[];
  population_per_asset: number;
  incident_count: number;
  open_incident_count: number;
  gap_score: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
}

export interface CoverageReport {
  generated_at: string;
  service_radius_meters: number;
  target_population_per_asset: number;
  areas: AreaCoverage[];
}

const DEFAULT_SERVICE_RADIUS_METERS = 500;
const DEFAULT_TARGET_POPULATION_PER_ASSET = 2000;

function priorityFor(score: number): AreaCoverage['priority'] {
  if (score >= 70) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function distanceToBoxMeters(point: Point, box: NonNullable<CoverageAreaInput['bbox']>): number {
  const clampedLat = Math.min(Math.max(point.latitude, Math.min(box.minLat, box.maxLat)), Math.max(box.minLat, box.maxLat));
  const clampedLng = Math.min(Math.max(point.longitude, Math.min(box.minLng, box.maxLng)), Math.max(box.minLng, box.maxLng));
  return haversineMeters(point, { longitude: clampedLng, latitude: clampedLat });
}

function distanceToPolygonMeters(point: Point, polygon: Array<[number, number]>): number {
  if (pointInPolygon(point, polygon)) return 0;
  return Math.min(...polygon.map(([lng, lat]) => haversineMeters(point, { longitude: lng, latitude: lat })));
}

function serves(asset: CoverageAsset, area: CoverageAreaInput, radiusMeters: number): boolean {
  if (!asset.point) return false;
  if (area.polygon && area.polygon.length >= 3) return distanceToPolygonMeters(asset.point, area.polygon) <= radiusMeters;
  if (area.bbox) {
    if (pointInBoundingBox(asset.point, area.bbox)) return true;
    return distanceToBoxMeters(asset.point, area.bbox) <= radiusMeters;
  }
  return false;
}

function incidentInArea(incident: CoverageIncident, area: CoverageAreaInput): boolean {
  if (!incident.point) return false;
  if (area.polygon && area.polygon.length >= 3) return pointInPolygon(incident.point, area.polygon);
  if (area.bbox) return pointInBoundingBox(incident.point, area.bbox);
  return false;
}

export function analyseCoverage(input: {
  areas: CoverageAreaInput[];
  assets: CoverageAsset[];
  incidents: CoverageIncident[];
  serviceRadiusMeters?: number;
  targetPopulationPerAsset?: number;
  now?: number;
}): CoverageReport {
  const radius = Number.isFinite(input.serviceRadiusMeters) && Number(input.serviceRadiusMeters) > 0
    ? Number(input.serviceRadiusMeters)
    : DEFAULT_SERVICE_RADIUS_METERS;
  const target = Number.isFinite(input.targetPopulationPerAsset) && Number(input.targetPopulationPerAsset) > 0
    ? Number(input.targetPopulationPerAsset)
    : DEFAULT_TARGET_POPULATION_PER_ASSET;
  const now = input.now ?? Date.now();
  const windowStart = now - 30 * 86_400_000;

  const areas = input.areas.map((area): AreaCoverage => {
    const population = Math.max(0, Number(area.population) || 0);
    const requestedTypes = Array.isArray(area.asset_types) ? area.asset_types.map(String) : [];
    const served = input.assets.filter((asset) => serves(asset, area, radius));
    const assetsByType: Record<string, number> = {};
    for (const asset of served) {
      const type = String(asset.feature_type || 'infrastructure');
      assetsByType[type] = (assetsByType[type] || 0) + 1;
    }
    const missing = requestedTypes.filter((type) => !assetsByType[type]);
    const assetCount = served.length;
    const incidents = input.incidents.filter((incident) => incidentInArea(incident, area));
    const openIncidents = incidents.filter((incident) => {
      if (['resolved', 'closed', 'rejected'].includes(String(incident.status || '').toLowerCase())) return false;
      if (!incident.reported_at) return true;
      const reported = Date.parse(incident.reported_at);
      return !Number.isFinite(reported) || reported >= windowStart;
    });

    const requiredAssets = Math.max(1, Math.ceil(population / target));
    const coverageRatio = Math.min(1, assetCount / requiredAssets);
    const coverageGap = 1 - coverageRatio;
    const incidentPressure = Math.min(1, openIncidents.length / Math.max(1, assetCount));
    const demandPressure = Math.min(1, (population / Math.max(1, assetCount)) / target);
    const gapScore = Math.round(100 * (0.5 * coverageGap + 0.3 * incidentPressure + 0.2 * demandPressure));

    return {
      area: area.name,
      population,
      asset_count: assetCount,
      assets_by_type: assetsByType,
      missing_asset_types: missing,
      population_per_asset: assetCount > 0 ? Math.round(population / assetCount) : population,
      incident_count: incidents.length,
      open_incident_count: openIncidents.length,
      gap_score: gapScore,
      priority: priorityFor(gapScore),
    };
  });

  areas.sort((a, b) => b.gap_score - a.gap_score);
  return {
    generated_at: new Date(now).toISOString(),
    service_radius_meters: radius,
    target_population_per_asset: target,
    areas,
  };
}
