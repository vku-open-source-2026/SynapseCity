// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { vietMapConfigured, vietMapKey, vietMapTileStyle } from './vietmap';

test('VietMap credentials stay server-side and styles are allowlisted', () => {
  const previousKey = process.env.VIETMAP_API_KEY;
  const previousStyle = process.env.VIETMAP_TILE_STYLE;
  try {
    delete process.env.VIETMAP_API_KEY;
    delete process.env.VIETMAP_TILE_STYLE;
    assert.equal(vietMapKey(), null);
    assert.equal(vietMapConfigured(), false);
    assert.equal(vietMapTileStyle(), 'tm');

    process.env.VIETMAP_API_KEY = '  test-key  ';
    process.env.VIETMAP_TILE_STYLE = 'DM';
    assert.equal(vietMapKey(), 'test-key');
    assert.equal(vietMapConfigured(), true);
    assert.equal(vietMapTileStyle(), 'dm');

    process.env.VIETMAP_TILE_STYLE = 'https://attacker.example/{z}/{x}/{y}';
    assert.equal(vietMapTileStyle(), 'tm');
  } finally {
    if (previousKey === undefined) delete process.env.VIETMAP_API_KEY;
    else process.env.VIETMAP_API_KEY = previousKey;
    if (previousStyle === undefined) delete process.env.VIETMAP_TILE_STYLE;
    else process.env.VIETMAP_TILE_STYLE = previousStyle;
  }
});
