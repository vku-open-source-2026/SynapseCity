// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { Ionicons } from '@expo/vector-icons';
import type { MapConfig, PublicAsset, PublicIncident, Severity } from '../api/types';
import { assetCoordinates, DEFAULT_CENTER, incidentCoordinates } from '../lib/geo';
import { assetStatusMeta, colors } from '../lib/format';
import type { AppLocation } from '../hooks/useLocation';
import { RadarMap } from './RadarMap';

interface CityMapProps {
  assets: PublicAsset[];
  incidents: PublicIncident[];
  location: AppLocation;
  mapConfig?: MapConfig | null;
  onSelectAsset: (code: string) => void;
  onSelectIncident: (reference: string) => void;
  height?: number;
  focusDataOnly?: boolean;
}

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function tileUrl(config: MapConfig | null | undefined): string {
  const raw = config?.tileUrl || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
  if (raw.startsWith('/')) return `https://synapsecity.sbs${raw}`;
  return raw;
}

function buildHtml(
  assets: Array<{
    code: string;
    name: string;
    lat: number;
    lng: number;
    color: string;
    status: string;
  }>,
  incidents: Array<{
    id: string;
    title: string;
    lat: number;
    lng: number;
    severity: Severity;
  }>,
  location: { latitude: number; longitude: number },
  config: MapConfig | null | undefined,
  focusDataOnly: boolean,
): string {
  const mapConfig = {
    tileUrl: tileUrl(config),
    attribution: config?.attribution || '&copy; OpenStreetMap contributors',
    maxZoom: config?.maxZoom || 20,
  };
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>
  html,body,#map{height:100%;margin:0;background:#F4FBFB}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
  .leaflet-control-attribution{background:rgba(255,255,255,.86)!important;color:#64748B!important;font-size:9px!important}
  .leaflet-control-attribution a{color:#0F766E!important}
  .leaflet-control-zoom a{background:#FFFFFF!important;color:#0F172A!important;border-color:#D9E8EA!important}
  .pin{width:22px;height:22px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);background:var(--c);border:2px solid #FFFFFF;box-shadow:0 3px 10px rgba(15,23,42,.22)}
  .pin span{display:block;width:7px;height:7px;border-radius:50%;background:#FFFFFF;margin:5.5px}
  .incident{width:20px;height:20px;transform:rotate(45deg);background:#F97316;border:2px solid #FFFFFF;box-shadow:0 3px 10px rgba(15,23,42,.22);display:flex;align-items:center;justify-content:center}
  .incident b{transform:rotate(-45deg);font:800 11px/1 sans-serif;color:#FFFFFF}
  .user-dot{width:16px;height:16px;border-radius:50%;background:#0E7490;border:3px solid #FFFFFF;box-shadow:0 0 0 8px rgba(14,116,144,.14)}
  .user-pulse{width:16px;height:16px;border-radius:50%;background:rgba(14,116,144,.35);animation:pulse 2.2s ease-out infinite}
  @keyframes pulse{0%{transform:scale(.7);opacity:.9}100%{transform:scale(3);opacity:0}}
</style>
</head>
<body>
<div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
  var assets = ${escapeJson(assets)};
  var incidents = ${escapeJson(incidents)};
  var origin = ${escapeJson(location)};
  var focusDataOnly = ${focusDataOnly ? 'true' : 'false'};
  var map = L.map('map', { zoomControl: false, attributionControl: true }).setView([origin.latitude, origin.longitude], 15);
  L.tileLayer(${escapeJson(mapConfig.tileUrl)}, {
    maxZoom: ${Number(mapConfig.maxZoom) || 20},
    attribution: ${escapeJson(mapConfig.attribution)}
  }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  var bounds = [];
  L.circle([origin.latitude, origin.longitude], {
    radius: 1200, color: '#0E7490', weight: 1, opacity: .25, fillColor: '#0E7490', fillOpacity: .04
  }).addTo(map);
  L.marker([origin.latitude, origin.longitude], {
    icon: L.divIcon({ className: '', html: '<div class="user-pulse"></div>', iconSize: [16,16], iconAnchor: [8,8] }),
    interactive: false, zIndexOffset: 1000
  }).addTo(map);
  L.marker([origin.latitude, origin.longitude], {
    icon: L.divIcon({ className: '', html: '<div class="user-dot"></div>', iconSize: [16,16], iconAnchor: [8,8] }),
    interactive: false, zIndexOffset: 1001
  }).addTo(map);
  if (!focusDataOnly) bounds.push([origin.latitude, origin.longitude]);

  assets.forEach(function (asset) {
    var marker = L.marker([asset.lat, asset.lng], {
      icon: L.divIcon({ className: '', html: '<div class="pin" style="--c:' + asset.color + '"><span></span></div>', iconSize: [22,22], iconAnchor: [11,22] }),
      title: asset.name
    }).addTo(map);
    marker.on('click', function () {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'asset', id: asset.code }));
    });
    bounds.push([asset.lat, asset.lng]);
  });

  incidents.forEach(function (incident) {
    var marker = L.marker([incident.lat, incident.lng], {
      icon: L.divIcon({ className: '', html: '<div class="incident"><b>!</b></div>', iconSize: [20,20], iconAnchor: [10,10] }),
      title: incident.title
    }).addTo(map);
    marker.on('click', function () {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'incident', id: incident.id }));
    });
    bounds.push([incident.lat, incident.lng]);
  });

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [42, 42], maxZoom: 16 });
  }
  setTimeout(function () {
    map.invalidateSize();
    window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'ready' }));
  }, 180);
