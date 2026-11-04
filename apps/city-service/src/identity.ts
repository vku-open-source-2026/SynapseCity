// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { CapabilitiesClient } from '@synapsedx/capabilities';
import { CapabilitiesError } from '@synapsedx/capabilities';
import { demoModeEnabled, normalizeRole, permissionsForRole, type SessionRole } from './auth';

/**
 * Identity boundary: Tier-2 auth capability -> City session shell.
 *
 * The City service never stores credentials, password hashes or an identity
 * table. In `tier2` mode (the default) credentials are verified by the Tier-2
 * `auth.login`/`auth.register` capability, which proxies the Tier-1 IAM
 * service. City then issues its own short-lived signed session so the browser
 * never receives a Tier-1 token.
 *
 * Roles are never taken from the request body or from an unverified token. A
 * verified identity is mapped to a City role using City-owned operator
 * profiles (`city-users`) and the server-side bootstrap allow-list. An unknown
 * identity gets `citizen`.
 *
 * `demo` mode is an explicit development-only shell. It is forbidden unless
 * `CITY_AUTH_MODE=demo` **and** `AUTH_DEMO_MODE=true` outside production (or
 * the same flag inside production for a deliberately demo deployment).
 */

export const IDENTITY_DEPENDENCY = 'https://github.com/vku-open-source-2026/SynapseDX/issues/8';

export type AuthMode = 'tier2' | 'demo';

export function configuredAuthMode(): AuthMode {
  const raw = (process.env.CITY_AUTH_MODE || process.env.AUTH_MODE || 'tier2').trim().toLowerCase();
  return raw === 'demo' ? 'demo' : 'tier2';
}

/** Tier-2 is the default; demo must never be reachable without an explicit opt-in. */
export function authMode(): AuthMode {
  const configured = configuredAuthMode();
  if (configured === 'demo' && !demoModeEnabled()) return 'tier2';
  return configured;
}

export function demoAuthAllowed(): boolean {
  return configuredAuthMode() === 'demo' && demoModeEnabled();
}

/** True when the Tier-2 auth capability is the configured identity source. */
export function tier2AuthEnabled(): boolean {
  return authMode() === 'tier2';
}

export function identityCapabilityStatus(): Record<string, unknown> {
  if (tier2AuthEnabled()) {
    return {
      status: 'available',
      mode: 'tier2',
      transport: 'synapsedx',
      detail: 'Credentials are verified by the Tier-2 auth capability (Tier-1 IAM). Roles come from City operator profiles, never from the client.',
      exchange: exchangeEnabled() ? 'enabled' : 'optional',
    };
  }
  return {
    status: 'demo',
    mode: 'demo',
    detail: 'Development-only demo session shell. Never enable this on an Internet-facing deployment.',
    dependency: IDENTITY_DEPENDENCY,
  };
}

