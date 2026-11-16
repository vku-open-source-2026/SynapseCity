// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, {
    useState,
    useEffect,
    useRef,
    useMemo,
    useCallback,
} from "react";
import { type Asset, getAssetId } from "../api";
import { getIconForAsset, getColorForFeatureCode, featureLabel } from "../utils/mapIcons";
import HeatmapLayer from "./HeatmapLayer";
import AssetLayerFilter from "./AssetLayerFilter";
import { AddressSearch } from "./geo/AddressSearch";
import { NearbySearch } from "./geo/NearbySearch";
import { PolygonDraw } from "./geo/PolygonDraw";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import { fetchTileConfig } from "../lib/tileConfig";

type LeafletIconDefaultWithPrivate = typeof L.Icon.Default.prototype & {
    _getIconUrl?: unknown;
};

// Disable default Leaflet marker icons to prevent showing default markers
delete (L.Icon.Default.prototype as LeafletIconDefaultWithPrivate)._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: undefined,
    iconUrl: undefined,
    shadowUrl: undefined,
});

// ---------------------------------------------------------------------------
// Screen-space marker clustering.
//
// Assets are grouped into a pixel grid at the current zoom, across all types,
// so a distant view shows one bubble per area with a per-type breakdown. At
// zoom 17+ the bubbles open into the individual asset icons. The grid is
// computed from projected coordinates (independent of the map centre), which
// lets the cluster set stay stable while the user pans.
// ---------------------------------------------------------------------------
interface ClusterTypeCount {
    featureCode: string;
    label: string;
    color: string;
    count: number;
}

interface ClusterItem {
    type: "single";
    asset: Asset;
}
interface ClusterGroup {
    type: "cluster";
    key: string;
    lat: number;
    lng: number;
    count: number;
    types: ClusterTypeCount[];
    assets: Asset[];
}
type ClusterEntry = ClusterItem | ClusterGroup;

const MAX_CLUSTER_ZOOM = 17;

function clusterGridPx(zoom: number): number {
    if (zoom <= 11) return 96;
    if (zoom <= 13) return 72;
    if (zoom <= 15) return 56;
    return 44;
}

function clusterAssets(
    assets: Asset[],
    map: L.Map,
    zoom: number
): ClusterEntry[] {
    const pointAssets = assets.filter(
        (asset) =>
            asset.geometry?.type === "Point" &&
            Array.isArray(asset.geometry.coordinates) &&
            typeof asset.geometry.coordinates[0] === "number" &&
            typeof asset.geometry.coordinates[1] === "number"
    );

    if (zoom >= MAX_CLUSTER_ZOOM) {
        return pointAssets.map((asset) => ({ type: "single", asset }));
    }

    const grid = clusterGridPx(zoom);
    const cells = new Map<string, Asset[]>();
    for (const asset of pointAssets) {
        const [lng, lat] = asset.geometry.coordinates as number[];
        const point = map.project([lat, lng], zoom);
        const key = `${Math.floor(point.x / grid)}:${Math.floor(point.y / grid)}`;
        const bucket = cells.get(key) ?? [];
        bucket.push(asset);
        cells.set(key, bucket);
    }

    const entries: ClusterEntry[] = [];
    cells.forEach((bucket, cellKey) => {
        if (bucket.length === 1) {
            entries.push({ type: "single", asset: bucket[0] });
            return;
        }
        let sumLat = 0;
        let sumLng = 0;
        const counts = new Map<string, number>();
        for (const asset of bucket) {
            const [lng, lat] = asset.geometry.coordinates as number[];
            sumLat += lat;
            sumLng += lng;
            const code = asset.feature_code || "infrastructure";
            counts.set(code, (counts.get(code) || 0) + 1);
        }
        const types = [...counts.entries()]
            .map(([featureCode, count]) => ({
                featureCode,
                label: featureLabel(featureCode),
                color: getColorForFeatureCode(featureCode),
                count,
            }))
            .sort((left, right) => right.count - left.count);
        entries.push({
            type: "cluster",
            key: `cluster:${zoom}:${cellKey}:${types.map((entry) => `${entry.featureCode}=${entry.count}`).join(",")}`,
            lat: sumLat / bucket.length,
            lng: sumLng / bucket.length,
            count: bucket.length,
            types,
            assets: bucket,
        });
    });
    return entries;
}

