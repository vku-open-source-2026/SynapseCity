// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, it } from 'vitest';
import {
  bearingDegrees,
  distanceMeters,
  firstPoint,
  formatDistance,
  pointInDirection,
} from '../geo';
import { parseAssetCode, parseNfcRecords } from '../scan';
import { parseDeepLink } from '../deepLink';

describe('geo', () => {
  it('measures one degree of latitude at about 111 km', () => {
    const distance = distanceMeters(
      { latitude: 16, longitude: 108 },
      { latitude: 17, longitude: 108 },
    );
    expect(distance).toBeGreaterThan(110_000);
    expect(distance).toBeLessThan(112_500);
  });

  it('formats metres and kilometres', () => {
    expect(formatDistance(120)).toBe('120 m');
    expect(formatDistance(999)).toBe('1.0 km');
    expect(formatDistance(2_450)).toBe('2.5 km');
  });

  it('extracts the first point from nested geometry', () => {
    expect(firstPoint({ type: 'Polygon', coordinates: [[[108.2, 16.0], [108.3, 16.1]]] })).toEqual({
      longitude: 108.2,
      latitude: 16.0,
    });
  });

  it('returns a bounded relative position', () => {
    const origin = { latitude: 16, longitude: 108 };
    const position = pointInDirection(origin, { latitude: 16, longitude: 109 }, 5_000);
    expect(position.x).toBeCloseTo(1, 1);
    expect(position.y).toBeCloseTo(0, 1);
    expect(Math.abs(bearingDegrees(origin, { latitude: 17, longitude: 108 }) - 0)).toBeLessThan(1);
  });
});

describe('scan payload parsing', () => {
  it('accepts the public asset URL', () => {
    expect(parseAssetCode('https://synapsecity.sbs/asset/TRA-A65B10')).toBe('TRA-A65B10');
  });

  it('accepts the app scheme and raw code', () => {
    expect(parseAssetCode('synapsecity://asset/TRA-A65B10')).toBe('TRA-A65B10');
    expect(parseAssetCode('TRA-A65B10')).toBe('TRA-A65B10');
  });

  it('accepts JSON QR payloads', () => {
    expect(parseAssetCode('{"asset_code":"TRA-A65B16"}')).toBe('TRA-A65B16');
  });

  it('rejects unrelated payloads', () => {
    expect(parseAssetCode('https://example.com/hello')).toBeNull();
    expect(parseAssetCode('')).toBeNull();
  });

  it('decodes an NFC URI record with the https prefix byte', () => {
    const text = 'synapsecity.sbs/asset/TRA-A65B10';
    const bytes = [0x04, ...Array.from(new TextEncoder().encode(text))];
    expect(parseNfcRecords([{ payload: bytes }])).toBe('TRA-A65B10');
  });
});

describe('deep links', () => {
  it('routes asset, scan and report links', () => {
    expect(parseDeepLink('synapsecity://asset/TRA-A65B10')).toEqual({
      name: 'asset',
      params: { code: 'TRA-A65B10' },
    });
    expect(parseDeepLink('synapsecity://scan')).toEqual({ name: 'scan' });
    expect(parseDeepLink('synapsecity://report/TRA-A65B10')).toEqual({
      name: 'report',
      params: { assetCode: 'TRA-A65B10' },
    });
  });

  it('ignores unknown links', () => {
    expect(parseDeepLink('https://example.com')).toBeNull();
    expect(parseDeepLink(null)).toBeNull();
  });
});
