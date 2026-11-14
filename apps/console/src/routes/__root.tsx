// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createRootRoute, Outlet, redirect } from '@tanstack/react-router';
import { workspaceRedirectHref } from '../lib/workspace';

/**
 * Public-only console root.
 *
 * Tier-3 route ownership is limited to public presentation (`/`, `/about`,
 * `/docs`, `/map`, `/asset/$id`, `/public/*`). Any retired work surface is
 * redirected to the Tier-2 SynapseDX workspace before a route renders, so a
 * dashboard cannot be mounted from a deep link or a client-side navigation.
 * `nginx.conf` and the edge config perform the same redirect server-side.
 */
export const Route = createRootRoute({
  beforeLoad: ({ location }) => {
    const href = workspaceRedirectHref(location.pathname);
    if (href) {
      throw redirect({ href });
    }
  },
  component: () => (
    <>
      <Outlet />
    </>
  ),
});
