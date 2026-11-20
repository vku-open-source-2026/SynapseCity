// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { normalizeRole, type SessionRole } from './auth';
import { WORKSPACE_URL } from './workspace-moved';

/**
 * Identity boundary notes.
 *
 * The Tier-3 password/session surface is retired: every `/v1/auth/*` request
 * answers `410 workspace_moved` and login, registration and session management
 * belong to the Tier-2 SynapseDX workspace. This service never stores
 * credentials, password hashes or an identity table, and it no longer proxies
 * the Tier-2 auth capability.
 *
 * The helpers below remain for the operator-profile mapping contract
 * (`roleForIdentity` maps a verified identity to a City role using
 * City-owned operator profiles and the server-side bootstrap allow-list) and
 * are covered by geo-provider.test.ts.
 */

export function identityCapabilityStatus(): Record<string, unknown> {
  return {
    status: 'moved',
    workspace: WORKSPACE_URL,
    detail: 'Tier-3 login, registration and sessions are retired; they belong to the SynapseDX workspace.',
  };
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