const clusterIconCache = new Map<string, L.DivIcon>();

function getClusterIcon(entry: ClusterGroup): L.DivIcon {
    const cached = clusterIconCache.get(entry.key);
    if (cached) return cached;
    const dominant = entry.types[0];
    const border = dominant?.color || "#2563eb";
    const breakdown = entry.types
        .slice(0, 4)
        .map(
            (type) => `<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;color:#475569">`
                + `<span style="width:7px;height:7px;border-radius:50%;background:${type.color};display:inline-block"></span>`
                + `${type.count}</span>`
        )
        .join("");
    const html = `
        <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
            <div style="min-width:42px;padding:3px 7px 4px;border-radius:14px;background:#ffffff;border:2px solid ${border};box-shadow:0 4px 14px rgba(15,23,42,0.22);text-align:center;">
                <div style="font-size:14px;font-weight:800;line-height:1.1;color:#0f172a;">${entry.count}</div>
                <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-top:1px;">${breakdown}</div>
            </div>
        </div>
    `;
    const icon = L.divIcon({
        html,
        className: "asset-cluster-icon",
        iconSize: [64, 42],
        iconAnchor: [32, 24],
        popupAnchor: [0, -22],
    });
    clusterIconCache.set(entry.key, icon);
    return icon;
}

function clusterPopup(entry: ClusterGroup): string {
    const rows = entry.types
        .map(
            (type) => `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 0;font-size:12px">`
                + `<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${type.color};display:inline-block"></span>${escapeHtml(type.label)}</span>`
                + `<strong>${type.count}</strong></div>`
        )
        .join("");
    return `<div style="min-width:190px"><div style="font-weight:800;margin-bottom:4px">${entry.count} tài sản</div>${rows}`
        + `<div style="margin-top:6px;font-size:11px;color:#64748b">Phóng to để xem từng tài sản</div></div>`;
}

interface MapProps {
    assets: Asset[];
    onAssetSelect: (asset: Asset | null) => void;
    onFilterByShape?: (assets: Asset[] | null) => void;
    routePoints?: Asset[]; // For routing feature
    selectedAsset?: Asset | null;
    className?: string;
    enableGeoSearches?: boolean;
    onMapReady?: (map: L.Map) => void;
    initialZoom?: number;
    /** Fit the viewport to the loaded asset extent on first load. */
    fitToAssets?: boolean;
}

const toLatLng = (coord: number[]): [number, number] => [coord[1], coord[0]];

const HTML_ESCAPE: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
};

/** Leaflet treats bindPopup() strings as HTML; never interpolate raw API text. */
function escapeHtml(value: unknown): string {
    return String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPE[char] ?? char);
}

function assetStatusBadge(status: unknown): { label: string; className: string } | null {
    const value = String(status ?? "").trim().toLowerCase();
    if (!value) return null;

    if (["active", "operational", "online"].includes(value)) {
        return { label: "Đang hoạt động", className: "bg-green-100 text-green-700" };
    }
    if (["maintenance", "under_repair", "maintaining"].includes(value)) {
        return { label: "Đang bảo trì", className: "bg-amber-100 text-amber-700" };
    }
    if (["damaged", "offline", "error"].includes(value)) {
        return { label: "Có sự cố", className: "bg-red-100 text-red-700" };
    }
    if (["inactive", "decommissioned", "retired"].includes(value)) {
        return { label: "Ngừng hoạt động", className: "bg-slate-100 text-slate-600" };
    }
    return { label: String(status), className: "bg-slate-100 text-slate-600" };
}

