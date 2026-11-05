// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Explainable asset criticality and outage-risk scoring (#29).
 *
 * Every score is a weighted sum of explicit factors. Missing or stale sensor
 * data lowers confidence and is surfaced as a flag; it is never silently
 * replaced with a healthy default. Recommended work orders always pass through
 * the HITL approval capability.
 */

export interface CriticalityInput {
  service_impact?: number;
  population_served?: number;
  redundancy?: number;
  safety_impact?: number;
}

export interface RiskSensorReading {
  metric?: string;
  value?: number;
  unit?: string;
  min?: number;
  max?: number;
  observed_at?: string;
}

export interface RiskFactor {
  name: string;
  weight: number;
  score: number;
  explanation: string;
}

export interface AssetRiskResult {
  asset_id: string;
  score: number;
  band: 'low' | 'moderate' | 'high' | 'critical';
  confidence: number;
  factors: RiskFactor[];
  flags: string[];
  criticality: { score: number; normalized: Required<CriticalityInput> };
  data_freshness: { sensor_observed_at: string | null; age_minutes: number | null; stale: boolean };
  recommendations: string[];
}

const CLOSED_INCIDENTS = new Set(['resolved', 'closed', 'cancelled', 'canceled']);

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function criticalityNormalized(input: CriticalityInput): Required<CriticalityInput> {
  const service = Math.max(1, Math.min(5, Number(input.service_impact ?? 3)));
  const population = Math.max(0, Number(input.population_served ?? 0));
  const redundancy = Math.max(1, Math.min(5, Number(input.redundancy ?? 3)));
  const safety = Math.max(1, Math.min(5, Number(input.safety_impact ?? 3)));
  return { service_impact: service, population_served: population, redundancy, safety_impact: safety };
}

export function criticalityScore(input: CriticalityInput): number {
  const n = criticalityNormalized(input);
  const service = ((n.service_impact - 1) / 4) * 100;
  const population = clamp((Math.log10(1 + n.population_served) / Math.log10(1 + 1_000_000)) * 100);
  const redundancy = ((5 - n.redundancy) / 4) * 100;
  const safety = ((n.safety_impact - 1) / 4) * 100;
  return Math.round(service * 0.35 + population * 0.25 + redundancy * 0.2 + safety * 0.2);
}

export function scoreAssetRisk(input: {
  asset: Record<string, any>;
  incidents?: Array<Record<string, any>>;
  maintenance?: Array<Record<string, any>>;
  sensors?: RiskSensorReading[];
  now?: number;
  staleAfterMinutes?: number;
}): AssetRiskResult {
  const now = input.now ?? Date.now();
  const staleAfterMinutes = input.staleAfterMinutes ?? 180;
  const asset = input.asset || {};
  const criticality = criticalityNormalized((asset.criticality || {}) as CriticalityInput);
  const criticalityValue = criticalityScore(criticality);
  const factors: RiskFactor[] = [{
    name: 'criticality', weight: 0.35, score: criticalityValue,
    explanation: `service ${criticality.service_impact}/5 · population ${criticality.population_served} · redundancy ${criticality.redundancy}/5 · safety ${criticality.safety_impact}/5`,
  }];

  const health = Number(asset.health_score ?? asset.condition_score ?? 70);
  const conditionRisk = clamp(100 - (Number.isFinite(health) ? health : 70));
  factors.push({ name: 'condition', weight: 0.25, score: conditionRisk, explanation: `health score ${Number.isFinite(health) ? health : 'unknown'}` });

  const openIncidents = (input.incidents || []).filter((incident) => !CLOSED_INCIDENTS.has(String(incident.status || '').toLowerCase()));
  const incidentRisk = clamp(openIncidents.length * 18);
  factors.push({ name: 'incidents', weight: 0.2, score: incidentRisk, explanation: `${openIncidents.length} open incident${openIncidents.length === 1 ? '' : 's'}` });

  const maintenanceRisk = (() => {
    const open = (input.maintenance || []).filter((order) => !['completed', 'cancelled', 'closed'].includes(String(order.status || '').toLowerCase()));
    let worst = 0;
    for (const order of open) {
      const due = Date.parse(String(order.scheduled_date || order.due_date || ''));
      if (Number.isFinite(due)) {
        const overdueDays = Math.max(0, (now - due) / 86_400_000);
        worst = Math.max(worst, clamp(overdueDays * 2 + 25));
      } else {
        worst = Math.max(worst, 30);
      }
    }
    return worst;
  })();
  factors.push({ name: 'maintenance', weight: 0.15, score: maintenanceRisk, explanation: maintenanceRisk > 0 ? 'open preventive/corrective work exists' : 'no overdue work orders' });

  const flags: string[] = [];
  let sensorRisk = 0;
  let confidencePenalty = 0;
  let latestObservation: string | null = null;
  let latestAge: number | null = null;
  for (const reading of input.sensors || []) {
    const observed = Date.parse(String(reading.observed_at || ''));
    if (Number.isFinite(observed)) {
      const ageMinutes = Math.max(0, (now - observed) / 60_000);
      if (latestAge === null || ageMinutes < latestAge) {
        latestAge = ageMinutes;
        latestObservation = new Date(observed).toISOString();
      }
      if (ageMinutes > staleAfterMinutes) {
        flags.push('stale_sensor_data');
        confidencePenalty += 0.15;
      }
    } else {
      flags.push('missing_sensor_timestamp');
      confidencePenalty += 0.1;
    }
    const value = Number(reading.value);
    const min = Number(reading.min);
    const max = Number(reading.max);
    if (Number.isFinite(value) && Number.isFinite(min) && value < min) sensorRisk = Math.max(sensorRisk, 80);
    if (Number.isFinite(value) && Number.isFinite(max) && value > max) sensorRisk = Math.max(sensorRisk, 80);
  }
  if (!(input.sensors || []).length) {
    flags.push('no_sensor_data');
    confidencePenalty += 0.25;
  }
  factors.push({ name: 'sensor', weight: 0.05, score: sensorRisk, explanation: sensorRisk ? 'reading outside configured range' : 'no threshold breach' });

  const score = Math.round(factors.reduce((sum, factor) => sum + factor.score * factor.weight, 0));
  const band = score >= 75 ? 'critical' : score >= 55 ? 'high' : score >= 35 ? 'moderate' : 'low';
  const confidence = Math.max(0.1, Math.min(1, 1 - confidencePenalty));
  const recommendations: string[] = [];
  if (score >= 55) recommendations.push('Schedule an inspection within 7 days.');
  if (maintenanceRisk >= 50) recommendations.push('Create a prioritized work order for the overdue maintenance.');
  if (sensorRisk >= 50) recommendations.push('Check the sensor reading and dispatch a technician if confirmed.');
  if (!recommendations.length) recommendations.push('Continue routine monitoring; no immediate action required.');

  return {
    asset_id: String(asset.id || asset.asset_code || ''),
    score, band, confidence: Number(confidence.toFixed(2)), factors, flags: [...new Set(flags)],
    criticality: { score: criticalityValue, normalized: criticality },
    data_freshness: {
      sensor_observed_at: latestObservation,
      age_minutes: latestAge === null ? null : Math.round(latestAge),
      stale: latestAge !== null && latestAge > staleAfterMinutes,
    },
    recommendations,
  };
}

export function rankAssetsByRisk(results: AssetRiskResult[]): AssetRiskResult[] {
  return [...results].sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.asset_id.localeCompare(b.asset_id));
}
