// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';

import {
  calculateHealthScore,
  calculateRemainingLifespan,
  getHealthScoreColor,
  getHealthScoreLabel,
  isMaintenanceDueSoon,
  isMaintenanceOverdue,
} from './healthScore';

const toDateInput = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
    date.getDate()
  ).padStart(2, '0')}`;

const daysFromToday = (days: number): string => {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return toDateInput(date);
};

describe('calculateHealthScore', () => {
  it('returns 100 when every weighted factor is perfect', () => {
    expect(
      calculateHealthScore({
        incident_frequency: 100,
        incident_severity: 100,
        maintenance_recency: 100,
        maintenance_cost_trend: 100,
        iot_sensor_alerts: 100,
      })
    ).toBe(100);
  });

  it('returns 0 when every weighted factor is zero', () => {
    expect(
      calculateHealthScore({
        incident_frequency: 0,
        incident_severity: 0,
        maintenance_recency: 0,
        maintenance_cost_trend: 0,
      })
    ).toBe(0);
  });

  it('redistributes the IoT weight when sensor alerts are unavailable', () => {
    const score = calculateHealthScore({
      incident_frequency: 80,
      incident_severity: 60,
      maintenance_recency: 40,
      maintenance_cost_trend: 20,
    });

    const expected =
      (80 * 0.25 + 60 * 0.25 + 40 * 0.2 + 20 * 0.15) / (0.25 + 0.25 + 0.2 + 0.15);

    expect(score).toBe(Math.round(expected));
  });

  it('clamps out-of-range input to the 0-100 interval', () => {
    expect(
      calculateHealthScore({
        incident_frequency: 500,
        incident_severity: 500,
        maintenance_recency: 500,
        maintenance_cost_trend: 500,
      })
    ).toBe(100);

    expect(
      calculateHealthScore({
        incident_frequency: -50,
        incident_severity: -50,
        maintenance_recency: -50,
        maintenance_cost_trend: -50,
      })
    ).toBe(0);
  });
});

describe('getHealthScoreColor', () => {
  it('maps score bands to traffic-light colours', () => {
    expect(getHealthScoreColor(100)).toBe('green');
    expect(getHealthScoreColor(80)).toBe('green');
    expect(getHealthScoreColor(79)).toBe('yellow');
    expect(getHealthScoreColor(60)).toBe('yellow');
    expect(getHealthScoreColor(59)).toBe('orange');
    expect(getHealthScoreColor(40)).toBe('orange');
    expect(getHealthScoreColor(39)).toBe('red');
  });
});

describe('getHealthScoreLabel', () => {
  it('maps score bands to Vietnamese labels', () => {
    expect(getHealthScoreLabel(80)).toBe('Xuất sắc');
    expect(getHealthScoreLabel(60)).toBe('Tốt');
    expect(getHealthScoreLabel(40)).toBe('Trung bình');
    expect(getHealthScoreLabel(20)).toBe('Kém');
    expect(getHealthScoreLabel(19)).toBe('Nguy kịch');
  });
});

describe('calculateRemainingLifespan', () => {
  it('returns the remaining share of the designed lifespan', () => {
    expect(calculateRemainingLifespan(5, 10)).toBe(50);
    expect(calculateRemainingLifespan(0, 25)).toBe(100);
  });

  it('never returns a negative or invalid percentage', () => {
    expect(calculateRemainingLifespan(15, 10)).toBe(0);
    expect(calculateRemainingLifespan(1, 0)).toBe(0);
  });
});

describe('isMaintenanceOverdue', () => {
  it('flags dates in the past', () => {
    expect(isMaintenanceOverdue(daysFromToday(-2))).toBe(true);
  });

  it('does not flag future dates', () => {
    expect(isMaintenanceOverdue(daysFromToday(10))).toBe(false);
  });
});

describe('isMaintenanceDueSoon', () => {
  it('flags maintenance scheduled inside the warning window', () => {
    expect(isMaintenanceDueSoon(daysFromToday(3), 7)).toBe(true);
  });

  it('ignores maintenance outside the window or already overdue', () => {
    expect(isMaintenanceDueSoon(daysFromToday(30), 7)).toBe(false);
    expect(isMaintenanceDueSoon(daysFromToday(-1), 7)).toBe(false);
  });
});
