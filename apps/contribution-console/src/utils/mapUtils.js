import L from 'leaflet';
import { getSVGIcon } from './svgIcons';
import { INFRASTRUCTURE_TYPES } from '../constants';

const markerIconCache = new Map();

export const createCustomIcon = (color, isPreview = false, isReview = false, featureCode = null) => {
  const cacheKey = `${color}:${isPreview ? 1 : 0}:${isReview ? 1 : 0}:${featureCode || ''}`;
  const cached = markerIconCache.get(cacheKey);
  if (cached) return cached;
  let className = 'custom-marker';
  if (isPreview) className += ' preview-feature';
  if (isReview) className += ' review-feature'; 

  // Use SVG icon if feature code is provided, otherwise fallback to simple marker
  let iconHtml;
  if (featureCode) {
    iconHtml = getSVGIcon(featureCode, color);
  } else {
    // Fallback to simple colored marker
    iconHtml = `<div style="background-color: ${color}" class="marker-pin"></div>`;
  }

  const icon = L.divIcon({
    className: className,
    html: iconHtml,
    iconSize: [30, 30],
    iconAnchor: [15, 30],
    popupAnchor: [0, -30]
  });
  markerIconCache.set(cacheKey, icon);
  return icon;
};

// ---------------------------------------------------------------------------
// Screen-space clustering shared by both views. At low zoom one bubble groups
// every asset in a pixel cell and shows a per-type count; at the threshold the
// individual markers take over.
// ---------------------------------------------------------------------------
export const CLUSTER_MAX_ZOOM = 17;

function clusterGridPx(zoom) {
  if (zoom <= 11) return 96;
  if (zoom <= 13) return 72;
  return 56;
}

export const clusterFeatures = (features, map, zoom) => {
  const points = (features || []).filter((feature) => (
    feature &&
    feature.geometry &&
    feature.geometry.type === 'Point' &&
    Array.isArray(feature.geometry.coordinates) &&
    typeof feature.geometry.coordinates[0] === 'number' &&
    typeof feature.geometry.coordinates[1] === 'number'
  ));
  if (zoom >= CLUSTER_MAX_ZOOM) {
    return points.map((feature) => ({ type: 'single', feature }));
  }
  const grid = clusterGridPx(zoom);
  const cells = new Map();
  for (const feature of points) {
    const [lng, lat] = feature.geometry.coordinates;
    const point = map.project([lat, lng], zoom);
    const key = `${Math.floor(point.x / grid)}:${Math.floor(point.y / grid)}`;
    const bucket = cells.get(key) || [];
    bucket.push(feature);
    cells.set(key, bucket);
  }
  const entries = [];
  cells.forEach((bucket, cellKey) => {
    if (bucket.length === 1) {
      entries.push({ type: 'single', feature: bucket[0] });
      return;
    }
    let sumLat = 0;
    let sumLng = 0;
    const counts = new Map();
    for (const feature of bucket) {
      sumLat += feature.geometry.coordinates[1];
      sumLng += feature.geometry.coordinates[0];
      const type = feature.properties?.feature_type || 'Khác';
      counts.set(type, (counts.get(type) || 0) + 1);
    }
    const types = [...counts.entries()]
      .map(([type, count]) => ({
        type,
        count,
        color: INFRASTRUCTURE_TYPES[type]?.color || '#2563eb',
        code: INFRASTRUCTURE_TYPES[type]?.code || 'khac',
      }))
      .sort((left, right) => right.count - left.count);
    entries.push({
      type: 'cluster',
      key: `cluster:${zoom}:${cellKey}:${types.map((entry) => `${entry.type}=${entry.count}`).join(',')}`,
      lat: sumLat / bucket.length,
      lng: sumLng / bucket.length,
      count: bucket.length,
      types,
      features: bucket,
    });
  });
  return entries;
};

const clusterIconCache = new Map();

export const createClusterIcon = (entry) => {
  const cached = clusterIconCache.get(entry.key);
  if (cached) return cached;
  const dominant = entry.types[0];
  const border = dominant?.color || '#2563eb';
  const breakdown = entry.types.slice(0, 4).map((type) => (
    `<span style="display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:700;color:#475569">`
    + `<span style="width:7px;height:7px;border-radius:50%;background:${type.color};display:inline-block"></span>${type.count}</span>`
  )).join('');
  const html = `
    <div style="display:flex;flex-direction:column;align-items:center;gap:2px;">
      <div style="min-width:42px;padding:3px 7px 4px;border-radius:14px;background:#fff;border:2px solid ${border};box-shadow:0 4px 14px rgba(15,23,42,0.22);text-align:center;">
        <div style="font-size:14px;font-weight:800;line-height:1.1;color:#0f172a;">${entry.count}</div>
        <div style="display:flex;align-items:center;justify-content:center;gap:4px;margin-top:1px;">${breakdown}</div>
      </div>
    </div>`;
  const icon = L.divIcon({
    className: 'custom-cluster-icon',
    html,
    iconSize: [64, 42],
    iconAnchor: [32, 24],
    popupAnchor: [0, -22],
  });
  clusterIconCache.set(entry.key, icon);
  return icon;
};

export const clusterPopupHtml = (entry) => {
  const rows = entry.types.map((type) => (
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:2px 0;font-size:12px">`
    + `<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:50%;background:${type.color};display:inline-block"></span>${type.type}</span>`
    + `<strong>${type.count}</strong></div>`
  )).join('');
  return `<div style="min-width:180px"><div style="font-weight:800;margin-bottom:4px">${entry.count} tài sản</div>${rows}`
    + `<div style="margin-top:6px;font-size:11px;color:#64748b">Phóng to để xem từng tài sản</div></div>`;
};

export const groupContributionsByBatch = (contributions) => {
  if (!contributions || contributions.length === 0) return [];
  
  const batches = [];
  const sorted = [...contributions].sort((a, b) => 
    new Date(a.timestamp) - new Date(b.timestamp)
  );
  
  for (const contrib of sorted) {
    const lastBatch = batches[batches.length - 1];
    const timeDiff = lastBatch ? 
      new Date(contrib.timestamp) - new Date(lastBatch.timestamp) : Infinity;
    
    // Group if same contributor, MSV, and within 5 seconds
    if (lastBatch && 
        lastBatch.contributor_name === contrib.contributor_name &&
        lastBatch.msv === contrib.msv &&
        timeDiff < 5000) {
      lastBatch.features.push(contrib);
      lastBatch.count++;
    } else {
      batches.push({
        batchId: `batch-${contrib.id || Date.now()}-${Math.random()}`,
        contributor_name: contrib.contributor_name,
        msv: contrib.msv,
        timestamp: contrib.timestamp,
        features: [contrib],
        count: 1
      });
    }
  }
  
  return batches;
};
