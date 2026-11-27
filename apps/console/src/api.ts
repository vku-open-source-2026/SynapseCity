// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { asList, httpClient } from "./lib/httpClient";
import { FileUploadError, uploadPublicFile } from "./lib/files";
import { publicApi } from "./api/public";
import axios from "axios";

// Force HTTPS in production
const getApiBaseUrl = () => {
    const url = import.meta.env.VITE_BASE_API_URL || "/v1";
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('http://')) {
        return url.replace('http://', 'https://');
    }
    return url;
};

export const api = axios.create({
    baseURL: getApiBaseUrl(),
});

export interface Asset {
    id: string;
    _id?: string; // Legacy support
    feature_type: string;
    feature_code: string;
    geometry: {
        type:
        | "Point"
        | "LineString"
        | "Polygon"
        | "MultiPoint"
        | "MultiLineString"
        | "MultiPolygon";
        coordinates: number[] | number[][] | number[][][]; // GeoJSON coordinates
    };
    created_at: string;
}

// Helper to get asset ID (supports both id and _id)
export const getAssetId = (asset: Asset): string => asset.id || asset._id || '';

export interface MaintenanceLog {
    _id: string;
    asset_id: string;
    description: string;
    technician: string;
    status: string;
    scheduled_date: string;
    completed_date?: string;
    created_at: string;
}

export const getAssets = async () => {
    // The maps need the complete inventory. The City API pages at 500 records
    // and exposes the total through x-total-count (forwarded by the gateway).
    const pageSize = 500;
    const all: Asset[] = [];
    let offset = 0;
    for (;;) {
        const response = await httpClient.get<Asset[]>("/assets", {
            params: { limit: pageSize, offset },
        });
        const items = asList<Asset>(response.data);
        all.push(...items);
        const total = Number(response.headers["x-total-count"]);
        if (!Number.isFinite(total) || items.length < pageSize || all.length >= total) break;
        offset += items.length;
    }
    return all;
};

export const loginAdmin = async (username: string, password: string) => {
    const response = await httpClient.post<{ access_token: string }>(
        "/auth/login",
        {
            username,
            password,
        }
    );
    return { token: response.data.access_token };
};

export const getMaintenanceLogs = async (assetId: string) => {
    const response = await httpClient.get<MaintenanceLog[]>(
        `/maintenance/asset/${assetId}`
    );
    return asList<MaintenanceLog>(response.data);
};

export const createMaintenanceLog = async (data: Record<string, unknown>) => {
    const response = await httpClient.post("/maintenance", data);
    return response.data;
};

export const IncidentCategory = {
    DAMAGE: "damage",
    MALFUNCTION: "malfunction",
    SAFETY_HAZARD: "safety_hazard",
    VANDALISM: "vandalism",
    OTHER: "other",
} as const;
export type IncidentCategory = typeof IncidentCategory[keyof typeof IncidentCategory];

export const IncidentSeverity = {
    LOW: "low",
    MEDIUM: "medium",
    HIGH: "high",
    CRITICAL: "critical",
} as const;
export type IncidentSeverity = typeof IncidentSeverity[keyof typeof IncidentSeverity];

export interface ContactInfo {
    name?: string;
    phone_number?: string;
    id_card_number?: string;
}

export interface IncidentCreate {
    asset_id?: string;
    title: string;
    description: string;
    category: IncidentCategory;
    severity: IncidentSeverity;
    location?: {
        address: string;
        geometry?: { type: string; coordinates: number[] | number[][] | number[][][] };
    };
    reported_via?: string;
    public_visible?: boolean;
    contact_info?: ContactInfo;
}

export const createIncident = async (data: IncidentCreate, image?: File, turnstileToken?: string) => {
    // Photos go through the Tier-2 files capability first; only the file id is
    // sent with the report, never a data URL or base64 body. A server-issued
    // draft keeps pre-report uploads private and binds them to this report.
    const draft = image
        ? await publicApi.createAnonymousIncidentDraft(data, turnstileToken)
        : undefined;
    const uploaded = image && draft
        ? await uploadPublicFile(image, { draftId: draft.draft_id, uploadToken: draft.upload_token })
        : null;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (turnstileToken && !draft) headers["CF-Turnstile-Response"] = turnstileToken;
    const response = await httpClient.post("/public/incidents", {
        ...data,
        ...(uploaded ? { photos: [uploaded.file_id] } : {}),
        ...(draft ? { draft_id: draft.draft_id, draft_token: draft.upload_token } : {}),
    }, { headers });
    return response.data;
};

export { FileUploadError };

export default httpClient;
