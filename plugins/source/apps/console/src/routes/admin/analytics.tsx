// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import CoverageAnalytics from "@/pages/admin/CoverageAnalytics";

export const Route = createFileRoute("/admin/analytics")({
    component: CoverageAnalytics,
});
