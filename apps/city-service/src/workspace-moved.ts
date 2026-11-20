// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { NextFunction, Request, Response } from 'express';

/**
 * Tier-3 auth surface retirement (2026-11-14 workspace contract).
 *
 * SynapseCity is public presentation only. Login, registration, session
 * management and role assignment all live in the Tier-2 SynapseDX workspace at
 * https://synapsedx.sbs/workspace. Every `/v1/auth` and `/v1/auth/*` request
 * is answered with `410 workspace_moved` by middleware mounted on the
 * namespace, and no auth route, credential path or session-minting handler
 * exists behind it. A stray `TIER3_AUTH_MODE=legacy` variable is inert: the
 * development-only escape hatch was removed together with the retired
 * handlers, so no environment value can resurrect a Tier-3 login surface.
 */

export type WorkspaceMovedProduct = 'city' | 'sos';

/** The single authoritative Tier-2 workspace URL. */
export const WORKSPACE_URL = 'https://synapsedx.sbs/workspace';

export interface WorkspaceMovedBody {
  error: 'workspace_moved';
  product: WorkspaceMovedProduct;
  workspace_url: string;
  detail: string;
}

export function workspaceMovedBody(product: WorkspaceMovedProduct): WorkspaceMovedBody {
  return {
    error: 'workspace_moved',
    product,
    workspace_url: WORKSPACE_URL,
    detail: 'Login, registration and work interfaces moved to the SynapseDX workspace.',
  };
}

/**
 * Express middleware for the retired auth namespace. Mount it on `/v1/auth`
 * before any rate limiter. It never inspects headers, query strings or
 * bodies, so credentials and tokens cannot leak through logging or error
 * paths.
 */
export function workspaceMovedMiddleware(product: WorkspaceMovedProduct) {
  return (_req: Request, res: Response, _next: NextFunction): void => {
    res
      .status(410)
      .set('cache-control', 'no-store')
      .set('content-type', 'application/json; charset=utf-8')
      .json(workspaceMovedBody(product));
  };
}
