// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC

export type AssetStatus = 'active' | 'inactive' | 'maintenance' | 'decommissioned';

export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type IncidentStatus =
  | 'reported'
  | 'acknowledged'
  | 'assigned'
  | 'investigating'
  | 'in_progress'
  | 'waiting_approval'
  | 'resolved'
  | 'closed';

export interface Coordinates {
  longitude: number;
  latitude: number;
}

export interface Geometry {
  type: string;
  coordinates: unknown;
}

export interface PublicAsset {
  id?: string;
  asset_code: string;
  name: string;
  feature_type: string;
  feature_code?: string;
  category?: string;
  status: AssetStatus | string;
  location: {
    address?: string;
    ward?: string;
    district?: string;
    coordinates?: Coordinates;
    geometry?: Geometry;
  };
  geometry?: Geometry;
  qr_code?: string;
  public_url?: string;
  nfc_tag_id?: string | null;
}

export interface MaintenanceSummary {
  asset_code: string;
  work_order_count: number;
  completed_count: number;
  last_completed_at: string | null;
  last_maintenance_type: string | null;
}

export interface IncidentComment {
  id: string;
  comment: string;
  is_internal?: boolean;
  posted_at?: string;
  created_at?: string;
}

export interface PublicIncident {
  id: string;
  incidentId?: string;
  incident_number?: string;
  incident_code?: string;
  title: string;
  description: string;
  category?: string;
  severity: Severity;
  status: IncidentStatus | string;
  asset_id?: string;
  location?: {
    address?: string;
    ward?: string;
    district?: string;
    coordinates?: Coordinates;
    geometry?: Geometry;
    description?: string;
  };
  occurredAt?: string;
  reported_at?: string;
  created_at: string;
  updated_at?: string;
  upvotes: number;
  public_visible?: boolean;
  reporter_type?: string;
  resolution_type?: string;
  resolved_at?: string;
  closed_at?: string;
  acknowledged_at?: string;
  comments?: IncidentComment[];
  photos?: string[];
}

export interface CreateIncidentInput {
  title: string;
  description: string;
  category: string;
  severity: Severity;
  asset_id?: string;
  location?: {
    address?: string;
    coordinates: Coordinates;
    geometry: Geometry;
  };
}

export interface ProductInfo {
  service: string;
  product: string;
  tier: number;
  version: string;
  domain: string;
  publicUrl: string;
  features: string[];
  notOwned: string[];
  datasets: string[];
  dependency?: string;
  capabilities?: Record<string, unknown>;
}

export interface MapConfig {
  provider: string;
  tileUrl: string;
  attribution: string;
  maxZoom: number;
  maxNativeZoom: number;
  style?: string;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string;
  full_name: string;
  role: string;
  status?: string;
  permissions?: string[];
  department?: string;
}

export interface AuthResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  user: AuthUser;
}

export interface CityAlert {
  id: string;
  alert_type: string;
  severity: Severity;
  status: string;
  asset_id?: string;
  message: string;
  created_at: string;
  acknowledged_at?: string;
  resolved_at?: string;
}

export interface CityNotification {
  id: string;
  title: string;
  message: string;
  type: string;
  read: boolean;
  created_at: string;
}
