// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { createHash } from 'node:crypto';

/**
 * City-owned operational report generation.
 *
 * Reports are rendered from City records (assets, incidents, maintenance) into
 * CSV or JSON bytes. The artifact is stored on the report record through the
 * Tier-2 records API, so a download always returns the exact bytes that were
 * generated and the City service needs no local filesystem or object store.
 *
 * `pdf` and `excel` are deliberately rejected: rendering them requires the
 * Tier-2 files capability / a spreadsheet writer (SynapseDX #9). Returning a
 * clear error is better than a fake `file_url`.
 */

export type ReportFormat = 'csv' | 'json';

export interface ReportRowSet {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export interface ReportContext {
  asset?: Record<string, unknown> | null;
  assets: Array<Record<string, unknown>>;
  incidents: Array<Record<string, unknown>>;
  maintenance: Array<Record<string, unknown>>;
}

export interface ReportArtifact {
  content: string;
  contentType: string;
  extension: ReportFormat;
  rowCount: number;
  sha256: string;
  reportType: string;
}

export const SUPPORTED_REPORT_TYPES = [
  'maintenance_summary',
  'incident_summary',
  'lifecycle_overview',
  'end_of_life_forecast',
  'custom',
] as const;

export type ReportType = (typeof SUPPORTED_REPORT_TYPES)[number];

export class UnsupportedReportFormatError extends Error {
  status = 415;
  constructor(format: string) {
    super(`unsupported_report_format:${format}`);
    this.name = 'UnsupportedReportFormatError';
  }
}

export class UnsupportedReportTypeError extends Error {
  status = 400;
  constructor(type: string) {
    super(`unsupported_report_type:${type}`);
    this.name = 'UnsupportedReportTypeError';
  }
}

export function normalizeReportFormat(value: unknown): ReportFormat {
  const format = String(value || 'csv').trim().toLowerCase();
  if (format === 'csv' || format === 'json') return format;
  // Legacy aliases that must not be silently presented as a real file.
  throw new UnsupportedReportFormatError(format);
}

export function normalizeReportType(value: unknown): ReportType {
  const type = String(value || 'maintenance_summary').trim().toLowerCase();
  if ((SUPPORTED_REPORT_TYPES as readonly string[]).includes(type)) return type as ReportType;
  throw new UnsupportedReportTypeError(type);
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  return String(value);
}

function numeric(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function withinFilters(row: Record<string, unknown>, filters: Record<string, unknown>): boolean {
  const dateFrom = filters.date_from ? Date.parse(String(filters.date_from)) : null;
  const dateTo = filters.date_to ? Date.parse(String(filters.date_to)) : null;
  const severity = filters.severity ? String(filters.severity).toLowerCase() : null;
  const timestamp = Date.parse(String(row.occurred_at || row.reported_at || row.scheduled_date || row.created_at || ''));
  if (dateFrom !== null && Number.isFinite(timestamp) && timestamp < dateFrom) return false;
  if (dateTo !== null && Number.isFinite(timestamp) && timestamp > dateTo) return false;
  if (severity && String(row.severity || '').toLowerCase() !== severity) return false;
  return true;
}

function maintenanceRows(context: ReportContext, filters: Record<string, unknown>): ReportRowSet {
  const rows = context.maintenance.filter((row) => withinFilters(row, filters)).map((row) => ({
    work_order_id: text(row.id),
    asset_id: text(row.asset_id || row.assetId),
    title: text(row.title),
    type: text(row.type),
    status: text(row.status),
    priority: text(row.priority),
    assigned_to: text(row.assigned_to || row.technician),
    scheduled_date: text(row.scheduled_date),
    completed_at: text(row.completed_at),
    source_alert_id: text(row.source_alert_id),
    estimated_cost: numeric(row.estimated_cost) ?? '',
    actual_cost: numeric(row.actual_cost) ?? '',
  }));
  return {
    columns: ['work_order_id', 'asset_id', 'title', 'type', 'status', 'priority', 'assigned_to', 'scheduled_date', 'completed_at', 'source_alert_id', 'estimated_cost', 'actual_cost'],
    rows,
  };
}

function incidentRows(context: ReportContext, filters: Record<string, unknown>): ReportRowSet {
  const rows = context.incidents.filter((row) => withinFilters(row, filters)).map((row) => ({
    incident_id: text(row.id),
    incident_number: text(row.incident_number || row.incident_code),
    title: text(row.title),
    category: text(row.category),
    severity: text(row.severity),
    status: text(row.status),
    asset_id: text(row.asset_id || row.assetId),
    reported_at: text(row.reported_at),
    resolved_at: text(row.resolved_at),
    resolution_type: text(row.resolution_type),
  }));
  return {
    columns: ['incident_id', 'incident_number', 'title', 'category', 'severity', 'status', 'asset_id', 'reported_at', 'resolved_at', 'resolution_type'],
    rows,
  };
}

function lifecycleRows(context: ReportContext): ReportRowSet {
  const rows = context.assets.map((asset) => {
    const lifecycle = (asset.lifecycle && typeof asset.lifecycle === 'object' ? asset.lifecycle : {}) as Record<string, unknown>;
    return {
      asset_code: text(asset.asset_code || asset.feature_code || asset.id),
      name: text(asset.name),
      feature_type: text(asset.feature_type),
      status: text(asset.status),
      lifecycle_status: text(lifecycle.lifecycle_status || asset.lifecycle_stage),
      condition: text(asset.condition),
      commissioned_date: text(lifecycle.commissioned_date),
      last_maintenance_date: text(lifecycle.last_maintenance_date),
      designed_lifespan_years: numeric(lifecycle.designed_lifespan_years) ?? '',
    };
  });
  return {
    columns: ['asset_code', 'name', 'feature_type', 'status', 'lifecycle_status', 'condition', 'commissioned_date', 'last_maintenance_date', 'designed_lifespan_years'],
    rows,
  };
}

function endOfLifeRows(context: ReportContext, now = Date.now()): ReportRowSet {
  const rows = context.assets.map((asset) => {
    const lifecycle = (asset.lifecycle && typeof asset.lifecycle === 'object' ? asset.lifecycle : {}) as Record<string, unknown>;
    const commissioned = Date.parse(String(lifecycle.commissioned_date || ''));
    const designed = numeric(lifecycle.designed_lifespan_years);
    const ageYears = Number.isFinite(commissioned) && commissioned > 0 ? Math.round(((now - commissioned) / (365.25 * 86_400_000)) * 10) / 10 : null;
    const remainingYears = ageYears !== null && designed !== null ? Math.max(0, Math.round((designed - ageYears) * 10) / 10) : null;
    const replacementYear = ageYears !== null && remainingYears !== null ? new Date(now).getUTCFullYear() + Math.ceil(remainingYears) : null;
    return {
      asset_code: text(asset.asset_code || asset.feature_code || asset.id),
      name: text(asset.name),
      commissioned_date: text(lifecycle.commissioned_date),
      designed_lifespan_years: designed ?? '',
      age_years: ageYears ?? '',
      remaining_years: remainingYears ?? '',
      projected_replacement_year: replacementYear ?? '',
      status: text(asset.status),
    };
  });
  return {
    columns: ['asset_code', 'name', 'commissioned_date', 'designed_lifespan_years', 'age_years', 'remaining_years', 'projected_replacement_year', 'status'],
    rows,
  };
}

export function buildReportRowSet(reportType: ReportType, context: ReportContext, filters: Record<string, unknown> = {}): ReportRowSet {
  const scoped = filters.asset_id
    ? {
        ...context,
        maintenance: context.maintenance.filter((row) => String(row.asset_id || row.assetId || '') === String(filters.asset_id)),
        incidents: context.incidents.filter((row) => String(row.asset_id || row.assetId || '') === String(filters.asset_id)),
      }
    : context;
  switch (reportType) {
    case 'maintenance_summary': return maintenanceRows(scoped, filters);
    case 'incident_summary': return incidentRows(scoped, filters);
    case 'lifecycle_overview': return lifecycleRows(scoped);
    case 'end_of_life_forecast': return endOfLifeRows(scoped);
    case 'custom':
    default: return incidentRows(scoped, filters);
  }
}

/** CSV cells are escaped and formula injection is neutralized. */
export function csvCell(value: unknown): string {
  const raw = text(value);
  const neutralized = /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  if (/[",\n\r]/.test(neutralized)) return `"${neutralized.replace(/"/g, '""')}"`;
  return neutralized;
}

export function serializeCsv(rowSet: ReportRowSet): string {
  const header = rowSet.columns.map(csvCell).join(',');
  const lines = rowSet.rows.map((row) => rowSet.columns.map((column) => csvCell(row[column])).join(','));
  return `${[header, ...lines].join('\n')}\n`;
}

export function generateReport(
  reportType: ReportType,
  format: ReportFormat,
  context: ReportContext,
  filters: Record<string, unknown> = {},
): ReportArtifact {
  const rowSet = buildReportRowSet(reportType, context, filters);
  const content = format === 'csv'
    ? serializeCsv(rowSet)
    : `${JSON.stringify({ report_type: reportType, generated_at: new Date().toISOString(), row_count: rowSet.rows.length, rows: rowSet.rows }, null, 2)}\n`;
  return {
    content,
    contentType: format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
    extension: format,
    rowCount: rowSet.rows.length,
    sha256: createHash('sha256').update(content).digest('hex'),
    reportType,
  };
}
