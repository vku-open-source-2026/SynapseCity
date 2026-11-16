// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { NextFunction, Request, Response } from 'express';

/**
 * Tier-3 auth surface retirement (2026-11-14 workspace contract).
 *
 * SynapseCity is public presentation only. Login, registration, session
 * management and role assignment all live in the Tier-2 SynapseDX workspace at
 * https://synapsedx.sbs/workspace. Every `/v1/auth` and `/v1/auth/*` request is
 * answered with `410 workspace_moved` by middleware registered before the auth
 * rate limiter and auth routes, so no credential is read, no Tier-2 call is
 * made and no session can be minted here.
 *
 * `TIER3_AUTH_MODE=legacy` exists only to keep this repository's non-production
 * auth test suites meaningful while the removed code waits for the Rust
 * migration. Production always answers 410, even if the variable is set.
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

export type Tier3AuthMode = 'moved' | 'legacy';

let warnedLegacy = false;
let warnedProductionLegacy = false;

/**
 * Resolve the auth surface mode. `legacy` is honoured only outside production;
 * a production deployment always returns `moved` and logs one error so a stray
 * environment variable cannot silently re-enable a Tier-3 login surface.
 */
export function tier3AuthMode(): Tier3AuthMode {
  const configured = (process.env.TIER3_AUTH_MODE || '').trim().toLowerCase();
  if (configured !== 'legacy') return 'moved';
  if (process.env.NODE_ENV === 'production') {
    if (!warnedProductionLegacy) {
      warnedProductionLegacy = true;
      console.error('[synapsecity] TIER3_AUTH_MODE=legacy is forbidden in production; /v1/auth/* returns 410 workspace_moved.');
    }
    return 'moved';
  }
  if (!warnedLegacy) {
    warnedLegacy = true;
    console.warn('[synapsecity] TIER3_AUTH_MODE=legacy is enabled for non-production tests only; the Tier-3 auth surface is retired.');
  }
  return 'legacy';
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
 * before the auth rate limiter and routes. It never inspects headers, query
 * strings or bodies, so credentials and tokens cannot leak through logging or
 * error paths.
 */
export function workspaceMovedMiddleware(product: WorkspaceMovedProduct) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (tier3AuthMode() === 'legacy') {
      next();
      return;
    }
    res
      .status(410)
      .set('cache-control', 'no-store')
      .set('content-type', 'application/json; charset=utf-8')
      .json(workspaceMovedBody(product));
  };
}
