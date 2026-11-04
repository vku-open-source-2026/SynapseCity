// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createHash } from 'node:crypto';
/**
 * File references and the Tier-2 files capability boundary.
 *
 * Binary content lives in Tier-1 object storage, reached through the Tier-2
 * `files` capability (SynapseDX #9). A City record keeps only a stable file id,
 * a City download URL and non-secret metadata (name, MIME, size, checksum).
 * `data:` URLs are rejected on every write path.
 */

export const FILES_DEPENDENCY = 'https://github.com/vku-open-source-2026/SynapseDX/issues/9';

export class CapabilityUnavailableError extends Error {
  status = 503;
  code: string;
  dependency: string;
  constructor(message: string, dependency: string) {
    super(message);
    this.name = 'CapabilityUnavailableError';
    this.code = message;
    this.dependency = dependency;
  }
}

export class InvalidFileReferenceError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = 'InvalidFileReferenceError';
    this.status = status;
  }
}

export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'text/csv',
  'text/plain',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;

/** Any MIME type a City attachment may carry (photos + documents). */
export const UPLOAD_MIME_TYPES = [...IMAGE_MIME_TYPES, ...DOCUMENT_MIME_TYPES] as const;

const MAX_REFERENCE_LENGTH = 2048;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export function isDataUrl(value: string): boolean {
  return /^data:/i.test(value.trim());
}

/**
 * Tier-2 0.3.0 publishes the `files` capability, so the adapter is available.
 * The actual availability of storage/presign is reported by the per-call error,
 * never assumed.
 */
export function filesCapabilityAvailable(): boolean {
  return true;
}

export function filesCapabilityStatus(): {
  status: 'available';
  transport: 'synapsedx';
  presign: 'optional';
  links: string[];
  maxBytes: number;
  allowedTypes: readonly string[];
} {
  return {
    status: 'available',
    transport: 'synapsedx',
    presign: 'optional',
    links: ['POST /v1/files', 'POST /v1/files/upload', 'GET /v1/files/:id/content', 'POST /v1/files/:id/presign'],
    maxBytes: fileMaxBytes(),
    allowedTypes: UPLOAD_MIME_TYPES,
  };
}

/** Maximum upload size accepted by City before calling Tier-2. */
export function fileMaxBytes(): number {
  const configured = Number(process.env.CITY_FILES_MAX_BYTES || DEFAULT_MAX_BYTES);
  return Number.isFinite(configured) && configured >= 1024 ? Math.floor(configured) : DEFAULT_MAX_BYTES;
}

/** Largest allowed request body on the edge/gateway for a binary upload. */
export function fileRequestLimit(): number {
  return fileMaxBytes() + 1024 * 1024;
}

export function fileMaxBytesFor(kind: 'photo' | 'document'): number {
  const configured = kind === 'photo' ? process.env.CITY_PHOTO_MAX_BYTES : process.env.CITY_DOCUMENT_MAX_BYTES;
  const parsed = Number(configured || fileMaxBytes());
  return Number.isFinite(parsed) && parsed >= 1024 ? Math.floor(parsed) : fileMaxBytes();
}

/**
 * Validate an already-stored file reference. Legacy external HTTPS references
 * remain readable; new uploads must use the files capability.
 */
export function assertStoredFileReference(value: unknown, options: { mimeTypes?: readonly string[]; field?: string } = {}): string {
  const field = options.field || 'file_url';
  const url = String(value || '').trim();
  if (!url) throw new InvalidFileReferenceError(`${field}_required`);
  if (isDataUrl(url)) {
    throw new InvalidFileReferenceError('data_url_not_supported', 415);
  }
  if (/^(blob|file|javascript):/i.test(url)) {
    throw new InvalidFileReferenceError('unsupported_file_scheme', 415);
  }
  if (url.length > MAX_REFERENCE_LENGTH) throw new InvalidFileReferenceError('file_url_too_long', 413);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidFileReferenceError('file_url_must_be_absolute');
  }
  if (parsed.protocol !== 'https:' && !(process.env.ALLOW_LOCAL_DEPENDENCIES === 'true' && parsed.protocol === 'http:')) {
    throw new InvalidFileReferenceError('file_url_must_use_https');
  }
  return url;
}

export function assertMimeType(value: unknown, allowlist: readonly string[]): string {
  const type = String(value || '').trim().toLowerCase();
  if (!type || type.endsWith('/*')) return allowlist[0];
  if (!allowlist.includes(type)) throw new InvalidFileReferenceError('unsupported_file_type', 415);
  return type;
}

/**
 * A bare reference without a scheme is treated as a City/Tier-2 file id. This
 * is what the console sends after uploading through `POST /v1/files/upload`.
 */
