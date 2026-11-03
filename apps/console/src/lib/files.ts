// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

/**
 * Read a browser File as a data URL so photo/document metadata can be sent as
 * JSON. The City service has no multipart or blob-store dependency; data URLs
 * keep the retained screens working while preserving the JSON-only API.
 */
export function readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
            if (typeof reader.result === "string") {
                resolve(reader.result);
            } else {
                reject(new Error("file_read_failed"));
            }
        };
        reader.onerror = () => reject(reader.error ?? new Error("file_read_failed"));
        reader.readAsDataURL(file);
    });
}
