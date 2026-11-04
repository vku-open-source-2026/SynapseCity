// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/**
 * Preventive-maintenance derivation.
 *
 * Tasks are derived from the asset's `preventive_maintenance_plan` and from
 * work orders that were created as preventive work. Nothing is invented: if
 * there is no plan and no preventive work order, there are no tasks.
 */

export type PreventiveTaskStatus = 'upcoming' | 'due_soon' | 'overdue' | 'scheduled';

export interface PreventivePlan {
  id?: string;
  asset_id?: string;
  cycle_days?: number;
  warning_days?: number;
  responsible_team?: string;
  last_maintenance_date?: string;
  next_maintenance_date?: string;
  [key: string]: unknown;
}

export interface PreventiveTask {
  id: string;
  asset_id: string;
  plan_id?: string;
  work_order_id?: string;
  title: string;
  due_date: string;
  scheduled_date: string;
  status: PreventiveTaskStatus;
  days_until_due: number;
  cycle_days?: number;
  responsible_team?: string;
  source: 'plan' | 'work_order';
}

const DAY_MS = 86_400_000;
const CLOSED_STATUSES = new Set(['completed', 'cancelled', 'closed']);

function dayDifference(from: number, to: number): number {
  return Math.ceil((to - from) / DAY_MS);
}

function statusFor(daysUntilDue: number, warningDays: number): PreventiveTaskStatus {
  if (daysUntilDue < 0) return 'overdue';
  if (daysUntilDue <= warningDays) return 'due_soon';
  return 'upcoming';
}

export function derivePreventiveTasks(
  plan: PreventivePlan | null | undefined,
  workOrders: Array<Record<string, unknown>>,
  now = Date.now(),
): PreventiveTask[] {
  const tasks: PreventiveTask[] = [];
  const warningDays = Math.max(0, Number(plan?.warning_days) || 7);

  const preventiveOrders = workOrders.filter((order) => {
    const type = String(order.type || order.maintenance_type || '').toLowerCase();
    const isPreventive = type === 'preventive' || order.preventive === true || Boolean(order.plan_id);
    return isPreventive && !CLOSED_STATUSES.has(String(order.status || '').toLowerCase());
  });

  for (const order of preventiveOrders) {
    const dueRaw = order.scheduled_date || order.due_date || order.scheduledDate;
    const due = Date.parse(String(dueRaw || ''));
    if (!Number.isFinite(due)) continue;
    const daysUntilDue = dayDifference(now, due);
    tasks.push({
      id: `wo-${String(order.id)}`,
      asset_id: String(order.asset_id || order.assetId || plan?.asset_id || ''),
      ...(plan?.id ? { plan_id: String(plan.id) } : {}),
      work_order_id: String(order.id),
      title: String(order.title || 'Preventive maintenance'),
      due_date: new Date(due).toISOString(),
      scheduled_date: new Date(due).toISOString(),
      status: statusFor(daysUntilDue, warningDays),
      days_until_due: daysUntilDue,
      ...(plan?.cycle_days !== undefined ? { cycle_days: Number(plan.cycle_days) } : {}),
      ...(order.responsible_team || plan?.responsible_team ? { responsible_team: String(order.responsible_team || plan?.responsible_team) } : {}),
      source: 'work_order',
    });
  }

  const planNextDue = Date.parse(String(plan?.next_maintenance_date || ''));
  const planId = plan?.id ? String(plan.id) : '';
  const planAlreadyScheduled = planId
    ? preventiveOrders.some((order) => String(order.plan_id || '') === planId)
    : false;
  if (Number.isFinite(planNextDue) && !planAlreadyScheduled) {
    const daysUntilDue = dayDifference(now, planNextDue);
    tasks.push({
      id: `plan-${planId || plan?.asset_id || 'asset'}`,
      asset_id: String(plan?.asset_id || ''),
      ...(planId ? { plan_id: planId } : {}),
      title: String(plan?.cycle_description || `Preventive maintenance every ${Number(plan?.cycle_days) || 180} days`),
      due_date: new Date(planNextDue).toISOString(),
      scheduled_date: new Date(planNextDue).toISOString(),
      status: statusFor(daysUntilDue, warningDays),
      days_until_due: daysUntilDue,
      ...(plan?.cycle_days !== undefined ? { cycle_days: Number(plan.cycle_days) } : {}),
      ...(plan?.responsible_team ? { responsible_team: String(plan.responsible_team) } : {}),
      source: 'plan',
    });
  }

  // A work order always wins over the plan-derived placeholder for the same plan.
  const deduped = new Map<string, PreventiveTask>();
  for (const task of tasks) {
    const key = task.work_order_id ? `wo-${task.work_order_id}` : `plan-${task.plan_id || task.asset_id}`;
    if (!deduped.has(key)) deduped.set(key, task);
  }
  return [...deduped.values()].sort((a, b) => Date.parse(a.due_date) - Date.parse(b.due_date));
}

export function filterPreventiveTasks(tasks: PreventiveTask[], view: 'tasks' | 'upcoming' | 'overdue'): PreventiveTask[] {
  if (view === 'overdue') return tasks.filter((task) => task.status === 'overdue');
  if (view === 'upcoming') return tasks.filter((task) => task.status !== 'overdue');
  return tasks;
}
