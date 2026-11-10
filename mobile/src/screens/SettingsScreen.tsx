// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import type { AppRoute } from '../lib/deepLink';
import { API_BASE } from '../api/client';
import { colors } from '../lib/format';
import type { AppSettings } from '../lib/storage';
import type { AppLocation } from '../hooks/useLocation';
import { Card, Chip, Divider, PrimaryButton, Screen, SectionHeader, StatusDot } from '../components/ui';
import { PageHeader } from '../components/PageHeader';

interface SettingsScreenProps {
  settings: AppSettings;
  onChange: (settings: AppSettings) => void;
  location: AppLocation;
  locationState: string;
  locationMessage?: string | null;
  onRefreshLocation: () => void;
  online: boolean;
  productVersion?: string;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}

export function SettingsScreen({
  settings,
  onChange,
  location,
  locationState,
  locationMessage,
  onRefreshLocation,
  online,
  productVersion,
  navigate,
  onBack,
}: SettingsScreenProps) {
  const appVersion = Constants.expoConfig?.version ?? '0.1.0';

  return (
    <Screen>
      <PageHeader
        eyebrow="CÀI ĐẶT"
        title="Ứng dụng"
        subtitle={`SynapseCity Android ${appVersion}`}
        onBack={onBack}
      />

      <SectionHeader title="Thông báo" icon="notifications" />
      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Thông báo sự cố</Text>
            <Text style={styles.rowBody}>Thông báo khi có sự cố mới gần vị trí hoặc mức độ cao.</Text>
          </View>
          <Switch
            value={settings.notificationsEnabled}
            onValueChange={(value) => onChange({ ...settings, notificationsEnabled: value })}
            trackColor={{ false: '#D9E8EA', true: '#99F6E4' }}
            thumbColor={settings.notificationsEnabled ? colors.cyan : '#94A3B8'}
          />
        </View>
        <Divider />
        <Text style={styles.rowTitle}>Ngưỡng thông báo</Text>
        <View style={styles.chips}>
          {[
            { value: 'all', label: 'Tất cả' },
            { value: 'high', label: 'Cao trở lên' },
            { value: 'critical', label: 'Nghiêm trọng' },
          ].map((item) => (
            <Chip
              key={item.value}
              label={item.label}
              active={settings.severityThreshold === item.value}
              onPress={() =>
                onChange({
                  ...settings,
                  severityThreshold: item.value as AppSettings['severityThreshold'],
                })
              }
            />
          ))}
        </View>
      </Card>

      <SectionHeader title="Vị trí" icon="location" />
      <Card>
        <View style={styles.row}>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowTitle}>Vị trí hiện tại</Text>
            <Text style={styles.rowBody}>
              {location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}
              {location.accuracy ? ` · ±${Math.round(location.accuracy)} m` : ''}
            </Text>
          </View>
          <StatusDot
            online={locationState === 'ready'}
            label={locationState === 'ready' ? 'GPS' : locationState === 'denied' ? 'BỊ TỪ CHỐI' : 'MẶC ĐỊNH'}
          />
        </View>
        {locationMessage ? <Text style={styles.warn}>{locationMessage}</Text> : null}
        <PrimaryButton label="Làm mới vị trí" icon="locate" tone="ghost" onPress={onRefreshLocation} />
      </Card>

      <SectionHeader title="Widget" icon="apps" />
      <Pressable onPress={() => navigate({ name: 'widget-help' })} style={styles.menu}>
        <View style={styles.menuIcon}>
          <Ionicons name="grid" size={18} color={colors.cyan} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.menuLabel}>Cách thêm widget</Text>
          <Text style={styles.menuSub}>Widget hiển thị tài sản gần nhất và radar mini.</Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
      </Pressable>

      <SectionHeader title="Kết nối production" icon="server" />
      <Card>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>API</Text>
          <Text style={styles.endpoint} numberOfLines={1}>{API_BASE}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Sản phẩm</Text>
          <Text style={styles.rowValue}>{productVersion ? `v${productVersion}` : 'Chưa rõ'}</Text>
        </View>
        <View style={styles.row}>
          <Text style={styles.rowLabel}>Kết nối</Text>
          <StatusDot online={online} label={online ? 'ĐANG KẾT NỐI' : 'KHÔNG KẾT NỐI'} />
        </View>
        <Divider />
        <Text style={styles.small}>
          Dữ liệu lấy trực tiếp từ https://synapsecity.sbs/v1. Ứng dụng không dùng máy chủ trung
          gian và không gọi API của SynapseSOS.
        </Text>
      </Card>

      <SectionHeader title="Liên kết" icon="link" />
      <LinkRow icon="globe-outline" label="Console SynapseCity" url="https://synapsecity.sbs" />
      <LinkRow icon="book-outline" label="Tài liệu API" url="https://synapsecity.sbs/docs" />
      <LinkRow icon="shield-outline" label="SynapseSOS (sản phẩm khẩn cấp)" url="https://sos.synapsecity.sbs" />
      <Text style={styles.legal}>
        Apache-2.0 · VKU.VIC 2026. Đây là ứng dụng vận hành hạ tầng đô thị, không phải dịch vụ
        khẩn cấp. Trong trường hợp khẩn cấp, hãy gọi 112/113/114/115.
      </Text>
    </Screen>
  );
}

function LinkRow({
  icon,
  label,
  url,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  url: string;
}) {
  return (
    <Pressable onPress={() => Linking.openURL(url)} style={({ pressed }) => [styles.menu, pressed && { opacity: 0.8 }]}>
      <View style={styles.menuIcon}>
        <Ionicons name={icon} size={18} color={colors.cyan} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
      <Ionicons name="open-outline" size={15} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 2 },
  rowTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  rowBody: { color: colors.textMuted, fontSize: 10, lineHeight: 15, marginTop: 2 },
  rowLabel: { color: colors.textDim, fontSize: 10, fontWeight: '700', width: 64 },
  rowValue: { color: colors.text, fontSize: 11, fontWeight: '700', flex: 1 },
  endpoint: { color: colors.cyan, fontSize: 10, flex: 1, textAlign: 'right' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 4 },
  warn: { color: colors.amber, fontSize: 10, lineHeight: 15 },
  menu: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: colors.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 12,
  },
  menuIcon: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  menuLabel: { color: colors.text, fontSize: 12, fontWeight: '700', flex: 1 },
  menuSub: { color: colors.textMuted, fontSize: 9, marginTop: 2 },
  small: { color: colors.textDim, fontSize: 9, lineHeight: 14 },
  legal: { color: colors.textDim, fontSize: 9, lineHeight: 14, textAlign: 'center', paddingVertical: 8 },
});
