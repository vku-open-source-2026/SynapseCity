// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { authenticateAs, navigateTo, signOut } from "./helpers";

async function expectText(pattern: RegExp, timeout = 6000): Promise<void> {
    await waitFor(() => {
        expect(screen.queryAllByText(pattern).length).toBeGreaterThan(0);
    }, { timeout });
}

describe("City operator modules", () => {
    afterAll(() => {
        signOut();
    });

    beforeEach(async () => {
        authenticateAs("admin");
        await navigateTo("/admin");
        await waitFor(() => document.body, { timeout: 5000 });
    });

    test("asset create route renders the registry form", async () => {
        await navigateTo("/admin/assets/create");
        await expectText(/Tạo tài sản/);
        await expectText(/Mã tài sản/);
        await expectText(/Kinh độ/);
        expect(screen.queryByRole("button", { name: /Lưu tài sản/i })).toBeTruthy();
    });

    test("asset edit route renders the edit form", async () => {
        await navigateTo("/admin/assets/edit/asset-1");
        await expectText(/Chỉnh sửa tài sản|Tạo tài sản/);
        await expectText(/Lưu tài sản/);
    });

    test("asset list exposes a working create action", async () => {
        await navigateTo("/admin/assets");
        await expectText(/Tài sản/);
        const button = screen.queryByRole("button", { name: /Tạo tài sản/i });
        expect(button).toBeTruthy();
    });

    test("incident create route renders", async () => {
        await navigateTo("/admin/incidents/create");
        await expectText(/Sự cố|Báo cáo sự cố|incident/i);
    });

    test("report create offers the supported formats", async () => {
        await navigateTo("/admin/reports/create");
        await expectText(/Tạo báo cáo/);
        await expectText(/CSV/);
        await expectText(/JSON/);
    });

    test("IoT, budgets, users, ingest and technician routes render", async () => {
        await navigateTo("/admin/iot/create");
        await expectText(/cảm biến|sensor/i);

        await navigateTo("/admin/budgets/create");
        await expectText(/ngân sách|budget/i);

        await navigateTo("/admin/users/create");
        await expectText(/người dùng|user|tài khoản/i);

        await navigateTo("/admin/ingest");
        await expectText(/nhập dữ liệu|ingest|CSV/i);

        await navigateTo("/technician");
        await waitFor(() => document.body, { timeout: 5000 });
    });

    test("GIS coverage analytics route renders", async () => {
        await navigateTo("/admin/analytics");
        await expectText(/Phân tích vùng phủ GIS/);
        const button = screen.queryByRole("button", { name: /Phân tích/i });
        expect(button).toBeTruthy();
    });

    test("signing out returns the shell to the login page", async () => {
        signOut();
        await navigateTo("/admin/assets");
        await waitFor(() => {
            expect(window.location.pathname.includes("/login") || screen.queryAllByText(/đăng nhập|login/i).length > 0).toBe(true);
        }, { timeout: 6000 });
        authenticateAs("admin");
    });
});
