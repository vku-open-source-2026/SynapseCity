// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-3 workspace redirect policy.
 *
 * As of the 2026-11-14 workspace contract the SynapseCity console is public
 * presentation only. Every work surface (login, registration, operations
 * dashboards, technician portal and `/workspace` itself) lives in the Tier-2
 * SynapseDX workspace at https://synapsedx.sbs/workspace. This module is the
 * single client-side source of truth for that redirect:
 *
 * - moved paths redirect to one fixed DX workspace URL;
 * - nothing from the retired location is copied into the redirect, so no
 *   token, session, user value or public path can ride along;
 * - public paths are never redirected.
 */

/** Tier-2 workspace that owns all authenticated work interfaces. */
export const WORKSPACE_ORIGIN = "https://synapsedx.sbs";
export const WORKSPACE_PATH = "/workspace";
export const WORKSPACE_URL = `${WORKSPACE_ORIGIN}${WORKSPACE_PATH}`;

/**
 * Path prefixes whose UI moved to the DX workspace. A prefix matches only the
 * exact path or a child path (`/admin`, `/admin/…`), never `/administrator`.
 */
export const MOVED_PATH_PREFIXES = [
    "/login",
    "/register",
    "/admin",
    "/technician",
    "/workspace",
] as const;

/** Public, unauthenticated paths that stay in this console. */
export const PUBLIC_PATH_PREFIXES = [
    "/about",
    "/docs",
    "/map",
    "/asset",
    "/public",
] as const;

function normalizedPath(pathname: string): string {
    const raw = typeof pathname === "string" ? pathname.trim() : "";
    const withoutQuery = raw.split(/[?#]/, 1)[0] || "/";
    return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
}

function matchesPrefix(path: string, prefix: string): boolean {
    return path === prefix || path.startsWith(`${prefix}/`);
}

/** True when `pathname` is a Tier-3 surface that moved to the DX workspace. */
export function isMovedWorkspacePath(pathname: string): boolean {
    const path = normalizedPath(pathname);
    return MOVED_PATH_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

/** True when `pathname` is a public SynapseCity page (map, report, lookup, docs). */
export function isPublicProductPath(pathname: string): boolean {
    const path = normalizedPath(pathname);
    return path === "/" || PUBLIC_PATH_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

/**
 * Resolve the DX workspace redirect for a pathname.
 *
 * Returns `null` when the location is public and must render normally,
 * otherwise the fixed workspace URL. The redirect never carries a query
 * string, fragment or return target.
 */
export function workspaceRedirectHref(pathname: string): string | null {
    return isMovedWorkspacePath(pathname) ? WORKSPACE_URL : null;
}
