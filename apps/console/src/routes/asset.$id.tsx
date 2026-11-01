// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import AssetDetailPage from "../pages/AssetDetailPage";

export const Route = createFileRoute("/asset/$id")({
    component: AssetDetailPage,
});
