// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import { AdminLayout } from "../components/Layout/AdminLayout";
import { ProtectedRoute } from "../components/ProtectedRoute";

export const Route = createFileRoute("/admin")({
    component: () => (
        <ProtectedRoute>
            <AdminLayout />
        </ProtectedRoute>
    ),
});
