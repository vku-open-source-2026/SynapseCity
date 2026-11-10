// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import type { PublicAsset, PublicIncident } from '../api/types';
import type { AppRoute, AppRouteName } from '../lib/deepLink';
import { assetStatusMeta, colors, normalizeSeverity, severityMeta, timeAgo } from '../lib/format';
import { formatDistance } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import type { NearbyAsset } from '../hooks/useCityData';
import { Card, Chip, ErrorNotice, Screen, SectionHeader, StatusDot } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { RadarMap } from '../components/RadarMap';

interface HomeScreenProps {
  location: AppLocation;
  locationState: string;
  nearby: NearbyAsset[];
  assets: PublicAsset[];
  incidents: PublicIncident[];
  online: boolean;
  productVersion?: string;
  refreshing: boolean;
  onRefresh: () => void;
  navigate: (route: AppRoute) => void;
  onTab: (route: AppRouteName) => void;
}

export function HomeScreen({
  location,
  locationState,
  nearby,
  assets,
  incidents,
  online,
  productVersion,
  refreshing,
  onRefresh,
  navigate,
  onTab,
}: HomeScreenProps) {
  const nearest = nearby[0];
  const nearestStatus = nearest ? assetStatusMeta(nearest.asset.status) : null;
  const recentIncidents = [...incidents]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, 3);

  return (
    <Screen
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.cyan} />
      }
    >
      <PageHeader
        eyebrow="SYNAPSE CITY"
        title="Hạ tầng quanh bạn"
        subtitle={
          location.isFallback
            ? 'Chưa có vị trí GPS · dùng trung tâm Đà Nẵng'
            : `${location.latitude.toFixed(4)}, ${location.longitude.toFixed(4)}`
        }
        right={<StatusDot online={online} label={online ? 'TRỰC TUYẾN' : 'MẤT KẾT NỐI'} />}
      />

      <LinearGradient
        colors={['#E6FFFB', '#E0F2FE', '#FFFFFF']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.heroText}>
          <Text style={styles.heroKicker}>RADAR 5 KM</Text>
          <Text style={styles.heroCount}>{nearby.length}</Text>
          <Text style={styles.heroLabel}>tài sản hạ tầng trong vùng</Text>
          {nearest ? (
            <Pressable
              style={styles.nearest}
              onPress={() => navigate({ name: 'asset', params: { code: nearest.asset.asset_code } })}
            >
              <View style={[styles.nearestDot, { backgroundColor: nearestStatus?.color }]} />
              <View style={{ flex: 1 }}>
                <Text style={styles.nearestName} numberOfLines={1}>{nearest.asset.name}</Text>
                <Text style={styles.nearestMeta}>
                  {formatDistance(nearest.distance)} · {nearestStatus?.label}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
            </Pressable>
          ) : (
            <Text style={styles.heroEmpty}>Chưa thấy tài sản công khai trong bán kính 5 km.</Text>
          )}
        </View>
        <View style={styles.radarWrap}>
          <RadarMap location={location} assets={assets} size={130} radiusMeters={5_000} showLabels={false} />
        </View>
      </LinearGradient>

      <View style={styles.quickGrid}>
        <QuickAction icon="scan" label="Quét QR / NFC" tone="cyan" onPress={() => onTab('scan')} />
        <QuickAction icon="map" label="Bản đồ" onPress={() => onTab('map')} />
        <QuickAction icon="megaphone" label="Báo sự cố" onPress={() => navigate({ name: 'report' })} />
        <QuickAction icon="notifications" label="Sự cố" onPress={() => onTab('alerts')} />
      </View>

      <SectionHeader
        title="Tài sản gần nhất"
        action="Xem tất cả"
        onAction={() => onTab('map')}
        icon="business"
      />
      {nearby.slice(0, 4).map((entry) => (
        <AssetRow
          key={`${entry.asset.asset_code}-${entry.distance}`}
          asset={entry.asset}
          distance={entry.distance}
          onPress={() => navigate({ name: 'asset', params: { code: entry.asset.asset_code } })}
        />
      ))}
      {nearby.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            Không có tài sản công khai trong 5 km. Thử làm mới vị trí hoặc mở bản đồ.
          </Text>
        </Card>
      ) : null}

      <SectionHeader
        title="Sự cố công khai"
        action="Tất cả"
        onAction={() => onTab('alerts')}
        icon="warning"
      />
      {recentIncidents.map((incident) => (
        <IncidentRow
          key={incident.id}
          incident={incident}
          onPress={() =>
            navigate({
              name: 'incident',
              params: { reference: incident.incident_number || incident.id },
            })
          }
        />
      ))}

      <Pressable onPress={() => navigate({ name: 'widget-help' })}>
        <Card tone="cyan" style={styles.widgetCard}>
          <View style={styles.widgetIcon}>
            <Ionicons name="apps" size={22} color={colors.cyan} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.widgetTitle}>Đưa SynapseCity ra màn hình chính</Text>
            <Text style={styles.widgetBody}>
              Widget hiển thị tài sản gần nhất, trạng thái và radar mini. Chạm để quét QR/NFC.
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textDim} />
        </Card>
      </Pressable>

      {!online ? (
        <ErrorNotice
          message="Không xác nhận được kết nối production. Dữ liệu đang hiển thị có thể là bản cũ."
          onRetry={onRefresh}
        />
      ) : null}

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          SynapseCity {productVersion ? `v${productVersion}` : ''} · API production
        </Text>
        <Pressable
          onPress={() => Linking.openURL('https://sos.synapsecity.sbs')}
          style={styles.sosLink}
        >
          <Text style={styles.sosLinkText}>Mở SynapseSOS</Text>
          <Ionicons name="open-outline" size={12} color={colors.cyan} />
        </Pressable>
      </View>
    </Screen>
  );
}

