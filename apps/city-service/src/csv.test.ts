// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import test from 'node:test';
import assert from 'node:assert/strict';
import { missingColumns, parseCsv, REQUIRED_ASSET_COLUMNS } from './csv';

test('parseCsv reads headers, quoted fields and CRLF rows', () => {
  const parsed = parseCsv('\uFEFFasset_code,name,address,properties\r\nA-1,"Lamp, main","1 ""Main"" St","{""lumens"":1200}"\r\nA-2,Hydrant,2 Main St,{}\r\n');
  assert.deepEqual(parsed.headers, ['asset_code', 'name', 'address', 'properties']);
  assert.equal(parsed.rows.length, 2);
  assert.equal(parsed.rows[0].name, 'Lamp, main');
  assert.equal(parsed.rows[0].address, '1 "Main" St');
  assert.equal(parsed.rows[0].properties, '{"lumens":1200}');
  assert.equal(parsed.rows[1].asset_code, 'A-2');
});

test('parseCsv ignores blank lines and trailing separators', () => {
  const parsed = parseCsv('asset_code,name\n\nA-1,Lamp\n\n');
  assert.equal(parsed.rows.length, 1);
  assert.equal(parsed.rows[0].name, 'Lamp');
});

test('parseCsv returns empty output for an empty document', () => {
  assert.deepEqual(parseCsv(''), { headers: [], rows: [] });
});

test('missingColumns reports the required CSV columns', () => {
  assert.deepEqual(missingColumns(['asset_code', 'name']), ['feature_type', 'feature_code', 'latitude', 'longitude']);
  assert.deepEqual(missingColumns(REQUIRED_ASSET_COLUMNS.slice()), []);
});
