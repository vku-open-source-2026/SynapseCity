// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { PublicAsset } from '../api/types';
import type { AppLocation } from '../hooks/useLocation';
import type { NearbyAsset } from '../hooks/useCityData';
import { assetStatusMeta, colors } from '../lib/format';
import { formatDistance } from '../lib/geo';
import { requestWidgetRefresh } from '../lib/widget';
import { Card, Chip, PrimaryButton, Screen, SectionHeader } from '../components/ui';
import { PageHeader } from '../components/PageHeader';
import { RadarMap } from '../components/RadarMap';

export function WidgetHelpScreen({
  location,
  assets,
  nearby,
  onBack,
}: {
  location: AppLocation;
  assets: PublicAsset[];
  nearby: NearbyAsset[];
  onBack: () => void;
}) {
  const [refreshed, setRefreshed] = useState(false);
  const nearest = nearby[0];
  const status = nearest ? assetStatusMeta(nearest.asset.status) : null;

  return (
    <Screen>
      <PageHeader
        eyebrow="WIDGET"
        title="Widget trên màn hình chính"
        subtitle="Kiểu Locket: luôn thấy tài sản gần nhất mà không cần mở app."
        onBack={onBack}
      />

      <Card tone="cyan" style={styles.preview}>
        <View style={styles.previewHeader}>
          <View style={styles.brand}>
            <View style={styles.brandMark}>
              <Ionicons name="business" size={13} color="#FFFFFF" />
            </View>
            <Text style={styles.brandText}>SYNAPSE CITY</Text>
          </View>
          <Chip
            label={location.isFallback ? 'VỊ TRÍ MẶC ĐỊNH' : 'GPS'}
            color={location.isFallback ? colors.amber : colors.green}
            bg={location.isFallback ? 'rgba(251,191,36,0.14)' : 'rgba(52,211,153,0.14)'}
          />
        </View>
        <View style={styles.previewBody}>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.previewKicker}>GẦN NHẤT</Text>
            <Text style={styles.previewName} numberOfLines={2}>
              {nearest?.asset.name || 'Chưa có tài sản trong 5 km'}
            </Text>
            <Text style={styles.previewMeta}>
              {nearest ? `${formatDistance(nearest.distance)} · ${status?.label}` : 'Mở app để làm mới vị trí'}
            </Text>
            <View style={styles.previewActions}>
              <View style={styles.previewPill}>
                <Ionicons name="scan" size={11} color={colors.cyan} />
                <Text style={styles.previewPillText}>Quét</Text>
              </View>
              <View style={styles.previewPill}>
                <Ionicons name="refresh" size={11} color={colors.cyan} />
                <Text style={styles.previewPillText}>Làm mới</Text>
              </View>
            </View>
          </View>
          <RadarMap location={location} assets={assets} size={104} radiusMeters={5_000} showLabels={false} />
        </View>
        <Text style={styles.previewFoot}>Cập nhật 30 phút · dữ liệu công khai từ synapsecity.sbs</Text>
      </Card>

      <SectionHeader title="Cách thêm widget" icon="add-circle" />
      <Step
        number="1"
        title="Về màn hình chính"
        body="Nhấn giữ một khoảng trống trên màn hình chính Android."
      />
      <Step number="2" title="Chọn Widgets" body="Mở danh sách widget của thiết bị." />
      <Step number="3" title="Tìm SynapseCity" body="Kéo widget SynapseCity ra màn hình chính." />
      <Step
        number="4"
        title="Cấp quyền vị trí"
        body="Mở app một lần để lưu vị trí; widget dùng vị trí gần nhất đã lưu."
      />

      <Card>
        <View style={styles.tipRow}>
          <Ionicons name="refresh-circle" size={22} color={colors.cyan} />
          <View style={{ flex: 1 }}>
            <Text style={styles.tipTitle}>Làm mới widget ngay</Text>
            <Text style={styles.tipBody}>
              Widget tự cập nhật mỗi 30 phút. Nút làm mới sẽ gọi API production ngay lập tức.
            </Text>
          </View>
        </View>
        <PrimaryButton
          label={refreshed ? 'Đã gửi yêu cầu làm mới' : 'Làm mới widget'}
          icon="refresh"
          tone="ghost"
          onPress={() => {
            requestWidgetRefresh();
            setRefreshed(true);
          }}
        />
      </Card>

      <Card>
        <View style={styles.tipRow}>
          <Ionicons name="warning" size={20} color={colors.amber} />
          <View style={{ flex: 1 }}>
            <Text style={styles.tipTitle}>Dữ liệu cũ được ghi rõ</Text>
            <Text style={styles.tipBody}>
              Nếu widget không lấy được dữ liệu, nó hiển thị “Dữ liệu cũ” kèm thời điểm, không giả
              vờ là dữ liệu mới.
            </Text>
          </View>
        </View>
      </Card>

      <Pressable onPress={onBack} style={styles.backLink}>
        <Text style={styles.backText}>Quay lại tổng quan</Text>
      </Pressable>
    </Screen>
  );
}

function Step({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNumber}>
        <Text style={styles.stepNumberText}>{number}</Text>
      </View>
      <View style={{ flex: 1 }}>
        <Text style={styles.stepTitle}>{title}</Text>
        <Text style={styles.stepBody}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { gap: 12 },
  previewHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  brandMark: {
    width: 24,
    height: 24,
    borderRadius: 8,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: { color: colors.text, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  previewBody: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  previewKicker: { color: colors.cyan, fontSize: 8, fontWeight: '800', letterSpacing: 1 },
  previewName: { color: colors.text, fontSize: 17, fontWeight: '800', lineHeight: 21 },
  previewMeta: { color: colors.textMuted, fontSize: 10 },
  previewActions: { flexDirection: 'row', gap: 6, marginTop: 6 },
  previewPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#CCFBF1',
    borderRadius: 8,
    paddingHorizontal: 7,
    paddingVertical: 4,
  },
  previewPillText: { color: colors.cyan, fontSize: 8, fontWeight: '800' },
  previewFoot: { color: colors.textDim, fontSize: 8 },
  step: { flexDirection: 'row', gap: 12, alignItems: 'flex-start' },
  stepNumber: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepNumberText: { color: colors.cyan, fontSize: 12, fontWeight: '800' },
  stepTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  stepBody: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  tipRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
  tipTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  tipBody: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  backLink: { alignItems: 'center', paddingVertical: 8 },
  backText: { color: colors.cyan, fontSize: 11, fontWeight: '700' },
});
