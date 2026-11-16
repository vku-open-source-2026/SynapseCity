// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppRoute } from '../lib/deepLink';
import { colors } from '../lib/format';
import { useAuth } from '../store/auth';
import {
  Card,
  PrimaryButton,
  Screen,
  SectionHeader,
} from '../components/ui';
import { PageHeader } from '../components/PageHeader';

const WORKSPACE_URL = 'https://synapsedx.sbs/workspace';

interface AccountScreenProps {
  navigate: (route: AppRoute) => void;
  onBack: () => void;
  onLoggedIn: () => void;
}

/**
 * Operator work interfaces moved to the SynapseDX workspace. The mobile app
 * stays a public, anonymous view of the City map, incidents and reports.
 */
export function AccountScreen({ navigate, onBack }: AccountScreenProps) {
  const { user, token, logout } = useAuth();

  return (
    <Screen>
      <PageHeader
        eyebrow="TÀI KHOẢN"
        title={token && user ? user.full_name || user.username : 'Chế độ công khai'}
        subtitle="Đăng nhập và phiên làm việc vận hành thuộc SynapseDX."
        onBack={onBack}
      />

      <Card tone="cyan">
        <View style={styles.noticeRow}>
          <Ionicons name="open-outline" size={22} color={colors.cyan} />
          <View style={{ flex: 1 }}>
            <Text style={styles.noticeTitle}>Workspace vận hành đã chuyển</Text>
            <Text style={styles.noticeBody}>
              Dùng SynapseDX để đăng nhập, xem cảnh báo nội bộ, work order và quản trị
              City operator. Ứng dụng này không còn lưu mật khẩu hay token vận hành.
            </Text>
          </View>
        </View>
        <PrimaryButton
          label="Mở SynapseDX Workspace"
          icon="open-outline"
          onPress={() => Linking.openURL(WORKSPACE_URL).catch(() => undefined)}
        />
      </Card>

      <SectionHeader title="Công cụ" icon="construct" />
      <Card>
        <Text style={styles.link} onPress={() => navigate({ name: 'settings' })}>
          Cài đặt ứng dụng
        </Text>
        <Text style={styles.link} onPress={() => navigate({ name: 'widget-help' })}>
          Widget màn hình chính
        </Text>
      </Card>

      {token ? (
        <PrimaryButton
          label="Xoá phiên cũ"
          icon="log-out"
          tone="danger"
          onPress={() => logout().catch(() => undefined)}
        />
      ) : null}
      <Text style={styles.note}>
        Báo cáo sự cố và bản đồ công khai vẫn dùng được mà không cần đăng nhập.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  noticeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 4 },
  noticeTitle: { color: colors.text, fontSize: 14, fontWeight: '800' },
  noticeBody: { color: colors.textMuted, fontSize: 11, lineHeight: 17, marginTop: 4 },
  link: { color: colors.cyan, fontSize: 12, fontWeight: '700', paddingVertical: 8 },
  note: { color: colors.textDim, fontSize: 9, textAlign: 'center', lineHeight: 14 },
});
