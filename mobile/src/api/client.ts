// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export const DEFAULT_API_BASE = 'https://synapsecity.sbs/v1';

function normalizeBase(value: string): string {
  return value.replace(/\/+$/, '');
}

export const API_BASE = normalizeBase(
  process.env.EXPO_PUBLIC_API_BASE_URL || DEFAULT_API_BASE,
);

export const PUBLIC_ORIGIN = API_BASE.replace(/\/v1$/, '');

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;

  constructor(status: number, code: string, detail?: string) {
    super(detail || code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  token?: string | null;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

type ErrorBody = {
  error?: string;
  detail?: string;
  message?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  try {
    const response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      const body = asRecord(parsed) as ErrorBody | null;
      throw new ApiError(
        response.status,
        String(body?.error || body?.message || `http_${response.status}`),
        body?.detail,
      );
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(0, 'timeout', 'Máy chủ phản hồi quá chậm. Vui lòng thử lại.');
    }
    throw new ApiError(0, 'network_error', 'Không kết nối được máy chủ SynapseCity.');
  } finally {
    clearTimeout(timeout);
  }
}

export function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  const record = asRecord(value);
  if (!record) return [];
  for (const key of ['data', 'items', 'results']) {
    if (Array.isArray(record[key])) return record[key] as T[];
  }
  return [];
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'timeout') return 'Máy chủ phản hồi quá chậm. Vui lòng thử lại.';
    if (error.code === 'network_error') return 'Không có kết nối tới SynapseCity. Kiểm tra mạng và thử lại.';
    if (error.status === 401) return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
    if (error.status === 403) return 'Tài khoản không có quyền cho thao tác này.';
    if (error.status === 404) return 'Không tìm thấy dữ liệu trên hệ thống.';
    if (error.status === 429) return 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.';
    if (error.status >= 500) return 'SynapseCity đang gặp sự cố tạm thời. Vui lòng thử lại.';
    return error.detail || error.code.replaceAll('_', ' ');
  }
  if (error instanceof Error) return error.message;
  return 'Đã xảy ra lỗi không xác định.';
}