/** Optional delegated-token exchange (service credential -> user-scoped token). */
export function exchangeEnabled(): boolean {
  const raw = (process.env.CITY_AUTH_EXCHANGE || '').trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

export function exchangeScopes(): string[] {
  const raw = (process.env.CITY_AUTH_EXCHANGE_SCOPES || 'read,write').trim();
  return raw.split(',').map((entry) => entry.trim()).filter(Boolean);
}

const BOOTSTRAP_ADMIN_ENV = 'CITY_BOOTSTRAP_ADMIN_EMAILS';

export function bootstrapAdmins(): Set<string> {
  return new Set(
    (process.env[BOOTSTRAP_ADMIN_ENV] || '')
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

export interface VerifiedIdentity {
  userId: string;
  email: string;
  displayName: string;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  /**
   * Scopes carried by the *Tier-2/Tier-1* credential. They are informational:
   * City authorization is derived from its own operator profile, not scopes.
   */
  scopes: string[];
  raw: Record<string, unknown>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function scopesOf(raw: Record<string, unknown>): string[] {
  const scopes = raw.scopes;
  if (Array.isArray(scopes)) return scopes.map(String).filter(Boolean);
  return [];
}

/** Normalize the Tier-2 `auth.login`/`register`/`oidc` session response. */
export function identityFromSession(session: Record<string, unknown>): VerifiedIdentity {
  const accessToken = stringValue(session.accessToken || session.access_token);
  const refreshToken = stringValue(session.refreshToken || session.refresh_token);
  const user = (session.user && typeof session.user === 'object' ? session.user : {}) as Record<string, unknown>;
  const email = stringValue(user.email) || stringValue(session.email);
  const userId = stringValue(user.id) || stringValue(user.sub) || stringValue(session.userId) || stringValue(session.sub);
  if (!userId && !email) throw Object.assign(new Error('identity_missing_subject'), { status: 502 });
  const raw: Record<string, unknown> = { ...session, user };
  return {
    userId: userId || `user-${email.toLowerCase()}`,
    email,
    displayName: stringValue(user.display_name || user.displayName || user.full_name) || email || userId,
    ...(accessToken ? { accessToken } : {}),
    ...(refreshToken ? { refreshToken } : {}),
    ...(Number.isFinite(Number(session.expiresIn ?? session.expires_in))
      ? { expiresIn: Number(session.expiresIn ?? session.expires_in) }
      : {}),
    scopes: scopesOf(session).concat(scopesOf(user)),
    raw,
  };
}

/**
 * Map a verified identity to a City role.
 *
 * Order:
 *  1. server-side bootstrap admin allow-list (email);
 *  2. City operator profile (`city-users`) looked up by subject or email;
 *  3. `CITY_AUTH_DEFAULT_ROLE` (defaults to `citizen`).
 *
 * The client never supplies any of these values.
 */
export interface OperatorProfile {
  id?: string;
  email?: string;
  role?: unknown;
  status?: unknown;
}

export function roleForIdentity(
  identity: Pick<VerifiedIdentity, 'userId' | 'email'>,
  profile?: OperatorProfile | null,
): SessionRole {
  const email = identity.email.toLowerCase();
  const userId = identity.userId.toLowerCase();
  if (email && bootstrapAdmins().has(email)) return 'admin';
  if (profile && String(profile.status || 'active').toLowerCase() !== 'inactive') {
    const raw = String(profile.role || '').trim();
    // An unknown role on the profile resolves to citizen, never to the
    // configured fallback (which could be an operator role).
    if (raw) return normalizeRole(raw, 'citizen');
  }
  const fallback = normalizeRole(process.env.CITY_AUTH_DEFAULT_ROLE || 'citizen', 'citizen');
  void userId;
  return fallback;
}

export function permissionsForIdentity(role: SessionRole): string[] {
  return permissionsForRole(role);
}

/**
 * Map a Tier-2 error to a City auth response without leaking upstream bodies.
 */
export function authErrorStatus(error: unknown): { status: number; code: string; detail: string } {
  if (error instanceof CapabilitiesError) {
    if (error.status === 401) return { status: 401, code: 'invalid_credentials', detail: 'Email or password is incorrect.' };
    if (error.status === 400 || error.status === 422) return { status: 400, code: 'invalid_request', detail: 'The identity provider rejected the request.' };
    if (error.status === 403) return { status: 403, code: 'auth_rejected', detail: 'The identity provider rejected this identity operation.' };
    if (error.status === 429) return { status: 429, code: 'rate_limited', detail: 'Too many authentication attempts.' };
    if (error.status === 409) return { status: 409, code: 'identity_conflict', detail: 'The identity already exists.' };
    if (error.status === 503 || error.status === 502) {
      return { status: 503, code: 'identity_not_configured', detail: 'The Tier-2 identity capability is unavailable.' };
    }
    if (error.status === 404) {
      return { status: 503, code: 'identity_not_configured', detail: 'The Tier-2 identity capability is not published on this deployment.' };
    }
  }
  return { status: 503, code: 'identity_not_configured', detail: 'Identity verification is unavailable.' };
}

export interface Tier2Session {
  identity: VerifiedIdentity;
  /** Token City forwards to Tier-2 on behalf of the operator. */
  token?: string;
  refreshToken?: string;
  exchanged: boolean;
}

/**
 * Verify credentials through Tier-2 and (optionally) exchange the user session
 * for a product-audience delegated token. The exchange is skipped gracefully
 * when the deployment's service credential may not mint tokens; `login` already
 * returned a user-scoped token, which is sufficient for Tier-2 calls.
 */
export async function tier2Login(
  client: CapabilitiesClient,
  input: { email: string; password: string; orgSlug?: string },
): Promise<Tier2Session> {
  const session = await client.auth.login({
    email: input.email,
    password: input.password,
    ...(input.orgSlug ? { orgSlug: input.orgSlug } : {}),
  }) as unknown as Record<string, unknown>;
  const identity = identityFromSession(session);
  let token = identity.accessToken;
  let exchanged = false;
  if (exchangeEnabled() && identity.userId) {
    try {
      const delegated = await client.auth.exchange({
        userId: identity.userId,
        audience: 'synapsecity',
        scopes: exchangeScopes(),
        ttlSeconds: identity.expiresIn && identity.expiresIn >= 60 ? Math.min(identity.expiresIn, 3600) : undefined,
      });
      if (delegated?.accessToken) {
        token = delegated.accessToken;
        exchanged = true;
      }
    } catch (error) {
      const status = error instanceof CapabilitiesError ? error.status : 0;
      if (status !== 403) throw error;
      // exchange_forbidden/insufficient_scope: the user-scoped login token is
      // already correct; do not fail the login or widen the token.
      console.warn('[synapsecity] auth_exchange_skipped', (error as Error).message);
    }
  }
  return {
    identity,
    ...(token ? { token } : {}),
    ...(identity.refreshToken ? { refreshToken: identity.refreshToken } : {}),
    exchanged,
  };
}

export async function tier2Register(
  client: CapabilitiesClient,
  input: { email: string; password: string; displayName?: string; orgSlug?: string },
): Promise<Tier2Session> {
  const session = await client.auth.register({
    email: input.email,
    password: input.password,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.orgSlug ? { orgSlug: input.orgSlug } : {}),
  }) as unknown as Record<string, unknown>;
  const identity = identityFromSession(session);
  return {
    identity,
    ...(identity.accessToken ? { token: identity.accessToken } : {}),
    ...(identity.refreshToken ? { refreshToken: identity.refreshToken } : {}),
    exchanged: false,
  };
}

export function identityDependency(): string {
  return IDENTITY_DEPENDENCY;
}
