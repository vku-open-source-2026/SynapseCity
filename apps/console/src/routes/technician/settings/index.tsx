// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import ProfileSettings from "@/pages/settings/ProfileSettings";

export const Route = createFileRoute("/technician/settings/")({
    component: ProfileSettings,
});