</script>
</body>
</html>`;
}

export function CityMap({
  assets,
  incidents,
  location,
  mapConfig,
  onSelectAsset,
  onSelectIncident,
  height = 380,
  focusDataOnly = false,
}: CityMapProps) {
  const webRef = useRef<React.ComponentRef<typeof WebView>>(null);
  const readyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const payloadAssets = useMemo(
    () =>
      assets
        .map((asset) => {
          const coords = assetCoordinates(asset);
          if (!coords) return null;
          return {
            code: asset.asset_code,
            name: asset.name,
            lat: coords.latitude,
            lng: coords.longitude,
            color: assetStatusMeta(asset.status).color,
            status: asset.status,
          };
        })
        .filter((entry): entry is {
          code: string;
          name: string;
          lat: number;
          lng: number;
          color: string;
          status: string;
        } => Boolean(entry))
        .slice(0, 400),
    [assets],
  );

  const payloadIncidents = useMemo(
    () =>
      incidents
        .map((incident) => {
          const coords = incidentCoordinates(incident);
          if (!coords) return null;
          return {
            id: incident.incident_number || incident.id,
            title: incident.title,
            lat: coords.latitude,
            lng: coords.longitude,
            severity: incident.severity,
          };
        })
        .filter((entry): entry is {
          id: string;
          title: string;
          lat: number;
          lng: number;
          severity: Severity;
        } => Boolean(entry))
        .slice(0, 200),
    [incidents],
  );

  const html = useMemo(
    () =>
      buildHtml(
        payloadAssets,
        payloadIncidents,
        {
          latitude: location.latitude || DEFAULT_CENTER.latitude,
          longitude: location.longitude || DEFAULT_CENTER.longitude,
        },
        mapConfig,
        focusDataOnly,
      ),
    [payloadAssets, payloadIncidents, location.latitude, location.longitude, mapConfig, focusDataOnly],
  );

  useEffect(() => {
    readyRef.current = false;
    setReady(false);
    setFailed(false);
    const timer = setTimeout(() => {
      if (!readyRef.current) setFailed(true);
    }, 12_000);
    return () => clearTimeout(timer);
  }, [html]);

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const message = JSON.parse(event.nativeEvent.data) as { type?: string; id?: string };
        if (message.type === 'ready') {
          readyRef.current = true;
          setReady(true);
        }
        if (message.type === 'asset' && message.id) onSelectAsset(message.id);
        if (message.type === 'incident' && message.id) onSelectIncident(message.id);
      } catch {
        // Ignore malformed messages from the map.
      }
    },
    [onSelectAsset, onSelectIncident],
  );

  const recenter = useCallback(() => {
    webRef.current?.injectJavaScript(
      `map.setView([${location.latitude}, ${location.longitude}], 16, { animate: true }); true;`,
    );
  }, [location.latitude, location.longitude]);

  if (failed) {
    return (
      <View style={[styles.fallback, { height }]}>
        <RadarMap location={location} assets={assets} size={Math.min(height - 40, 300)} />
        <Text style={styles.fallbackText}>
          Bản đồ trực tuyến không tải được. Đang hiển thị radar tương đối.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.wrapper, { height }]}>
      <WebView
        ref={webRef}
        originWhitelist={['*']}
        source={{ html }}
        javaScriptEnabled
        domStorageEnabled
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        onMessage={handleMessage}
        onError={() => setFailed(true)}
        onHttpError={() => setFailed(true)}
        style={styles.web}
        allowsInlineMediaPlayback
      />
      {!ready ? (
        <View style={styles.loading} pointerEvents="none">
          <Text style={styles.loadingText}>Đang tải bản đồ…</Text>
        </View>
      ) : null}
      <TouchableOpacity style={styles.recenter} onPress={recenter} accessibilityLabel="Về vị trí của tôi">
        <Ionicons name="locate" size={20} color={colors.cyan} />
      </TouchableOpacity>
      <View style={styles.legend}>
        <View style={styles.legendRow}>
          <View style={[styles.legendDot, { backgroundColor: colors.green }]} />
          <Text style={styles.legendText}>Hoạt động</Text>
        </View>
        <View style={styles.legendRow}>
          <View style={[styles.legendDot, { backgroundColor: colors.amber }]} />
          <Text style={styles.legendText}>Bảo trì</Text>
        </View>
        <View style={styles.legendRow}>
          <View style={[styles.legendDiamond, { backgroundColor: colors.amber }]} />
          <Text style={styles.legendText}>Sự cố</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { overflow: 'hidden', borderRadius: 20, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: colors.border },
  web: { flex: 1, backgroundColor: '#F4FBFB' },
  loading: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.72)',
  },
  loadingText: { color: colors.textMuted, fontSize: 12 },
  recenter: {
    position: 'absolute',
    right: 12,
    top: 12,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#0F172A',
    shadowOpacity: 0.10,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 3,
  },
  legend: {
    position: 'absolute',
    left: 12,
    bottom: 12,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  legendRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  legendDot: { width: 8, height: 8, borderRadius: 4 },
  legendDiamond: { width: 8, height: 8, transform: [{ rotate: '45deg' }] },
  legendText: { color: colors.textMuted, fontSize: 9, fontWeight: '600' },
  fallback: {
    borderRadius: 20,
    backgroundColor: colors.bgElevated,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 14,
    gap: 10,
  },
  fallbackText: { color: colors.textMuted, fontSize: 11, textAlign: 'center' },
});
