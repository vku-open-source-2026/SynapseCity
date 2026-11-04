// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { httpClient } from "./httpClient";

/**
 * File uploads go through the City files adapter, which forwards the bytes to
 * the Tier-2 files capability (Tier-1 object storage). The browser never turns
 * a file into a `data:` URL and never stores bytes in a City record.
 */

export const FILE_UPLOAD_FAILED_MESSAGE =
    "Tải tệp lên thất bại. Vui lòng thử lại hoặc liên hệ quản trị viên.";

export class FileUploadError extends Error {
    readonly status?: number;
    readonly code?: string;

    constructor(message: string, options: { status?: number; code?: string } = {}) {
        super(message);
        this.name = "FileUploadError";
        this.status = options.status;
        this.code = options.code;
    }
}

export interface UploadedFile {
    file_id: string;
    id: string;
    file_url: string;
    download_url?: string;
    filename: string;
    content_type: string;
    size: number;
    checksum_sha256?: string;
}

function normalizeUploadedFile(value: unknown): UploadedFile {
    const record = (value || {}) as Record<string, unknown>;
    const id = String(record.file_id || record.id || "");
    if (!id) throw new FileUploadError("Phản hồi tải tệp không hợp lệ.");
    return {
        file_id: id,
        id,
        file_url: String(record.file_url || record.download_url || ""),
        ...(record.download_url ? { download_url: String(record.download_url) } : {}),
        filename: String(record.filename || record.file_name || ""),
        content_type: String(record.content_type || record.contentType || ""),
        size: Number(record.size) || 0,
        ...(record.checksum_sha256 || record.checksumSha256
            ? { checksum_sha256: String(record.checksum_sha256 || record.checksumSha256) }
            : {}),
    };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string | undefined> {
    try {
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return Array.from(new Uint8Array(digest))
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join("");
    } catch {
        return undefined;
    }
}

async function postFile(path: string, file: File, options: { isPublic?: boolean } = {}): Promise<UploadedFile> {
    if (!file) throw new FileUploadError("Chưa chọn tệp.");
    const bytes = await file.arrayBuffer();
    const checksum = await sha256Hex(bytes);
    const headers: Record<string, string> = {
        "Content-Type": file.type || "application/octet-stream",
        "X-File-Name": encodeURIComponent(file.name),
        ...(checksum ? { "X-Checksum-SHA256": checksum } : {}),
        ...(options.isPublic ? { "X-File-Visibility": "public" } : {}),
    };
    try {
        const response = await httpClient.post(path, bytes, { headers });
        return normalizeUploadedFile(response.data);
    } catch (error) {
        const response = (error as { response?: { status?: number; data?: Record<string, unknown> } }).response;
        const code = response?.data?.error ? String(response.data.error) : undefined;
        const detail = response?.data?.detail ? String(response.data.detail) : undefined;
        throw new FileUploadError(detail || code || FILE_UPLOAD_FAILED_MESSAGE, {
            status: response?.status,
            code,
        });
    }
}

/** Upload an operator file (asset photo/document, maintenance photo). */
export function uploadFile(file: File): Promise<UploadedFile> {
    return postFile("/files/upload", file);
}

/** Upload a photo attached to an anonymous citizen report. */
export function uploadPublicFile(file: File): Promise<UploadedFile> {
    return postFile("/public/files", file, { isPublic: true });
}

/** Validate that a reference is an absolute HTTPS URL. */
export function assertStoredFileUrl(value: string): string {
    const url = String(value || "").trim();
    if (!/^https:\/\//i.test(url)) {
        throw new Error("Tệp phải là URL HTTPS đã được lưu trên nền tảng.");
    }
    return url;
}
