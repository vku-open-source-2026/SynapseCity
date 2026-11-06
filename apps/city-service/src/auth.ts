// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Stateless HMAC-SHA256 session shell for the SynapseCity console.
 *
 * This is deliberately NOT an identity provider:
 * - it never stores or validates passwords or password hashes;
 * - it does not create an identity table, session table or cache;
 * - tokens are signed locally and carry the operator principal.
 *
 * Production deployments must delegate authentication to the Tier-1 IAM
 * service and keep this shell only as a transport/session adapter. The demo
 * login accepts non-empty credentials and issues a principal so the operations
 * console can be exercised without a Tier-1 account.
 */

export type SessionRole = 'admin' | 'manager' | 'technician' | 'volunteer' | 'citizen';

export interface SessionPrincipal {
  sub: string;
  username: string;
  email: string;
  full_name: string;
  phone?: string;
  role: SessionRole;
  permissions: string[];
  typ: 'access' | 'refresh';
  iat: number;
  exp: number;
  /** Unique token id so a refresh always rotates the access token. */
  jti?: string;
  /** Marks a session minted by the demo credential shell. */
  demo?: boolean;
  /** Verified identity source. `tier2` is the production path. */
  auth_source?: 'tier2' | 'demo';
  /**
   * User-scoped Tier-2 credential minted/verified by the Tier-2 auth
   * capability. It is kept inside the signed City session and never returned to
   * the browser; `capabilitiesFromRequest` forwards it upstream.
   */
  tier2_token?: string;
  /** Tier-2 refresh token, used only to rotate the delegated credential. */
  tier2_refresh_token?: string;
}

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  full_name: string;
  phone?: string;
  role: SessionRole;
  status: 'active';
  permissions: string[];
  created_at: string;
  updated_at: string;
}

export type AuthedRequest = Request & { session?: SessionPrincipal };

const ROLES: readonly SessionRole[] = ['admin', 'manager', 'technician', 'volunteer', 'citizen'];
const ACCESS_TTL_SECONDS = Math.max(60, Number(process.env.AUTH_ACCESS_TTL_SECONDS || 3600));
const REFRESH_TTL_SECONDS = Math.max(ACCESS_TTL_SECONDS, Number(process.env.AUTH_REFRESH_TTL_SECONDS || 604800));

function resolveSecret(): string {
  const configured = (process.env.AUTH_SECRET || '').trim();
  if (configured) {
    if (configured.length < 32) {
      console.warn('[synapsecity] AUTH_SECRET is shorter than 32 characters; use a strong secret in production.');
    }
    return configured;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[synapsecity] AUTH_SECRET must be set in production (an ephemeral secret would invalidate every session on restart)');
  }
  console.warn('[synapsecity] AUTH_SECRET is not set; using an ephemeral session secret. Existing sessions are invalid after a restart. Production identity must be delegated to Tier-1 IAM.');
  return randomBytes(32).toString('hex');
}

const AUTH_SECRET = resolveSecret();

/**
 * The demo credential shell is a local development aid, never an identity
 * provider. It is enabled by default outside production and must be opted into
 * explicitly in production with `AUTH_DEMO_MODE=true`.
 */
