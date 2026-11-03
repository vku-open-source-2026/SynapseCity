// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export interface ParsedCsv {
  headers: string[];
  rows: Record<string, string>[];
}

export const REQUIRED_ASSET_COLUMNS = ['asset_code', 'name', 'feature_type', 'feature_code', 'latitude', 'longitude'] as const;

/**
 * Minimal RFC 4180 style CSV parser.
 *
 * Supports quoted fields, escaped double quotes, LF/CRLF line endings and a
 * UTF-8 BOM. It intentionally stays dependency-free so the City service can
 * ingest the CSV files the console uploads without adding a multipart parser.
 */
export function parseCsv(input: string): ParsedCsv {
  const text = input.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim() !== '')) rows.push(row);
  }

  if (rows.length === 0) return { headers: [], rows: [] };

  const headers = rows[0].map((header) => header.trim().toLowerCase());
  const records = rows.slice(1).map((values) => {
    const record: Record<string, string> = {};
    headers.forEach((header, column) => {
      record[header] = (values[column] ?? '').trim();
    });
    return record;
  });
  return { headers, rows: records };
}

export function missingColumns(headers: string[], required: readonly string[] = REQUIRED_ASSET_COLUMNS): string[] {
  const present = new Set(headers.map((header) => header.trim().toLowerCase()));
  return required.filter((column) => !present.has(column));
}
