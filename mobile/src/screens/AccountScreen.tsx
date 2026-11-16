// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { errorMessage } from '../api/client';
import type { AppRoute } from '../lib/deepLink';
import { colors } from '../lib/format';
import { useAuth } from '../store/auth';
import {
  Card,
  Chip,
  Divider,
  ErrorNotice,
  PrimaryButton,
  Screen,
  SectionHeader,
  TextField,
} from '../components/ui';
import { PageHeader } from '../components/PageHeader';

interface AccountScreenProps {
  navigate: (route: AppRoute) => void;
  onBack: () => void;
  onLoggedIn: () => void;
}

export function AccountScreen({ navigate, onBack, onLoggedIn }: AccountScreenProps) {
  const { user, token, login, register, logout } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'login') {
        await login(username, password);
      } else {
        await register({
          username: username || email,
          email,
          password,
          full_name: fullName,
        });
      }
      onLoggedIn();
    } catch (authError) {
      setError(errorMessage(authError));
    } finally {
      setBusy(false);
    }
  };

  if (token && user) {
    return (
      <Screen>
        <PageHeader
          eyebrow="TÀI KHOẢN"
          title={user.full_name || user.username}
          subtitle={user.email}
          onBack={onBack}
          right={
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {(user.full_name || user.username || '?').slice(0, 1).toUpperCase()}
              </Text>
            </View>
          }
        />
        <Card tone="cyan">
          <View style={styles.profileRow}>
            <Ionicons name="shield-checkmark" size={22} color={colors.cyan} />
            <View style={{ flex: 1 }}>
              <Text style={styles.profileLabel}>Vai trò</Text>
              <Text style={styles.profileValue}>{user.role}</Text>
            </View>
            <Chip label="Đã đăng nhập" color={colors.green} bg="rgba(52,211,153,0.14)" />
          </View>
          <Divider />
          <View style={styles.profileRow}>
            <Ionicons name="key" size={20} color={colors.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={styles.profileLabel}>Quyền</Text>
              <Text style={styles.profileValue}>
                {(user.permissions ?? []).length ? (user.permissions ?? []).slice(0, 6).join(', ') : 'Không có quyền quản trị'}
              </Text>
            </View>
          </View>
          {user.department ? (
            <View style={styles.profileRow}>
              <Ionicons name="business" size={20} color={colors.textMuted} />
              <View style={{ flex: 1 }}>
                <Text style={styles.profileLabel}>Bộ phận</Text>
                <Text style={styles.profileValue}>{user.department}</Text>
              </View>
            </View>
          ) : null}
        </Card>

        <SectionHeader title="Công cụ" icon="construct" />
        <MenuRow icon="notifications-outline" label="Cài đặt thông báo" onPress={() => navigate({ name: 'settings' })} />
        <MenuRow icon="apps-outline" label="Widget màn hình chính" onPress={() => navigate({ name: 'widget-help' })} />
        <MenuRow icon="document-text-outline" label="Tài liệu API" onPress={() => navigate({ name: 'settings' })} />

        <PrimaryButton label="Đăng xuất" icon="log-out" tone="danger" onPress={() => logout().catch(() => undefined)} />
        <Text style={styles.note}>
          Token được lưu trong SecureStore của Android và không hiển thị trong giao diện.
        </Text>
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        eyebrow="TÀI KHOẢN"
        title={mode === 'login' ? 'Đăng nhập vận hành' : 'Tạo tài khoản'}
        subtitle="Dùng tài khoản SynapseCity (Tier-2 identity). Không bắt buộc để xem dữ liệu công khai."
        onBack={onBack}
      />
      <Card>
        <TextField
          label={mode === 'login' ? 'Tên đăng nhập hoặc email' : 'Tên đăng nhập'}
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="operator@example.com"
        />
        {mode === 'register' ? (
          <>
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              keyboardType="email-address"
              placeholder="operator@example.com"
            />
            <TextField
              label="Họ và tên"
              value={fullName}
              onChangeText={setFullName}
              placeholder="Nguyễn Văn A"
            />
          </>
        ) : null}
        <TextField
          label="Mật khẩu"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          placeholder="••••••••"
        />
        {error ? <ErrorNotice message={error} /> : null}
        <PrimaryButton
          label={mode === 'login' ? 'Đăng nhập' : 'Tạo tài khoản'}
          icon={mode === 'login' ? 'log-in' : 'person-add'}
          loading={busy}
          onPress={() => submit().catch(() => undefined)}
        />
        <Pressable onPress={() => setMode(mode === 'login' ? 'register' : 'login')} style={styles.switch}>
          <Text style={styles.switchText}>
            {mode === 'login' ? 'Chưa có tài khoản? Đăng ký' : 'Đã có tài khoản? Đăng nhập'}
          </Text>
        </Pressable>
      </Card>

      <Card>
        <Text style={styles.infoTitle}>Phân quyền được kiểm tra phía máy chủ</Text>
        <Text style={styles.infoBody}>
          Vai trò và quyền không lấy từ dữ liệu nhập vào. Tài khoản mới có thể chỉ có quyền công dân
          hoặc responder cho tới khi quản trị viên cấp quyền vận hành.
        </Text>
      </Card>
      <MenuRow icon="settings-outline" label="Cài đặt ứng dụng" onPress={() => navigate({ name: 'settings' })} />
    </Screen>
  );
}

function MenuRow({
  icon,
  label,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.menu, pressed && { opacity: 0.8 }]}>
      <View style={styles.menuIcon}>
        <Ionicons name={icon} size={18} color={colors.cyan} />
      </View>
      <Text style={styles.menuLabel}>{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#CCFBF1',
    borderWidth: 1,
    borderColor: '#99F6E4',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.cyan, fontSize: 20, fontWeight: '800' },
  profileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4 },
  profileLabel: { color: colors.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  profileValue: { color: colors.text, fontSize: 12, marginTop: 2, lineHeight: 17 },
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
  switch: { alignItems: 'center', paddingVertical: 6 },
  switchText: { color: colors.cyan, fontSize: 11, fontWeight: '700' },
  note: { color: colors.textDim, fontSize: 9, textAlign: 'center', lineHeight: 14 },
  infoTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  infoBody: { color: colors.textMuted, fontSize: 10, lineHeight: 16 },
});