export function demoModeEnabled(): boolean {
  const configured = (process.env.AUTH_DEMO_MODE || '').trim().toLowerCase();
  if (configured === 'true') return true;
  if (configured === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * Ephemeral demo-session revocation list. This is not a user/session store: it
 * only remembers the `jti` of tokens that were logged out until they expire, so
 * `AUTH_SECRET`-signed demo sessions can be invalidated. Production revocation
 * belongs to the Tier-1 IAM provider.
 */
const revokedTokens = new Map<string, number>();

function activeRevocations(now: number): void {
  for (const [jti, exp] of revokedTokens) {
    if (exp <= now) revokedTokens.delete(jti);
  }
}

export function revokeSession(principal: Pick<SessionPrincipal, 'jti' | 'exp'>): void {
  if (!principal.jti) return;
  revokedTokens.set(principal.jti, Number(principal.exp) || Math.floor(Date.now() / 1000) + ACCESS_TTL_SECONDS);
}

export function isSessionRevoked(jti: string | undefined): boolean {
  if (!jti) return false;
  const exp = revokedTokens.get(jti);
  if (exp === undefined) return false;
  if (exp <= Math.floor(Date.now() / 1000)) {
    revokedTokens.delete(jti);
    return false;
  }
  return true;
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function signature(payload: string): string {
  return createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
}

export function signToken(claims: Omit<SessionPrincipal, 'iat' | 'exp' | 'jti'> & { exp?: number }): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: SessionPrincipal = {
    ...claims,
    jti: randomUUID(),
    iat: now,
    exp: claims.exp ?? now + (claims.typ === 'refresh' ? REFRESH_TTL_SECONDS : ACCESS_TTL_SECONDS),
  };
  const encoded = encode(JSON.stringify(payload));
  return `${encoded}.${signature(encoded)}`;
}

export function verifyToken(token: string, expected: 'access' | 'refresh' = 'access'): SessionPrincipal | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, provided] = parts;
  const expectedSignature = signature(encoded);
  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(expectedSignature);
  if (providedBuffer.length !== expectedBuffer.length) return null;
  if (!timingSafeEqual(providedBuffer, expectedBuffer)) return null;
  let payload: SessionPrincipal;
  try {
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPrincipal;
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (payload.typ !== expected) return null;
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (!payload.sub || !payload.username) return null;
  if (isSessionRevoked(payload.jti)) return null;
  return payload;
}

export function normalizeRole(value: unknown, fallback: SessionRole = 'citizen'): SessionRole {
  const role = String(value || '').toLowerCase() as SessionRole;
  return ROLES.includes(role) ? role : fallback;
}

/**
 * Permission vocabulary enforced by every City operator route. `*` is the
 * admin wildcard and is the only wildcard accepted.
 */
export type Permission =
  | 'assets:read' | 'assets:write'
  | 'incidents:read' | 'incidents:write' | 'incidents:verify'
  | 'maintenance:read' | 'maintenance:write'
  | 'iot:read' | 'iot:write'
  | 'alerts:read' | 'alerts:write'
  | 'budgets:read' | 'budgets:write' | 'budgets:approve'
  | 'reports:read' | 'reports:write' | 'reports:generate'
  | 'notifications:read' | 'notifications:write'
  | 'files:read' | 'files:write'
  | 'users:read' | 'users:admin'
  | 'geofences:read' | 'geofences:write'
  | 'ingest:write' | 'geo:read' | 'ai:use' | 'public:read';

const ROLE_PERMISSIONS: Record<SessionRole, readonly string[]> = {
  admin: ['*'],
  manager: [
    'assets:read', 'assets:write',
    'incidents:read', 'incidents:write', 'incidents:verify',
    'maintenance:read', 'maintenance:write',
    'iot:read', 'iot:write',
    'alerts:read', 'alerts:write',
    'budgets:read', 'budgets:write', 'budgets:approve',
    'reports:read', 'reports:write', 'reports:generate',
    'notifications:read', 'notifications:write',
    'files:read', 'files:write',
    'users:read',
    'geofences:read', 'geofences:write',
    'ingest:write', 'geo:read', 'ai:use',
  ],
  technician: [
    'assets:read',
    'incidents:read',
    'maintenance:read', 'maintenance:write',
    'iot:read',
    'alerts:read',
    'notifications:read',
    'files:read', 'files:write',
    'geo:read',
  ],
  volunteer: [
    'assets:read',
    'incidents:read',
    'geofences:read',
    'notifications:read',
    'files:read',
    'geo:read',
    'public:read',
  ],
  citizen: ['public:read'],
};

export function permissionsForRole(role: SessionRole): string[] {
  return [...(ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.citizen)];
}

export function hasPermission(principal: Pick<SessionPrincipal, 'role' | 'permissions'> | undefined, permission: Permission | 'authenticated'): boolean {
  if (!principal) return false;
  if (permission === 'authenticated') return true;
  // Permissions are always derived from the signed role. The permission array
  // carried by an old token is ignored so a stale or hand-crafted list can never
  // widen access.
  const granted = permissionsForRole(principal.role);
  return granted.includes('*') || granted.includes(permission);
}

export interface PrincipalInput {
  username: string;
  email?: string;
  full_name?: string;
  phone?: string;
  role?: unknown;
  sub?: string;
}

export function principalFromInput(input: PrincipalInput, defaultRole: SessionRole = 'citizen'): SessionPrincipal {
  // A role supplied by the caller is never trusted: `input.role` is ignored and
  // only the server-side default (resolved by the caller from configuration or
  // a verified identity provider) is used.
  const role = normalizeRole(defaultRole, 'citizen');
  const now = Math.floor(Date.now() / 1000);
  const username = input.username.trim();
  return {
    sub: input.sub || `user-${username.toLowerCase().replace(/[^a-z0-9._-]/g, '-')}`,
    username,
    email: (input.email || '').trim() || `${username}@synapsecity.local`,
    full_name: (input.full_name || '').trim() || username,
    ...(input.phone ? { phone: String(input.phone) } : {}),
    role,
    permissions: permissionsForRole(role),
    typ: 'access',
    iat: now,
    exp: now + ACCESS_TTL_SECONDS,
  };
}

export interface SessionResponse {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  user: SessionUser;
}

export function issueSession(principal: Omit<SessionPrincipal, 'typ' | 'iat' | 'exp'>): SessionResponse {
  const role = normalizeRole(principal.role, 'citizen');
  const base = {
    sub: principal.sub,
    username: principal.username,
    email: principal.email,
    full_name: principal.full_name,
    ...(principal.phone ? { phone: principal.phone } : {}),
    role,
    // Permissions are always derived from the signed role, never copied from a
    // caller-supplied list.
    permissions: permissionsForRole(role),
    ...(principal.demo ? { demo: true } : {}),
    ...(principal.auth_source ? { auth_source: principal.auth_source } : {}),
    ...(principal.tier2_token ? { tier2_token: principal.tier2_token } : {}),
    ...(principal.tier2_refresh_token ? { tier2_refresh_token: principal.tier2_refresh_token } : {}),
  };
  const access_token = signToken({ ...base, typ: 'access' });
  const refresh_token = signToken({ ...base, typ: 'refresh' });
  return {
    access_token,
    refresh_token,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_SECONDS,
    user: sessionUser(base),
  };
}

export function sessionUser(principal: Pick<SessionPrincipal, 'sub' | 'username' | 'email' | 'full_name' | 'role' | 'permissions' | 'phone'>): SessionUser {
  const now = new Date().toISOString();
  return {
    id: principal.sub,
    username: principal.username,
    email: principal.email,
    full_name: principal.full_name,
    ...(principal.phone ? { phone: principal.phone } : {}),
    role: principal.role,
    status: 'active',
    permissions: principal.permissions,
    created_at: now,
    updated_at: now,
  };
}

export function bearerToken(req: Request): string | null {
  const header = req.header('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export function sessionFromRequest(req: Request): SessionPrincipal | null {
  const token = bearerToken(req);
  return token ? verifyToken(token, 'access') : null;
}

export function requireSession(req: Request, res: Response, next: NextFunction): void {
  const principal = sessionFromRequest(req);
  if (!principal) {
    res.status(401).json({ error: 'unauthorized', detail: 'authentication_required' });
    return;
  }
  (req as AuthedRequest).session = principal;
  next();
}

/**
 * Declarative permission gate. `authenticated` only checks that a valid session
 * exists (used by self-service routes such as `/v1/users/me`).
 */
export function requirePermission(permission: Permission | 'authenticated') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const principal = (req as AuthedRequest).session || sessionFromRequest(req);
    if (!principal) {
      res.status(401).json({ error: 'unauthorized', detail: 'authentication_required' });
      return;
    }
    (req as AuthedRequest).session = principal;
    if (!hasPermission(principal, permission)) {
      res.status(403).json({ error: 'forbidden', detail: `${permission}_required`, role: principal.role });
      return;
    }
    next();
  };
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const principal = (req as AuthedRequest).session;
  if (!principal) {
    res.status(401).json({ error: 'unauthorized', detail: 'authentication_required' });
    return;
  }
  if (principal.role !== 'admin') {
    res.status(403).json({ error: 'forbidden', detail: 'admin_role_required' });
    return;
  }
  next();
}

const SENSITIVE_USER_FIELDS = new Set(['password', 'password_hash', 'passwordHash', 'passwordhash', 'passwordSalt', 'password_salt']);

/** Remove credential fields from a user/operator record before returning it. */
export function sanitizeUser<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (!SENSITIVE_USER_FIELDS.has(key)) clean[key] = entry;
  }
  return clean as T;
}

export function containsPassword(body: Record<string, unknown>): boolean {
  return Object.keys(body).some((key) => SENSITIVE_USER_FIELDS.has(key));
}

export function newSessionId(): string {
  return randomUUID();
}
