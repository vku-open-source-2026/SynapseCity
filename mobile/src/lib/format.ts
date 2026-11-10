// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import type { Severity } from '../api/types';

export const colors = {
  bg: '#F4FBFB',
  bgElevated: '#FFFFFF',
  card: '#FFFFFF',
  cardAlt: '#F0F9FA',
  border: '#D9E8EA',
  text: '#0F172A',
  textMuted: '#475569',
  textDim: '#64748B',
  cyan: '#0F9F9A',
  cyanSoft: '#CCFBF1',
  green: '#059669',
  amber: '#D97706',
  red: '#DC2626',
  violet: '#7C3AED',
};

export const severityMeta: Record<Severity, { label: string; color: string; bg: string }> = {
  low: { label: 'Thấp', color: '#047857', bg: '#ECFDF5' },
  medium: { label: 'Trung bình', color: '#B45309', bg: '#FFFBEB' },
  high: { label: 'Cao', color: '#C2410C', bg: '#FFF7ED' },
  critical: { label: 'Nghiêm trọng', color: '#BE123C', bg: '#FFF1F2' },
};

export function normalizeSeverity(value: unknown): Severity {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'critical'
    ? value
    : 'medium';
}

export function assetStatusMeta(status: string): { label: string; color: string; bg: string } {
  switch (status) {
    case 'active':
      return { label: 'Đang hoạt động', color: '#047857', bg: '#ECFDF5' };
    case 'maintenance':
      return { label: 'Đang bảo trì', color: '#B45309', bg: '#FFFBEB' };
    case 'inactive':
      return { label: 'Tạm ngưng', color: '#475569', bg: '#F1F5F9' };
    case 'decommissioned':
      return { label: 'Đã ngừng', color: '#BE123C', bg: '#FFF1F2' };
    default:
      return { label: 'Chưa rõ', color: '#475569', bg: '#F1F5F9' };
  }
}

export function incidentStatusLabel(status: string): string {
  const labels: Record<string, string> = {
    reported: 'Đã báo cáo',
    acknowledged: 'Đã tiếp nhận',
    assigned: 'Đã phân công',
    investigating: 'Đang xác minh',
    in_progress: 'Đang xử lý',
    waiting_approval: 'Chờ duyệt',
    resolved: 'Đã xử lý',
    closed: 'Đã đóng',
  };
  return labels[status] || status;
}

export function categoryLabel(category: string | undefined): string {
  const labels: Record<string, string> = {
    damage: 'Hư hỏng',
    malfunction: 'Sự cố kỹ thuật',
    safety_hazard: 'Nguy hiểm',
    vandalism: 'Phá hoại',
    other: 'Khác',
    utility: 'Tiện ích',
    power_station: 'Trạm điện',
    charging_station: 'Trạm sạc',
    water: 'Cấp nước',
    drainage: 'Thoát nước',
    bridge: 'Cầu',
    road: 'Đường',
    lighting: 'Chiếu sáng',
    traffic_signal: 'Đèn giao thông',
    street_light: 'Đèn đường',
    public_lighting: 'Chiếu sáng công cộng',
    water_supply: 'Cấp nước',
    wastewater: 'Nước thải',
    pump_station: 'Trạm bơm',
    treatment_plant: 'Nhà máy xử lý',
    substation: 'Trạm biến áp',
    transformer: 'Máy biến áp',
    bus_stop: 'Trạm xe buýt',
    camera: 'Camera',
    sensor: 'Cảm biến',
    park: 'Công viên',
    tree: 'Cây xanh',
    sidewalk: 'Vỉa hè',
    waste: 'Rác thải',
  };
  return category ? labels[category] || category.replaceAll('_', ' ') : 'Khác';
}

export function featureLabel(value: string | undefined): string {
  return categoryLabel(value);
}

export function timeAgo(value: string | undefined | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'vừa xong';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} ngày trước`;
  return new Date(timestamp).toLocaleDateString('vi-VN');
}

export function formatDateTime(value: string | undefined | null): string {
  if (!value) return '—';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleString('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function shortCode(code: string): string {
  return code.length > 20 ? `${code.slice(0, 18)}…` : code;
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
