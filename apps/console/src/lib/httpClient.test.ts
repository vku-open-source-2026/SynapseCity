// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { describe, expect, test } from 'vitest';
import { asList } from './httpClient';

describe('asList', () => {
  test('returns arrays unchanged', () => {
    expect(asList([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test('returns [] for an HTML string returned with HTTP 200', () => {
    expect(asList('<!doctype html><html><body>console</body></html>')).toEqual([]);
  });

  test('returns [] for primitive and null payloads', () => {
    expect(asList('not-an-array')).toEqual([]);
    expect(asList(42)).toEqual([]);
    expect(asList(null)).toEqual([]);
    expect(asList(undefined)).toEqual([]);
  });

  test('unwraps common list envelopes', () => {
    expect(asList({ data: [1] })).toEqual([1]);
    expect(asList({ items: [2] })).toEqual([2]);
    expect(asList({ results: [3] })).toEqual([3]);
    expect(asList({ data: 'not-an-array' })).toEqual([]);
  });
});
