// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

const URI_PREFIXES = [
  '',
  'http://www.',
  'https://www.',
  'http://',
  'https://',
  'tel:',
  'mailto:',
  'ftp://anonymous:anonymous@',
  'ftp://ftp.',
  'ftps://',
  'sftp://',
  'smb://',
  'nfs://',
  'ftp://',
  'dav://',
  'news:',
  'telnet://',
  'imap:',
  'rtsp://',
  'urn:',
  'pop:',
  'sip:',
  'sips:',
  'tftp:',
  'btspp://',
  'btl2cap://',
  'btgoep://',
  'tcpobex://',
  'irdaobex://',
  'file://',
  'urn:epc:id:',
  'urn:epc:tag:',
  'urn:epc:pat:',
  'urn:epc:raw:',
  'urn:epc:',
  'urn:nfc:',
];

export function decodeNdefUriPayload(payload: unknown): string | null {
  if (typeof payload === 'string') {
    const hex = payload.replace(/\s+/g, '');
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
      const bytes = new Uint8Array(hex.length / 2);
      for (let i = 0; i < bytes.length; i += 1) {
        bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      }
      return decodeNdefUriPayload(Array.from(bytes));
    }
    return payload;
  }
  if (Array.isArray(payload)) {
    const bytes = payload.map((value) => Number(value) & 0xff);
    if (bytes.length === 0) return null;
    const prefix = URI_PREFIXES[bytes[0]] ?? '';
    try {
      return prefix + new TextDecoder().decode(new Uint8Array(bytes.slice(1)));
    } catch {
      return null;
    }
  }
  return null;
}

export function parseAssetCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;

  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const nested = parsed.asset_code ?? parsed.assetCode ?? parsed.code ?? parsed.url;
      if (typeof nested === 'string') return parseAssetCode(nested);
    } catch {
      // Not JSON; continue with URL/code parsing.
    }
  }

  for (const prefix of ['synapsecity://asset/', 'synapsecity://assets/', 'synapsecity://a/']) {
    if (value.toLowerCase().startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }

  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      const match = url.pathname.match(/\/asset\/([^/?#]+)/i);
      if (match) return decodeURIComponent(match[1]);
      const code = url.searchParams.get('asset_code') ?? url.searchParams.get('code');
      if (code) return code;
    }
  } catch {
    // Fall through to raw-code parsing.
  }

  const direct = value.match(/^(?:asset[:_-]?)?([A-Za-z0-9][A-Za-z0-9._-]{1,80})$/);
  if (direct) return direct[1];
  return null;
}

export function parseNfcRecords(records: Array<{ payload?: unknown; type?: unknown }> | undefined): string | null {
  if (!records) return null;
  for (const record of records) {
    const decoded = decodeNdefUriPayload(record.payload);
    const code = parseAssetCode(decoded);
    if (code) return code;
  }
  return null;
}
