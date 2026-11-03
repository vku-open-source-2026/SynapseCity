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
  if (configured) return configured;
  console.warn('[synapsecity] AUTH_SECRET is not set; using an ephemeral session secret. Existing sessions are invalid after a restart. Production identity must be delegated to Tier-1 IAM.');
  return randomBytes(32).toString('hex');
}

const AUTH_SECRET = resolveSecret();

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
  return payload;
}

export function normalizeRole(value: unknown, fallback: SessionRole = 'citizen'): SessionRole {
  const role = String(value || '').toLowerCase() as SessionRole;
  return ROLES.includes(role) ? role : fallback;
}

export function permissionsForRole(role: SessionRole): string[] {
  if (role === 'admin') return ['*'];
  if (role === 'manager') return ['assets:read', 'incidents:read', 'incidents:write', 'maintenance:read', 'maintenance:write', 'reports:read'];
  if (role === 'technician') return ['assets:read', 'incidents:read', 'maintenance:read', 'maintenance:write'];
  if (role === 'volunteer') return ['assets:read', 'incidents:read'];
  return ['public:read'];
}

export interface PrincipalInput {
  username: string;
  email?: string;
  full_name?: string;
  phone?: string;
  role?: unknown;
  sub?: string;
}

export function principalFromInput(input: PrincipalInput, defaultRole: SessionRole = 'admin'): SessionPrincipal {
  const role = normalizeRole(input.role, defaultRole);
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
  const base = {
    sub: principal.sub,
    username: principal.username,
    email: principal.email,
    full_name: principal.full_name,
    ...(principal.phone ? { phone: principal.phone } : {}),
    role: principal.role,
    permissions: principal.permissions,
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
