// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppRoute } from '../lib/deepLink';
import { errorMessage } from '../api/client';
import { assetStatusMeta, categoryLabel, colors } from '../lib/format';
import { usePublicAsset, useMaintenanceSummary } from '../hooks/useCityData';
import { assetCoordinates, distanceMeters, formatDistance } from '../lib/geo';
import type { AppLocation } from '../hooks/useLocation';
import {
  Card,
  Chip,
  Divider,
  ErrorNotice,
  PrimaryButton,
  Screen,
  SectionHeader,
} from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { QrCodeView } from '../components/QrCodeView';

interface AssetDetailScreenProps {
  code: string;
  location: AppLocation;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}

export function AssetDetailScreen({ code, location, navigate, onBack }: AssetDetailScreenProps) {
  const assetQuery = usePublicAsset(code);
  const maintenanceQuery = useMaintenanceSummary(code);
  const asset = assetQuery.data;
  const coords = asset ? assetCoordinates(asset) : null;
  const distance = coords
    ? distanceMeters({ latitude: location.latitude, longitude: location.longitude }, coords)
    : null;
  const status = assetStatusMeta(asset?.status ?? '');

  if (assetQuery.isLoading) {
    return (
      <Screen>
        <PageHeader title="Đang tải tài sản" onBack={onBack} />
        <Card><Text style={styles.muted}>Đang truy vấn production…</Text></Card>
      </Screen>
    );
  }

  if (assetQuery.error || !asset) {
    return (
      <Screen>
        <PageHeader title="Không tìm thấy tài sản" onBack={onBack} />
        <ErrorNotice message={errorMessage(assetQuery.error)} onRetry={() => assetQuery.refetch()} />
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        eyebrow={asset.asset_code}
        title={asset.name}
        subtitle={asset.location?.address || 'Chưa có địa chỉ công khai'}
        onBack={onBack}
        right={<Chip label={status.label} color={status.color} bg={status.bg} />}
      />

      <Card tone="cyan" style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={styles.heroIcon}>
            <Ionicons name="cube" size={30} color={colors.cyan} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.heroType}>{categoryLabel(asset.feature_type || asset.category)}</Text>
            <Text style={styles.heroCode}>{asset.asset_code}</Text>
          </View>
          {distance !== null ? (
            <View style={styles.distanceBox}>
              <Text style={styles.distanceBig}>{formatDistance(distance)}</Text>
              <Text style={styles.distanceSmall}>từ bạn</Text>
            </View>
          ) : null}
        </View>
        <Divider />
        <View style={styles.infoGrid}>
          <Info label="Trạng thái" value={status.label} color={status.color} />
          <Info label="Loại" value={categoryLabel(asset.feature_type || asset.category)} />
          <Info label="Khu vực" value={asset.location?.district || asset.location?.ward || '—'} />
          <Info label="Toạ độ" value={coords ? `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}` : '—'} />
        </View>
      </Card>

      <SectionHeader title="Mã QR tài sản" icon="qr-code" />
      <Card style={styles.qrCard}>
        {asset.public_url || asset.qr_code ? (
          <QrCodeView value={asset.public_url || asset.qr_code || ''} size={200} />
        ) : (
          <View style={styles.qrPlaceholder}>
            <Ionicons name="qr-code-outline" size={60} color={colors.textDim} />
          </View>
        )}
        <Text style={styles.qrHint}>
          Mã này mở hồ sơ công khai trên web. Có thể dùng để dán lên thiết bị.
        </Text>
      </Card>

      <SectionHeader title="Bảo trì" icon="construct" />
      <Card>
        {maintenanceQuery.isLoading ? (
          <Text style={styles.muted}>Đang tải lịch sử bảo trì…</Text>
        ) : maintenanceQuery.data ? (
          <>
            <View style={styles.maintenanceRow}>
              <Text style={styles.maintenanceNumber}>{maintenanceQuery.data.work_order_count}</Text>
              <Text style={styles.maintenanceLabel}>lệnh công việc</Text>
            </View>
            <Text style={styles.muted}>
              Đã hoàn thành {maintenanceQuery.data.completed_count} · Lần cuối{' '}
              {maintenanceQuery.data.last_completed_at
                ? new Date(maintenanceQuery.data.last_completed_at).toLocaleDateString('vi-VN')
                : 'chưa có'}
            </Text>
          </>
        ) : (
          <Text style={styles.muted}>Chưa có dữ liệu bảo trì công khai cho tài sản này.</Text>
        )}
      </Card>

      <PrimaryButton
        label="Báo sự cố cho tài sản này"
        icon="megaphone"
        onPress={() => navigate({ name: 'report', params: { assetCode: asset.asset_code } })}
      />
      <View style={styles.buttonRow}>
        <View style={{ flex: 1 }}>
          <PrimaryButton
            label="Chỉ đường"
            icon="navigate"
            tone="ghost"
            disabled={!coords}
            onPress={() => {
              if (!coords) return;
              Linking.openURL(
                `https://www.google.com/maps/dir/?api=1&destination=${coords.latitude},${coords.longitude}`,
              );
            }}
          />
        </View>
        <View style={{ flex: 1 }}>
          <PrimaryButton
            label="Mở web"
            icon="open-outline"
            tone="ghost"
            onPress={() =>
              Linking.openURL(
                asset.public_url || asset.qr_code || `https://synapsecity.sbs/asset/${asset.asset_code}`,
              )
            }
          />
        </View>
      </View>
      {asset.nfc_tag_id ? (
        <Card>
          <Text style={styles.muted}>NFC tag: {asset.nfc_tag_id}</Text>
        </Card>
      ) : null}
    </Screen>
  );
}

function Info({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View style={styles.infoItem}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={[styles.infoValue, color ? { color } : null]} numberOfLines={2}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 12 },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  heroIcon: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroType: { color: colors.text, fontSize: 12, fontWeight: '700' },
  heroCode: { color: colors.cyan, fontSize: 11, fontWeight: '800', marginTop: 3, letterSpacing: 0.6 },
  distanceBox: { alignItems: 'flex-end' },
  distanceBig: { color: colors.cyan, fontSize: 18, fontWeight: '800' },
  distanceSmall: { color: colors.textDim, fontSize: 9 },
  infoGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  infoItem: { width: '45%', gap: 3 },
  infoLabel: { color: colors.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  infoValue: { color: colors.text, fontSize: 11, fontWeight: '600', lineHeight: 15 },
  qrCard: { alignItems: 'center', gap: 10 },
  qr: { width: 200, height: 200, borderRadius: 12 },
  qrPlaceholder: {
    width: 200,
    height: 200,
    borderRadius: 12,
    backgroundColor: '#F1F5F9',
    alignItems: 'center',
    justifyContent: 'center',
  },
  qrHint: { color: colors.textMuted, fontSize: 10, textAlign: 'center', lineHeight: 15 },
  maintenanceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
  maintenanceNumber: { color: colors.text, fontSize: 32, fontWeight: '800' },
  maintenanceLabel: { color: colors.textMuted, fontSize: 11 },
  muted: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  buttonRow: { flexDirection: 'row', gap: 10 },
});
