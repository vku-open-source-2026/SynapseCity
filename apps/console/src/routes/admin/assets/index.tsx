// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import AssetList from "@/pages/admin/AssetList";

export const Route = createFileRoute("/admin/assets/")({
    component: AssetList,
});
