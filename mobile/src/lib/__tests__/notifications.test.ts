// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import { meetsSeverityThreshold, shouldNotifyIncident } from '../notifications';

describe('incident notification preferences', () => {
  it('notifies nearby low/medium incidents only with the all threshold', () => {
    expect(shouldNotifyIncident('low', 'all', 500)).toBe(true);
    expect(shouldNotifyIncident('medium', 'all', 1_999)).toBe(true);
    expect(shouldNotifyIncident('low', 'high', 500)).toBe(false);
    expect(shouldNotifyIncident('medium', 'high', 500)).toBe(false);
    expect(shouldNotifyIncident('low', 'critical', 500)).toBe(false);
  });

  it('notifies high incidents in all and high modes regardless of distance', () => {
    expect(shouldNotifyIncident('high', 'all', 20_000)).toBe(true);
    expect(shouldNotifyIncident('high', 'high', 20_000)).toBe(true);
    expect(shouldNotifyIncident('high', 'critical', 500)).toBe(false);
  });

  it('notifies critical incidents under every threshold', () => {
    for (const threshold of ['all', 'high', 'critical'] as const) {
      expect(shouldNotifyIncident('critical', threshold, null)).toBe(true);
    }
  });

  it('does not use proximity for low/medium incidents in high or critical mode', () => {
    expect(meetsSeverityThreshold('medium', 'high')).toBe(false);
    expect(meetsSeverityThreshold('high', 'critical')).toBe(false);
  });

  it('keeps the existing high/critical and 2 km proximity boundary for all mode', () => {
    expect(shouldNotifyIncident('medium', 'all', null)).toBe(false);
    expect(shouldNotifyIncident('medium', 'all', 2_000)).toBe(true);
    expect(shouldNotifyIncident('medium', 'all', 2_001)).toBe(false);
  });
});
