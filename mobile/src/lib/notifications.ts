// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { Severity } from '../api/types';
import type { AppSettings } from './storage';

const PROXIMITY_RADIUS_M = 2_000;

export function meetsSeverityThreshold(
  severity: Severity,
  threshold: AppSettings['severityThreshold'],
): boolean {
  if (threshold === 'critical') return severity === 'critical';
  if (threshold === 'high') return severity === 'high' || severity === 'critical';
  return true;
}

/** Apply the user's severity preference before considering the proximity fallback. */
export function shouldNotifyIncident(
  severity: Severity,
  threshold: AppSettings['severityThreshold'],
  distance: number | null,
): boolean {
  if (!meetsSeverityThreshold(severity, threshold)) return false;
  return (
    severity === 'high' ||
    severity === 'critical' ||
    (distance !== null && distance <= PROXIMITY_RADIUS_M)
  );
}