const geometryToLatLngs = (geometry: Asset["geometry"]): [number, number][] => {
    if (!geometry || !geometry.coordinates) return [];

    const coords = geometry.coordinates as unknown;
    switch (geometry.type) {
        case "Point":
            if (Array.isArray(coords) && typeof coords[0] === "number") {
                return [toLatLng(coords as number[])];
            }
            return [];
        case "LineString":
            if (
                Array.isArray(coords) &&
                Array.isArray(coords[0]) &&
                typeof coords[0][0] === "number"
            ) {
                return (coords as number[][]).map(toLatLng);
            }
            return [];
        case "MultiLineString":
            if (Array.isArray(coords)) {
                return (coords as number[][][]).flatMap((line) =>
                    (line as number[][]).map(toLatLng)
                );
            }
            return [];
        case "Polygon":
            if (
                Array.isArray(coords) &&
                Array.isArray(coords[0]) &&
                Array.isArray(coords[0][0])
            ) {
                return (coords as number[][][])[0].map(toLatLng);
            }
            return [];
        case "MultiPolygon":
            if (Array.isArray(coords)) {
                return (coords as number[][][][]).flatMap((poly) =>
                    (poly[0] as number[][]).map(toLatLng)
                );
            }
            return [];
        case "MultiPoint":
            if (
                Array.isArray(coords) &&
                Array.isArray(coords[0]) &&
                typeof coords[0][0] === "number"
            ) {
                return (coords as number[][]).map(toLatLng);
            }
            return [];
        default:
            return [];
    }
};

const latLngsToBounds = (
    latLngs: [number, number][]
): L.LatLngBounds | null => {
    if (!latLngs.length) return null;
    const points = latLngs.map(([lat, lng]) => L.latLng(lat, lng));
    return L.latLngBounds(points);
};

const DEFAULT_MAP_CENTER: [number, number] = [16.047079, 108.20623];

