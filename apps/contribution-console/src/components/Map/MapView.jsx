import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { INFRASTRUCTURE_TYPES, MAP_STYLE, MAP_CENTER, MAP_ZOOM, ZOOM_THRESHOLD } from '../../constants';
import { createCustomIcon, clusterFeatures, createClusterIcon } from '../../utils/mapUtils';
import { API_URL } from '../../config';

function textElement(tag, text, style = {}) {
  const element = document.createElement(tag);
  element.textContent = text;
  Object.assign(element.style, style);
  return element;
}

function clusterPopup(entry) {
  const content = document.createElement('div');
  content.append(textElement('b', `${entry.count} tài sản`));
  for (const type of entry.types) {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;justify-content:space-between;gap:12px;font-size:12px;padding:2px 0';
    const label = document.createElement('span');
    const dot = document.createElement('span');
    dot.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;background:${type.color};margin-right:6px`;
    label.append(dot, document.createTextNode(type.type));
    row.append(label, textElement('strong', String(type.count)));
    content.append(row);
  }
  content.append(textElement(
    'div',
    'Phóng to để xem từng tài sản',
    { marginTop: 6, fontSize: 11, color: '#64748b' },
  ));
  return L.popup().setContent(content);
}

function featurePopup(feature, isAdmin, onDeleteFeature) {
  const content = document.createElement('div');
  content.append(
    textElement('b', feature.properties?.feature_type || 'Tài sản'),
    document.createElement('br'),
    textElement('small', `Code: ${feature.feature_code || 'N/A'}`),
  );
  const properties = document.createElement('pre');
  properties.textContent = JSON.stringify(feature.properties, null, 2);
  content.append(properties);
  if (isAdmin) {
    const button = textElement('button', 'Delete', { color: 'red', marginTop: '5px' });
    button.addEventListener('click', () => onDeleteFeature(feature._id || feature.id, false));
    content.append(button);
  }
  return L.popup().setContent(content);
}

function reviewPopup(feature) {
  const content = document.createElement('div');
  content.append(
    textElement('b', `PENDING REVIEW: ${feature.properties?.feature_type || 'Tài sản'}`),
    textElement('p', `Contributor: ${feature.contributor_name || ''} (${feature.msv || ''})`),
  );
  const properties = document.createElement('pre');
  properties.textContent = JSON.stringify(feature.properties, null, 2);
  content.append(properties);
  return L.popup().setContent(content);
}

function linePositions(feature) {
  if (!Array.isArray(feature?.geometry?.coordinates)) return [];
  return feature.geometry.coordinates
    .filter((coordinate) => Array.isArray(coordinate)
      && typeof coordinate[0] === 'number'
      && typeof coordinate[1] === 'number')
    .map((coordinate) => [coordinate[1], coordinate[0]]);
}

export const MapView = ({
  dbFeatures,
  pendingFeatures,
  reviewFeatures = [],
  currentLinePoints,
  handleMapClick,
  onDragPoint,
  onDragLineVertex,
  showAllFeatures,
  currentZoom,
  onZoomChange,
  onDeleteFeature,
  isAdmin = false,
  flyTo = null,
}) => {
  const containerRef = useRef(null);
  const tileLayerRef = useRef(null);
  const handlersRef = useRef({ handleMapClick, onZoomChange });
  handlersRef.current = { handleMapClick, onZoomChange };
  const [map, setMap] = useState(null);

  const visibleDbFeatures = useMemo(() => {
    if (showAllFeatures) return dbFeatures;
    if (currentZoom >= ZOOM_THRESHOLD) return dbFeatures;
    return [];
  }, [dbFeatures, showAllFeatures, currentZoom]);

  const clusterEntries = useMemo(
    () => (map ? clusterFeatures(visibleDbFeatures, map, currentZoom) : []),
    [visibleDbFeatures, map, currentZoom],
  );

  // The backend decides the basemap: VietMap proxy when a key is configured,
  // OpenStreetMap otherwise. Fall back to OSM if the config call fails.
  const [tile, setTile] = useState({
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; <a href="https://openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/map/config`)
      .then((response) => (response.ok ? response.json() : null))
      .then((config) => {
        if (!cancelled && config?.tileUrl) {
          setTile({ url: config.tileUrl, attribution: config.attribution || '' });
        }
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return undefined;
    const instance = L.map(containerRef.current, {
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      scrollWheelZoom: true,
      preferCanvas: true,
    });
    setMap(instance);
    return () => {
      instance.remove();
      tileLayerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!map) return undefined;
    tileLayerRef.current?.remove();
    const layer = L.tileLayer(tile.url, {
      maxZoom: 20,
      attribution: tile.attribution,
    }).addTo(map);
    tileLayerRef.current = layer;
    return () => {
      layer.remove();
      if (tileLayerRef.current === layer) tileLayerRef.current = null;
    };
  }, [map, tile]);

  useEffect(() => {
    if (!map) return undefined;
    const onClick = (event) => handlersRef.current.handleMapClick(event);
    const onZoomEnd = (event) => handlersRef.current.onZoomChange(event.target.getZoom());
    map.on('click', onClick);
    map.on('zoomend', onZoomEnd);
    return () => {
      map.off('click', onClick);
      map.off('zoomend', onZoomEnd);
    };
  }, [map]);

  useEffect(() => {
    if (map && flyTo) {
      map.flyTo(flyTo, 18, { duration: 1.5 });
    }
  }, [flyTo, map]);

  useEffect(() => {
    if (!map) return undefined;
    const group = L.layerGroup().addTo(map);

    for (const entry of clusterEntries || []) {
      if (entry.type === 'cluster') {
        L.marker([entry.lat, entry.lng], {
          icon: createClusterIcon(entry),
        })
          .bindPopup(clusterPopup(entry))
          .addTo(group);
        continue;
      }
      const feature = entry.feature;
      if (!feature?.properties || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) continue;
      const [lng, lat] = feature.geometry.coordinates;
      if (typeof lng !== 'number' || typeof lat !== 'number') continue;
      const color = INFRASTRUCTURE_TYPES[feature.properties.feature_type]?.color || 'blue';
      const featureCode = INFRASTRUCTURE_TYPES[feature.properties.feature_type]?.code;
      L.marker([lat, lng], {
        icon: createCustomIcon(color, false, false, featureCode),
      })
        .bindPopup(featurePopup(feature, isAdmin, onDeleteFeature))
        .addTo(group);
    }

    for (const feature of visibleDbFeatures || []) {
      if (feature?.geometry?.type !== 'LineString') continue;
      const positions = linePositions(feature);
      if (positions.length < 2) continue;
      const color = INFRASTRUCTURE_TYPES[feature.properties?.feature_type]?.color || 'blue';
      L.polyline(positions, { color })
        .bindPopup(featurePopup(feature, isAdmin, onDeleteFeature))
        .addTo(group);
    }

    for (const feature of reviewFeatures || []) {
      if (!feature?.properties || !feature.geometry || !Array.isArray(feature.geometry.coordinates)) continue;
      const color = INFRASTRUCTURE_TYPES[feature.properties.feature_type]?.color || 'orange';
      const featureCode = INFRASTRUCTURE_TYPES[feature.properties.feature_type]?.code;
      if (feature.geometry.type === 'Point') {
        const [lng, lat] = feature.geometry.coordinates;
        if (typeof lng !== 'number' || typeof lat !== 'number') continue;
        L.marker([lat, lng], {
          icon: createCustomIcon(color, true, true, featureCode),
          opacity: 0.7,
        })
          .bindPopup(reviewPopup(feature))
          .addTo(group);
      } else {
        const positions = linePositions(feature);
        if (positions.length < 2) continue;
        L.polyline(positions, {
          color,
          dashArray: '10, 5',
          opacity: 0.85,
          weight: 4,
        })
          .bindPopup(reviewPopup(feature))
          .addTo(group);
      }
    }

    for (const [index, feature] of (pendingFeatures || []).entries()) {
      const color = INFRASTRUCTURE_TYPES[feature.properties?.feature_type]?.color || 'orange';
      const featureCode = INFRASTRUCTURE_TYPES[feature.properties?.feature_type]?.code;
      if (feature.geometry?.type === 'Point') {
        const [lng, lat] = feature.geometry.coordinates;
        if (typeof lng !== 'number' || typeof lat !== 'number') continue;
        const marker = L.marker([lat, lng], {
          draggable: true,
          icon: createCustomIcon(color, true, false, featureCode),
        }).addTo(group);
        marker.on('dragend', () => onDragPoint(index, marker.getLatLng()));
      } else {
        const positions = linePositions(feature);
        if (positions.length < 2) continue;
        L.polyline(positions, {
          color,
          dashArray: '8, 5',
          opacity: 0.8,
          weight: 3,
        }).addTo(group);
        for (const [vertexIndex, position] of positions.entries()) {
          const marker = L.marker(position, {
            draggable: true,
            icon: L.divIcon({
              className: 'line-vertex-icon',
              html: '<div style="width:10px;height:10px;background:red;border-radius:50%"></div>',
            }),
          }).addTo(group);
          marker.on('dragend', () => onDragLineVertex(index, vertexIndex, marker.getLatLng()));
        }
      }
    }

    if (currentLinePoints.length > 0) {
      L.polyline(currentLinePoints, { color: 'red', dashArray: '5, 5' }).addTo(group);
      for (const point of currentLinePoints) {
        L.circleMarker(point, { radius: 3, color: 'red' }).addTo(group);
      }
    }

    return () => {
      group.clearLayers();
      map.removeLayer(group);
    };
  }, [
    map,
    clusterEntries,
    visibleDbFeatures,
    reviewFeatures,
    pendingFeatures,
    currentLinePoints,
    isAdmin,
    onDeleteFeature,
    onDragPoint,
    onDragLineVertex,
  ]);

  return <div ref={containerRef} style={MAP_STYLE} />;
};
