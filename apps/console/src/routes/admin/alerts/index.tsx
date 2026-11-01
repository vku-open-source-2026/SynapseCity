// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import AlertDashboard from "@/pages/alerts/AlertDashboard";

export const Route = createFileRoute("/admin/alerts/")({
    component: AlertDashboard,
});
