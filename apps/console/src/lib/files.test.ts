// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.hoisted(() => vi.fn());

vi.mock("./httpClient", () => ({
    httpClient: { post },
}));

import { FileUploadError, uploadFile, uploadPublicFile } from "./files";

const uploaded = {
    file_id: "file-123",
    file_url: "https://synapsecity.sbs/v1/files/file-123/content",
    filename: "lamp.png",
    content_type: "image/png",
    size: 4,
    checksum_sha256: "a".repeat(64),
};

describe("files capability client", () => {
    beforeEach(() => {
        post.mockReset();
        post.mockResolvedValue({ data: uploaded });
    });

    it("uploads operator bytes to the City files adapter", async () => {
        const file = new File([new Uint8Array([1, 2, 3, 4])], "lamp.png", { type: "image/png" });
        const result = await uploadFile(file);
        expect(result.file_id).toBe("file-123");
        expect(post).toHaveBeenCalledTimes(1);
        const [path, body, config] = post.mock.calls[0];
        expect(path).toBe("/files/upload");
        expect(body).toBeInstanceOf(ArrayBuffer);
        expect(config.headers["Content-Type"]).toBe("image/png");
        expect(config.headers["X-File-Name"]).toBe("lamp.png");
        expect(String(config.headers["X-Checksum-SHA256"])).toMatch(/^[a-f0-9]{64}$/);
        expect(config.headers["X-File-Visibility"]).toBeUndefined();
    });

    it("uploads anonymous photos to the public endpoint and marks them public", async () => {
        const file = new File([new Uint8Array([9])], "pothole.png", { type: "image/png" });
        await uploadPublicFile(file);
        const [path, , config] = post.mock.calls[0];
        expect(path).toBe("/public/files");
        expect(config.headers["X-File-Visibility"]).toBe("public");
    });

    it("surfaces the server error code instead of pretending the upload succeeded", async () => {
        post.mockRejectedValue({ response: { status: 415, data: { error: "unsupported_file_type" } } });
        const file = new File([new Uint8Array([1])], "run.sh", { type: "application/x-sh" });
        await expect(uploadFile(file)).rejects.toBeInstanceOf(FileUploadError);
        await expect(uploadFile(file)).rejects.toMatchObject({ status: 415, code: "unsupported_file_type" });
    });
});
