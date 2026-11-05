// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Tier-2 HITL approval adapter (issue #30).
 *
 * City keeps its own thresholds and domain validation, but the approval state,
 * approver roles, quorum, SLA and audit trail live in the Tier-2 capabilities
 * API. No Tier-1 call is made here.
 */
import { Request } from 'express';

export interface ApprovalRecord {
  id: string;
  tenant?: string;
  title: string;
  module: string;
  action: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
  requester: string;
  approverRoles: string[];
  requiredApprovals: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decisions: Array<{ actor: string; decision: 'approve' | 'reject'; note?: string; at: string }>;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export class HitlError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly details?: unknown) {
    super(message);
    this.name = 'HitlError';
  }
}

export function hitlRequired(): boolean {
  return process.env.CITY_HITL_REQUIRED === 'true';
}

export function approvalSlaMinutes(): number {
  const value = Number(process.env.CITY_APPROVAL_SLA_MINUTES || 30);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 7 * 24 * 60) : 30;
}

function tier2Base(): string {
  return (process.env.SYNAPSEDX_BASE_URL || 'https://synapsedx.sbs').replace(/\/$/, '');
}

function authHeaders(req: Request): Record<string, string> {
  const session = (req as Request & { session?: { tier2_token?: string } }).session;
  const authorization = req.header('authorization');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (session?.tier2_token) headers.authorization = `Bearer ${session.tier2_token}`;
  else if (authorization) headers.authorization = authorization;
  else if (process.env.SYNAPSEDX_TOKEN) headers.authorization = `Bearer ${process.env.SYNAPSEDX_TOKEN}`;
  const apiKey = req.header('x-api-key') || process.env.SYNAPSEDX_API_KEY;
  if (!headers.authorization && apiKey) headers['x-api-key'] = apiKey;
  return headers;
}

export function cityApproverRoles(action: string): string[] {
  if (action === 'budget.transaction.approve') return (process.env.CITY_BUDGET_APPROVER_ROLES || 'finance,manager').split(',').map((r) => r.trim()).filter(Boolean);
  if (action === 'maintenance.approve') return (process.env.CITY_MAINTENANCE_APPROVER_ROLES || 'maintenance-manager,manager').split(',').map((r) => r.trim()).filter(Boolean);
  return (process.env.CITY_COST_APPROVER_ROLES || 'finance,manager').split(',').map((r) => r.trim()).filter(Boolean);
}

async function call(req: Request, method: string, path: string, body?: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(`${tier2Base()}${path}`, {
      method,
      headers: authHeaders(req),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(Math.min(Math.max(Number(process.env.SYNAPSEDX_TIMEOUT_MS) || 20_000, 1000), 120_000)),
    });
  } catch (error) {
    throw new HitlError(503, 'hitl_unavailable', `Tier-2 approval capability is unavailable: ${(error as Error).message}`);
  }
  const text = await response.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const code = payload?.error?.code || payload?.error || 'hitl_rejected';
    const message = payload?.error?.message || payload?.message || `Tier-2 approval request failed (${response.status})`;
    throw new HitlError(response.status, String(code), String(message), payload?.error?.details);
  }
  return payload;
}

export async function createApproval(req: Request, input: {
  title: string;
  module: string;
  action: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
  requester: string;
}): Promise<ApprovalRecord> {
  const dueAt = new Date(Date.now() + approvalSlaMinutes() * 60_000).toISOString();
  const result = await call(req, 'POST', '/v1/capabilities/approvals', {
    title: input.title,
    module: input.module,
    action: input.action,
    ...(input.entityType ? { entityType: input.entityType } : {}),
    ...(input.entityId ? { entityId: input.entityId } : {}),
    ...(input.payload ? { payload: input.payload } : {}),
    requester: input.requester,
    approverRoles: cityApproverRoles(input.action),
    requiredApprovals: Math.max(1, Math.min(Number(process.env.CITY_REQUIRED_APPROVALS || 1), 5)),
    dueAt,
  });
  return result.approval as ApprovalRecord;
}

export async function getApproval(req: Request, id: string): Promise<ApprovalRecord> {
  const result = await call(req, 'GET', `/v1/capabilities/approvals/${encodeURIComponent(id)}`);
  return result.approval as ApprovalRecord;
}

export async function decideApproval(req: Request, id: string, decision: 'approve' | 'reject', note?: string): Promise<ApprovalRecord> {
  const result = await call(req, 'POST', `/v1/capabilities/approvals/${encodeURIComponent(id)}/decide`, {
    decision,
    ...(note ? { note } : {}),
  });
  return result.approval as ApprovalRecord;
}

export async function listPendingApprovals(req: Request, module?: string): Promise<ApprovalRecord[]> {
  const query = new URLSearchParams({ status: 'pending' });
  if (module) query.set('module', module);
  const result = await call(req, 'GET', `/v1/capabilities/approvals?${query.toString()}`);
  return Array.isArray(result?.items) ? result.items : [];
}

/** Verify an approval before applying a domain effect. */
export async function assertApproved(req: Request, approvalId: string, expected: { entityId?: string; action?: string; actor?: string }): Promise<ApprovalRecord> {
  const approval = await getApproval(req, approvalId);
  if (approval.status !== 'approved') throw new HitlError(409, 'approval_not_approved', `approval is ${approval.status}`);
  if (expected.entityId && approval.entityId !== expected.entityId) throw new HitlError(409, 'approval_entity_mismatch', 'approval belongs to another record');
  if (expected.action && approval.action !== expected.action) throw new HitlError(409, 'approval_action_mismatch', 'approval belongs to another action');
  if (expected.actor && approval.requester === expected.actor) throw new HitlError(403, 'self_approval_forbidden', 'the requester cannot approve their own request');
  return approval;
}