function QuickAction({
  icon,
  label,
  onPress,
  tone,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  tone?: 'cyan';
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.quick,
        tone === 'cyan' && styles.quickCyan,
        pressed && { opacity: 0.8 },
      ]}
    >
      <View style={[styles.quickIcon, tone === 'cyan' && { backgroundColor: '#CCFBF1' }]}>
        <Ionicons name={icon} size={20} color={tone === 'cyan' ? colors.cyan : colors.text} />
      </View>
      <Text style={styles.quickLabel} numberOfLines={2}>{label}</Text>
    </Pressable>
  );
}

function AssetRow({
  asset,
  distance,
  onPress,
}: {
  asset: PublicAsset;
  distance: number;
  onPress: () => void;
}) {
  const status = assetStatusMeta(asset.status);
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}>
      <View style={styles.rowIcon}>
        <Ionicons name="cube" size={18} color={status.color} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{asset.name}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {asset.asset_code} · {asset.location?.address || asset.location?.district || 'Chưa có địa chỉ'}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.distance}>{formatDistance(distance)}</Text>
        <Chip label={status.label} color={status.color} bg={status.bg} />
      </View>
    </Pressable>
  );
}

function IncidentRow({ incident, onPress }: { incident: PublicIncident; onPress: () => void }) {
  const severity = severityMeta[normalizeSeverity(incident.severity)];
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.8 }]}>
      <View style={[styles.rowIcon, { backgroundColor: severity.bg }]}>
        <Ionicons name="warning" size={18} color={severity.color} />
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{incident.title}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>
          {incident.incident_number || incident.id} · {timeAgo(incident.created_at)}
        </Text>
      </View>
      <Chip label={severity.label} color={severity.color} bg={severity.bg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  hero: {
    borderRadius: 24,
    padding: 18,
    flexDirection: 'row',
    gap: 8,
    borderWidth: 1,
    borderColor: 'rgba(15,159,154,0.18)',
    overflow: 'hidden',
    shadowColor: '#0F172A',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 7 },
    elevation: 3,
  },
  heroText: { flex: 1, gap: 2 },
  heroKicker: { color: colors.cyan, fontSize: 9, fontWeight: '800', letterSpacing: 1.4 },
  heroCount: { color: colors.text, fontSize: 46, fontWeight: '800', lineHeight: 52, letterSpacing: -2 },
  heroLabel: { color: colors.textMuted, fontSize: 11, marginBottom: 10 },
  heroEmpty: { color: colors.textMuted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  radarWrap: { alignItems: 'center', justifyContent: 'center', marginRight: -8 },
  nearest: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderRadius: 12,
    padding: 9,
    borderWidth: 1,
    borderColor: '#D9E8EA',
  },
  nearestDot: { width: 8, height: 8, borderRadius: 4 },
  nearestName: { color: colors.text, fontSize: 11, fontWeight: '700' },
  nearestMeta: { color: colors.textMuted, fontSize: 9, marginTop: 1 },
  quickGrid: { flexDirection: 'row', gap: 8 },
  quick: {
    flex: 1,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: 12,
    paddingHorizontal: 6,
    alignItems: 'center',
    gap: 7,
    minHeight: 86,
  },
  quickCyan: { borderColor: '#99F6E4', backgroundColor: '#F0FDFA' },
  quickIcon: {
    width: 34,
    height: 34,
    borderRadius: 11,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: { color: colors.text, fontSize: 10, fontWeight: '700', textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 11,
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 12,
    backgroundColor: 'rgba(148,163,184,0.10)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 2 },
  rowTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  rowSub: { color: colors.textDim, fontSize: 9 },
  rowRight: { alignItems: 'flex-end', gap: 4 },
  distance: { color: colors.cyan, fontSize: 10, fontWeight: '800' },
  muted: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  widgetCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  widgetIcon: {
    width: 42,
    height: 42,
    borderRadius: 14,
    backgroundColor: '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  widgetTitle: { color: colors.text, fontSize: 12, fontWeight: '800' },
  widgetBody: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  footer: { alignItems: 'center', gap: 6, paddingVertical: 8 },
  footerText: { color: colors.textDim, fontSize: 9 },
  sosLink: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  sosLinkText: { color: colors.cyan, fontSize: 10, fontWeight: '700' },
});
