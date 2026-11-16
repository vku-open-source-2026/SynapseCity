// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createFileRoute } from "@tanstack/react-router";
import { WorkspaceMovedNotice } from "@/components/WorkspaceMovedNotice";

/**
 * Tier 3 is public presentation only (2026-11-14 workspace contract).
 * Login, registration, operations dashboards and the technician portal live in
 * the Tier-2 SynapseDX workspace: https://synapsedx.sbs/workspace.
 *
 * The root route redirects this path before it renders and nginx redirects it
 * server-side; this notice is the no-JavaScript fallback.
 */
export const Route = createFileRoute("/technician/maintenance/$id")({
  component: WorkspaceMovedNotice,
});
