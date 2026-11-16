// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import AssetForm from "@/pages/admin/AssetForm";

export const Route = createFileRoute("/admin/assets/edit/$id")({
    component: () => <AssetForm mode="edit" />,
});