export function looksLikeFileId(value: string): boolean {
  const candidate = String(value || '').trim();
  return Boolean(candidate) && !candidate.includes('://') && !candidate.includes('/') && /^[A-Za-z0-9_-]{8,80}$/.test(candidate);
}

/** Extract a Tier-2/City file id from a stored City download URL. */
export function fileIdFromReference(value: string): string | null {
  const raw = String(value || '').trim();
  if (looksLikeFileId(raw)) return raw;
  const match = /\/(?:v1\/files|v1\/public\/files|v1\/capabilities\/files)\/([A-Za-z0-9_-]{8,80})(?:\/content)?(?:[?#].*)?$/.exec(raw);
  return match ? match[1] : null;
}

export function cityFileUrl(fileId: string, options: { public?: boolean; baseUrl?: string } = {}): string {
  const base = options.baseUrl || process.env.CITY_PUBLIC_URL || 'https://synapsecity.sbs';
  const prefix = options.public ? '/v1/public/files' : '/v1/files';
  return `${base.replace(/\/$/, '')}${prefix}/${encodeURIComponent(fileId)}/content`;
}

export interface UploadValidation {
  filename: string;
  contentType: string;
  size: number;
}

/**
 * Validate an upload before any bytes leave City. Filenames are stripped of
 * path separators, MIME types must be on the attachment allow-list, and the
 * size must fit the City limit.
 */
export function validateUpload(input: {
  filename: unknown;
  contentType: unknown;
  size: unknown;
  allowlist?: readonly string[];
  maxBytes?: number;
}): UploadValidation {
  const filename = String(input.filename || '').trim();
  if (!filename) throw new InvalidFileReferenceError('filename_required');
  if (filename.length > 255) throw new InvalidFileReferenceError('filename_too_long');
  if (/[/\\\0-\x1f\x7f]/.test(filename) || filename === '.' || filename === '..') {
    throw new InvalidFileReferenceError('filename_must_be_plain');
  }
  const allowlist = input.allowlist || UPLOAD_MIME_TYPES;
  const contentType = assertMimeType(input.contentType, allowlist);
  const maxBytes = input.maxBytes || fileMaxBytes();
  const size = Number(input.size);
  if (input.size !== undefined && input.size !== null && input.size !== '' && (!Number.isInteger(size) || size < 0)) {
    throw new InvalidFileReferenceError('size_must_be_non_negative_integer');
  }
  const resolvedSize = Number.isFinite(size) && size > 0 ? size : 0;
  if (resolvedSize > maxBytes) {
    throw Object.assign(new InvalidFileReferenceError('file_too_large', 413), { maxBytes });
  }
  return { filename, contentType, size: resolvedSize };
}

export function checksumOf(bytes: Uint8Array): string {
  // Kept in this module so the City adapter and its tests share one implementation.
  return createHash('sha256').update(bytes).digest('hex');
}

export function normalizeChecksum(value: unknown): string | undefined {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return undefined;
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new InvalidFileReferenceError('checksum_must_be_sha256_hex');
  return raw;
}

const INLINE_BINARY_KEYS = new Set(['content_base64', 'file_content', 'fileContent', 'contentBase64']);
const FILE_REFERENCE_KEYS = new Set(['photo', 'photos', 'file_url', 'fileUrl', 'url', 'attachments', 'attachment', 'file_type', 'file_name']);

/**
 * Reject inline binary anywhere in a write payload. This is the final guard
 * that keeps a `data:` URL or base64 body out of every `city-*` record, even on
 * a PATCH path that does not go through the attachment helper.
 */
export function assertNoInlineBinary(value: unknown, path = 'payload', keyHint = ''): void {
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoInlineBinary(entry, `${path}[${index}]`, keyHint));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      assertNoInlineBinary(entry, `${path}.${key}`, key);
    }
    return;
  }
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  const isReferenceField = !keyHint || FILE_REFERENCE_KEYS.has(keyHint);
  if (isReferenceField && /^data:[a-z0-9.+/-]+;base64,/i.test(trimmed)) {
    throw new InvalidFileReferenceError('data_url_not_supported', 415);
  }
  if (INLINE_BINARY_KEYS.has(keyHint) && trimmed) {
    throw new InvalidFileReferenceError('inline_binary_not_accepted', 415);
  }
}

export function fileKindFor(contentType: string): 'photo' | 'document' {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(String(contentType).toLowerCase()) ? 'photo' : 'document';
}

/** Reject raw uploads with a typed capability error rather than a fake success. */
export function rejectRawUpload(kind: 'photo' | 'document' = 'photo'): never {
  throw new CapabilityUnavailableError(
    kind === 'photo' ? 'photo_upload_capability_unavailable' : 'document_upload_capability_unavailable',
    FILES_DEPENDENCY,
  );
}
