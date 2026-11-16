// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { MapConfig, PublicAsset, PublicIncident } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import { assetStatusMeta, colors } from '../lib/format';
import { formatDistance } from '../lib/geo';
import { distanceMeters } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import type { NearbyAsset } from '../hooks/useCityData';
import { Card, Chip, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { CityMap } from '../components/CityMap';

interface MapScreenProps {
  location: AppLocation;
  assets: PublicAsset[];
  incidents: PublicIncident[];
  nearby: NearbyAsset[];
  mapConfig?: MapConfig | null;
  mapConfigLoading?: boolean;
  navigate: (route: AppRoute) => void;
}

type Filter = 'all' | 'active' | 'maintenance';

export function MapScreen({
  location,
  assets,
  incidents,
  nearby,
  mapConfig,
  mapConfigLoading,
  navigate,
}: MapScreenProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const filteredAssets = useMemo(() => {
    if (filter === 'all') return assets;
    return assets.filter((asset) => asset.status === filter);
  }, [assets, filter]);

  const filteredNearby = useMemo(() => {
    if (filter === 'all') return nearby;
    return nearby.filter((entry) => entry.asset.status === filter);
  }, [nearby, filter]);

  const outsideCoverage =
    location.latitude < 8 ||
    location.latitude > 24 ||
    location.longitude < 102 ||
    location.longitude > 110.5;

  const mapAssets = useMemo(
    () =>
      outsideCoverage
        ? assets.slice(0, 24)
        : filteredNearby.slice(0, 24).map((entry) => entry.asset),
    [assets, filteredNearby, outsideCoverage],
  );
  const mapIncidents = useMemo(
    () =>
      incidents.filter((incident) => {
        const coords = incident.location?.coordinates;
        if (!coords) return false;
        if (outsideCoverage) {
          return (
            coords.latitude >= 8 &&
            coords.latitude <= 24 &&
            coords.longitude >= 102 &&
            coords.longitude <= 110.5
          );
        }
        return (
          distanceMeters(
            { latitude: location.latitude, longitude: location.longitude },
            coords,
          ) <= 25_000
        );
      }),
    [incidents, location.latitude, location.longitude, outsideCoverage],
  );

  return (
    <Screen scroll>
      <PageHeader
        eyebrow="BẢN ĐỒ"
        title="Hạ tầng quanh bạn"
        subtitle={`${assets.length} tài sản công khai · ${incidents.length} sự cố công khai`}
      />
      <View style={styles.filters}>
        <Chip
          label="Tất cả"
          icon="layers"
          active={filter === 'all'}
          onPress={() => setFilter('all')}
        />
        <Chip
          label="Hoạt động"
          icon="checkmark-circle"
          active={filter === 'active'}
          onPress={() => setFilter('active')}
        />
        <Chip
          label="Bảo trì"
          icon="construct"
          active={filter === 'maintenance'}
          onPress={() => setFilter('maintenance')}
        />
        {mapConfigLoading ? <Chip label="Đang tải tile" color={colors.textDim} /> : null}
      </View>

      {outsideCoverage ? (
        <Card tone="cyan">
          <Text style={styles.coverageText}>
            Vị trí của bạn ngoài vùng dữ liệu Đà Nẵng. Bản đồ đang hiển thị tài sản công khai
            của thành phố; danh sách “gần bạn” sẽ trống cho tới khi bạn ở trong vùng dữ liệu.
          </Text>
        </Card>
      ) : null}

      <CityMap
        assets={mapAssets}
        incidents={mapIncidents}
        location={location}
        mapConfig={mapConfig}
        height={470}
        focusDataOnly={outsideCoverage}
        onSelectAsset={(code) => navigate({ name: 'asset', params: { code } })}
        onSelectIncident={(reference) => navigate({ name: 'incident', params: { reference } })}
      />

      <View style={styles.hintRow}>
        <Ionicons name="information-circle-outline" size={14} color={colors.textDim} />
        <Text style={styles.hint}>
          Chạm vào ghim để xem tài sản. Bản đồ dùng tile VIETMAP qua API production.
        </Text>
      </View>

      <SectionHeader title="Gần vị trí của bạn" icon="navigate" />
      {filteredNearby.slice(0, 5).map((entry) => {
        const status = assetStatusMeta(entry.asset.status);
        return (
          <Pressable
            key={`${entry.asset.asset_code}-${entry.distance}`}
            onPress={() => navigate({ name: 'asset', params: { code: entry.asset.asset_code } })}
            style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}
          >
            <View style={[styles.statusBar, { backgroundColor: status.color }]} />
            <View style={{ flex: 1 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{entry.asset.name}</Text>
              <Text style={styles.rowSub} numberOfLines={1}>
                {entry.asset.asset_code} · {entry.asset.location?.address || 'Chưa có địa chỉ'}
              </Text>
            </View>
            <View style={{ alignItems: 'flex-end', gap: 3 }}>
              <Text style={styles.distance}>{formatDistance(entry.distance)}</Text>
              <Text style={[styles.status, { color: status.color }]}>{status.label}</Text>
            </View>
          </Pressable>
        );
      })}
      {filteredNearby.length === 0 ? (
        <Card>
          <Text style={styles.empty}>Không có tài sản khớp bộ lọc trong 5 km.</Text>
        </Card>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  hintRow: { flexDirection: 'row', gap: 5, alignItems: 'flex-start', paddingHorizontal: 2 },
  hint: { color: colors.textDim, fontSize: 9, flex: 1, lineHeight: 13 },
  coverageText: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 11,
  },
  statusBar: { width: 3, height: 34, borderRadius: 2 },
  rowTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  rowSub: { color: colors.textDim, fontSize: 9, marginTop: 2 },
  distance: { color: colors.cyan, fontSize: 10, fontWeight: '800' },
  status: { fontSize: 8, fontWeight: '700' },
  empty: { color: colors.textMuted, fontSize: 11 },
});