const MapComponent: React.FC<MapProps> = ({
    assets,
    onAssetSelect,
    routePoints,
    selectedAsset,
    className,
    onMapReady,
    onFilterByShape,
    enableGeoSearches,
    initialZoom = 16,
    fitToAssets = true,
}) => {
    const [mapMode, setMapMode] = useState<"markers" | "heatmap">("markers");
    const mapRef = useRef<L.Map | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const markerRefs = useRef<{ [key: string]: L.Marker | null }>({});
    const didFitAssets = useRef(false);
    const polylineRefs = useRef<{ [key: string]: L.Polyline | null }>({});
    const routePolylineRef = useRef<L.Polyline | null>(null);
    const tileLayerRef = useRef<L.TileLayer | null>(null);
    const [mapBounds, setMapBounds] = useState<L.LatLngBounds | null>(null);
    const [mapZoom, setMapZoom] = useState<number>(initialZoom);
    const [filteredAssets, setFilteredAssets] = useState<Asset[]>(assets);
    const [heatmapMap, setHeatmapMap] = useState<L.Map | null>(null);
    const filterCallbackRef = useRef(onFilterByShape);
    useEffect(() => {
        filterCallbackRef.current = onFilterByShape;
    }, [onFilterByShape]);

    const handleGeoFilterResults = useCallback(
        (nextAssets: Asset[]) => {
            setFilteredAssets(nextAssets);
            filterCallbackRef.current?.(nextAssets);
        },
        []
    );

    // Prepare heatmap data
    const heatmapPoints = assets
        .filter(
            (a) =>
                a.geometry.type === "Point" &&
                Array.isArray(a.geometry.coordinates) &&
                a.geometry.coordinates.length >= 2
        )
        .map(
            (a) =>
                [a.geometry.coordinates[1], a.geometry.coordinates[0], 0.5] as [
                    number,
                    number,
                    number
                ]
        );

    const assetIntersectsBounds = useCallback(
        (asset: Asset, bounds: L.LatLngBounds) => {
            const latLngs = geometryToLatLngs(asset.geometry);
            if (!latLngs.length) return false;
            const assetBounds = latLngsToBounds(latLngs);
            if (!assetBounds) return false;
            return bounds.intersects(assetBounds);
        },
        []
    );

    // Reset a shape filter when the source asset collection changes. Defer the
    // state update so this synchronization does not run during the effect's
    // commit phase.
    useEffect(() => {
        const resetFilter = window.setTimeout(() => setFilteredAssets(assets), 0);
        return () => window.clearTimeout(resetFilter);
    }, [assets]);

    const visibleAssets = useMemo(() => {
        if (!mapBounds) return filteredAssets;
        const filtered = filteredAssets.filter((asset) =>
            assetIntersectsBounds(asset, mapBounds)
        );

        // Always include selected asset even if currently out of bounds (so it renders after fitBounds)
        if (
            selectedAsset &&
            !filtered.find((a) => getAssetId(a) === getAssetId(selectedAsset))
        ) {
            filtered.push(selectedAsset);
        }

        return filtered;
    }, [filteredAssets, assetIntersectsBounds, mapBounds, selectedAsset]);

    // Cluster markers across all asset types. Computing this from projected
    // coordinates (not the viewport) keeps the result stable while panning.
    const clusterEntries = useMemo(() => {
        if (!heatmapMap) return [] as ClusterEntry[];
        return clusterAssets(filteredAssets, heatmapMap, mapZoom);
    }, [filteredAssets, heatmapMap, mapZoom]);

    const visibleClusterEntries = useMemo(() => {
        if (!mapBounds) return clusterEntries;
        return clusterEntries.filter((entry) => {
            if (entry.type === "single") {
                const coordinates = entry.asset.geometry.coordinates as number[];
                const inBounds = mapBounds.contains([coordinates[1], coordinates[0]]);
                const isSelected = selectedAsset
                    ? getAssetId(selectedAsset) === getAssetId(entry.asset)
                    : false;
                return inBounds || isSelected;
            }
            return mapBounds.contains([entry.lat, entry.lng]);
        });
    }, [clusterEntries, mapBounds, selectedAsset]);

    // Initialize map
    useEffect(() => {
        if (!containerRef.current || mapRef.current) return;

        const map = L.map(containerRef.current, {
            center: DEFAULT_MAP_CENTER,
            zoom: initialZoom,
            maxZoom: 20,
            scrollWheelZoom: true,
            preferCanvas: true,
        });

        // Add tile layer (fetched from backend)
        mapRef.current = map;
        setHeatmapMap(map);
        fetchTileConfig().then((cfg) => {
            if (!mapRef.current) return;
            const tileLayer = L.tileLayer(cfg.tileUrl, {
                attribution: cfg.attribution,
                maxZoom: cfg.maxZoom,
                ...(cfg.maxNativeZoom ? { maxNativeZoom: cfg.maxNativeZoom } : {}),
            });
            tileLayer.addTo(mapRef.current);
            tileLayerRef.current = tileLayer;
        });

        // Set initial bounds
        setMapBounds(map.getBounds());
        setMapZoom(map.getZoom());

        // Notify parent that map is ready
        onMapReady?.(map);

        // Listen to map events for bounds updates
        const updateBounds = () => {
            setMapBounds(map.getBounds());
            setMapZoom(map.getZoom());
        };

        map.on("moveend", updateBounds);
        map.on("zoomend", updateBounds);
        map.on("resize", updateBounds);

        return () => {
            map.off("moveend", updateBounds);
            map.off("zoomend", updateBounds);
            map.off("resize", updateBounds);
            map.remove();
            mapRef.current = null;
            setHeatmapMap(null);
        };
    }, [onMapReady, initialZoom]);

    // Show the complete inventory on first load instead of a fixed city-centre
    // viewport that may clip the outer districts.
    useEffect(() => {
        if (!fitToAssets || didFitAssets.current) return;
        const map = mapRef.current;
        if (!map || !assets.length || selectedAsset) return;
        const allLatLngs = assets.flatMap((asset) => geometryToLatLngs(asset.geometry));
        const bounds = latLngsToBounds(allLatLngs);
        if (!bounds || !bounds.isValid()) return;
        map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
        didFitAssets.current = true;
    }, [assets, fitToAssets, selectedAsset]);

    // Handle selected asset changes - fly to or fit bounds
    useEffect(() => {
        if (!mapRef.current || !selectedAsset) return;

        const map = mapRef.current;

        if (selectedAsset.geometry.type === "Point") {
            const [lng, lat] = selectedAsset.geometry.coordinates as number[];

            // Fly to the asset
            map.flyTo([lat, lng], 18, {
                animate: true,
                duration: 1.5,
            });

            // Open popup if marker exists
            const marker = markerRefs.current[getAssetId(selectedAsset)];
            if (marker) {
                setTimeout(() => {
                    marker.openPopup();
                }, 500);
            }
            return;
        }

        // For non-Point geometries, fit bounds to the shape
        const latLngs = geometryToLatLngs(selectedAsset.geometry);
        if (latLngs.length) {
            const bounds = latLngsToBounds(latLngs);
            if (bounds) {
                map.fitBounds(bounds, { padding: [50, 50], maxZoom: 18 });
            }
        }
    }, [selectedAsset]);

    // Render markers and polylines
    useEffect(() => {
        if (!mapRef.current || mapMode !== "markers") return;

        const map = mapRef.current;

        // Clean up old markers and polylines
        Object.values(markerRefs.current).forEach((marker) => {
            if (marker) {
                map.removeLayer(marker);
            }
        });
        Object.values(polylineRefs.current).forEach((polyline) => {
            if (polyline) {
                map.removeLayer(polyline);
            }
        });
        markerRefs.current = {};
        polylineRefs.current = {};

        // Render the clustered/individual markers selected for this zoom.
        visibleClusterEntries.forEach((entry) => {
            if (entry.type === "cluster") {
                const marker = L.marker([entry.lat, entry.lng], { icon: getClusterIcon(entry) })
                    .addTo(map)
                    .bindPopup(clusterPopup(entry), { className: "custom-popup" });
                markerRefs.current[entry.key] = marker;
                return;
            }

            // Single asset
            const asset = entry.asset;
            if (asset.geometry.type === "Point") {
                const coords = asset.geometry.coordinates as number[];
                const position: [number, number] = [coords[1], coords[0]];
                const assetId = getAssetId(asset);
                const isSelected = selectedAsset
                    ? getAssetId(selectedAsset) === assetId
                    : false;

                // Create popup content from persisted fields only.
                const statusBadge = assetStatusBadge(
                    (asset as Asset & { status?: string }).status
                );
                const statusMarkup = statusBadge
                    ? `<div class="mt-2 text-xs"><span class="px-2 py-0.5 rounded-full ${statusBadge.className}">${escapeHtml(statusBadge.label)}</span></div>`
                    : "";
                const popupContent = `
                    <div class="font-semibold text-slate-900">${escapeHtml(featureLabel(asset.feature_code, asset.feature_type))}</div>
                    <div class="text-xs text-slate-500">${escapeHtml(asset.feature_code)}</div>
                    ${statusMarkup}
                `;

                const marker = L.marker(position, {
                    icon: getIconForAsset(asset.feature_code, isSelected),
                    zIndexOffset: isSelected ? 1000 : 0,
                })
                    .addTo(map)
                    .bindPopup(popupContent, {
                        className: "custom-popup",
                    })
                    .on("click", () => {
                        onAssetSelect(asset);
                    });

                markerRefs.current[assetId] = marker;
            }
        });

        // Add LineString polylines
        visibleAssets.forEach((asset) => {
            if (asset.geometry.type === "LineString") {
                const positions = (
                    asset.geometry.coordinates as number[][]
                ).map(
                    (coord: number[]) =>
                        [coord[1], coord[0]] as [number, number]
                );
                const color = getColorForFeatureCode(asset.feature_code);
                const assetId = getAssetId(asset);

                const popupContent = `
                    <div class="font-semibold text-slate-900">${escapeHtml(featureLabel(asset.feature_code, asset.feature_type))}</div>
                    <div class="text-xs text-slate-500">${escapeHtml(asset.feature_code)}</div>
                `;

                const polyline = L.polyline(positions, {
                    color,
                    weight: 4,
                    opacity: 0.8,
                })
                    .addTo(map)
                    .bindPopup(popupContent, {
                        className: "custom-popup",
                    })
                    .on("click", () => {
                        onAssetSelect(asset);
                    });

                polylineRefs.current[assetId] = polyline;
            }
        });
    }, [visibleClusterEntries, visibleAssets, mapMode, selectedAsset, onAssetSelect]);

    // Render route polyline
    useEffect(() => {
        if (!mapRef.current || !routePoints || routePoints.length <= 1) {
            if (routePolylineRef.current) {
                mapRef.current?.removeLayer(routePolylineRef.current);
                routePolylineRef.current = null;
            }
            return;
        }

        const map = mapRef.current;
        const positions = routePoints
            .filter((a) => a.geometry.type === "Point")
            .map((a) => {
                const coords = a.geometry.coordinates as number[];
                return [coords[1], coords[0]] as [number, number];
            });

        if (routePolylineRef.current) {
            map.removeLayer(routePolylineRef.current);
        }

        const routePolyline = L.polyline(positions, {
            color: "blue",
            weight: 4,
            opacity: 0.7,
            dashArray: "10, 10",
        }).addTo(map);

        routePolylineRef.current = routePolyline;
    }, [routePoints]);

    return (
        <div
            className={`w-full relative group ${
                className || "h-[calc(100vh-250px)]"
            }`}
        >
            {/* Asset Layer Filter */}
            <AssetLayerFilter
                assets={assets}
                onFilterChange={setFilteredAssets}
            />

            {enableGeoSearches && heatmapMap && (
                <div className="absolute top-20 left-4 z-[1000] flex max-w-[calc(100%-2rem)] flex-wrap items-start gap-2">
                    <AddressSearch map={heatmapMap} />
                    <NearbySearch
                        map={heatmapMap}
                        onResults={handleGeoFilterResults}
                        onClear={() => handleGeoFilterResults(assets)}
                    />
                    <PolygonDraw
                        map={heatmapMap}
                        onResults={handleGeoFilterResults}
                        onClear={() => handleGeoFilterResults(assets)}
                    />
                </div>
            )}

            {/* Map Controls Overlay */}
            <div className="absolute top-4 right-4 z-51 bg-white rounded-lg shadow-md border border-slate-200 p-1 flex flex-col gap-1">
                <button
                    onClick={() => setMapMode("markers")}
                    className={`p-2 rounded hover:bg-slate-100 ${
                        mapMode === "markers"
                            ? "bg-blue-50 text-blue-600"
                            : "text-slate-600"
                    }`}
                    title="View markers / Chế độ điểm"
                    aria-label="View markers / Chế độ điểm"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
                        <circle cx="12" cy="10" r="3" />
                    </svg>
                </button>
                <button
                    onClick={() => setMapMode("heatmap")}
                    className={`p-2 rounded hover:bg-slate-100 ${
                        mapMode === "heatmap"
                            ? "bg-blue-50 text-blue-600"
                            : "text-slate-600"
                    }`}
                    title="View heatmap / Bản đồ nhiệt"
                    aria-label="View heatmap / Bản đồ nhiệt"
                >
                    <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="20"
                        height="20"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
                        <path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
                        <path d="M12 2v2" />
                        <path d="M12 22v-2" />
                        <path d="M2 12h2" />
                        <path d="M22 12h-2" />
                        <path d="M4.93 4.93l1.41 1.41" />
                        <path d="M17.66 17.66l1.41 1.41" />
                        <path d="M4.93 19.07l1.41-1.41" />
                        <path d="M17.66 6.34l1.41 1.41" />
                    </svg>
                </button>
            </div>

            {/* Map Container */}
            <div
                ref={containerRef}
                className="h-full w-full rounded-xl shadow-sm border border-slate-200"
            />

            {/* Heatmap Layer */}
            {mapMode === "heatmap" && heatmapMap && (
                <HeatmapLayer map={heatmapMap} points={heatmapPoints} />
            )}
        </div>
    );
};

export default MapComponent;
