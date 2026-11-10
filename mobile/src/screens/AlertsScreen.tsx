// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { cityApi } from '../api/city';
import type { CityAlert, CityNotification, PublicIncident, Severity } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import {
  categoryLabel,
  colors,
  incidentStatusLabel,
  normalizeSeverity,
  severityMeta,
  timeAgo,
} from '../lib/format';
import { useAuth } from '../store/auth';
import {
  Card,
  Chip,
  EmptyState,
  ErrorNotice,
  PrimaryButton,
  Screen,
  SectionHeader,
  TextField,
} from '../components/ui';
import { PageHeader } from '../components/PageHeader';

interface AlertsScreenProps {
  incidents: PublicIncident[];
  incidentsError?: string | null;
  onRetry: () => void;
  navigate: (route: AppRoute) => void;
  onAccount: () => void;
}

type Tab = 'public' | 'operator';
type Filter = 'all' | Severity;

export function AlertsScreen({
  incidents,
  incidentsError,
  onRetry,
  navigate,
  onAccount,
}: AlertsScreenProps) {
  const { token, user } = useAuth();
  const [tab, setTab] = useState<Tab>('public');
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [lookup, setLookup] = useState('');

  const alertsQuery = useQuery({
    queryKey: ['city', 'alerts', token],
    queryFn: () => cityApi.listAlerts(token as string),
    enabled: Boolean(token),
    staleTime: 30_000,
    retry: 1,
  });

  const notificationsQuery = useQuery({
    queryKey: ['city', 'notifications', token],
    queryFn: () => cityApi.listNotifications(token as string),
    enabled: Boolean(token),
    staleTime: 30_000,
    retry: 1,
  });

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return incidents
      .filter((incident) => (filter === 'all' ? true : incident.severity === filter))
      .filter((incident) =>
        needle
          ? `${incident.title} ${incident.description} ${incident.incident_number || ''}`
              .toLowerCase()
              .includes(needle)
          : true,
      )
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  }, [incidents, filter, search]);

  const unread = (notificationsQuery.data ?? []).filter((item) => !item.read).length;

  return (
    <Screen>
      <PageHeader
        eyebrow="SỰ CỐ & CẢNH BÁO"
        title="Trung tâm sự cố"
        subtitle={`${incidents.length} báo cáo công khai${token ? ` · ${unread} thông báo chưa đọc` : ''}`}
        right={
          <Pressable onPress={onAccount} style={styles.accountBtn} accessibilityLabel="Tài khoản">
            <Ionicons name="person" size={18} color={token ? colors.cyan : colors.textMuted} />
          </Pressable>
        }
      />

      <View style={styles.tabs}>
        <Pressable onPress={() => setTab('public')} style={[styles.tab, tab === 'public' && styles.tabActive]}>
          <Text style={[styles.tabText, tab === 'public' && styles.tabTextActive]}>Công khai</Text>
        </Pressable>
        <Pressable onPress={() => setTab('operator')} style={[styles.tab, tab === 'operator' && styles.tabActive]}>
          <Text style={[styles.tabText, tab === 'operator' && styles.tabTextActive]}>
            Vận hành {token ? `(${unread})` : ''}
          </Text>
        </Pressable>
      </View>

      {tab === 'public' ? (
        <>
          <TextField
            label="Tìm sự cố"
            value={search}
            onChangeText={setSearch}
            placeholder="Tìm theo tiêu đề, mô tả hoặc mã sự cố"
            autoCorrect={false}
          />
          <View style={styles.chips}>
            <Chip label="Tất cả" active={filter === 'all'} onPress={() => setFilter('all')} />
            {(Object.keys(severityMeta) as Severity[]).map((severity) => (
              <Chip
                key={severity}
                label={severityMeta[severity].label}
                color={severityMeta[severity].color}
                bg={severityMeta[severity].bg}
                active={filter === severity}
                onPress={() => setFilter(severity)}
              />
            ))}
          </View>

          {incidentsError ? <ErrorNotice message={incidentsError} onRetry={onRetry} /> : null}
          {filtered.map((incident) => (
            <IncidentCard
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
          {filtered.length === 0 && !incidentsError ? (
            <EmptyState
              icon="shield-checkmark-outline"
              title="Không có báo cáo phù hợp"
              body="Thử đổi bộ lọc hoặc từ khóa. Bạn cũng có thể gửi báo cáo mới."
              action={<PrimaryButton label="Báo sự cố" icon="megaphone" onPress={() => navigate({ name: 'report' })} />}
            />
          ) : null}
        </>
      ) : token ? (
        <>
          <SectionHeader title="Cảnh báo hạ tầng" icon="warning" />
          {alertsQuery.isLoading ? <Text style={styles.loading}>Đang tải cảnh báo…</Text> : null}
          {alertsQuery.error ? (
            <ErrorNotice message="Không tải được cảnh báo vận hành." onRetry={() => alertsQuery.refetch()} />
          ) : null}
          {(alertsQuery.data ?? []).map((alert) => (
            <AlertCard key={alert.id} alert={alert} />
          ))}
          {(alertsQuery.data ?? []).length === 0 && !alertsQuery.isLoading ? (
            <Card>
              <Text style={styles.muted}>Không có cảnh báo đang hoạt động cho tài khoản này.</Text>
            </Card>
          ) : null}

          <SectionHeader title="Thông báo" icon="notifications" />
          {(notificationsQuery.data ?? []).slice(0, 20).map((notification) => (
            <NotificationCard key={notification.id} notification={notification} />
          ))}
          {(notificationsQuery.data ?? []).length === 0 && !notificationsQuery.isLoading ? (
            <Card>
              <Text style={styles.muted}>Chưa có thông báo vận hành.</Text>
            </Card>
          ) : null}
        </>
      ) : (
        <>
          <Card tone="cyan" style={styles.loginCard}>
            <View style={styles.loginIcon}>
              <Ionicons name="lock-closed" size={24} color={colors.cyan} />
            </View>
            <Text style={styles.loginTitle}>Đăng nhập để xem cảnh báo vận hành</Text>
            <Text style={styles.loginBody}>
              Tài khoản SynapseCity cho phép xem cảnh báo hạ tầng, thông báo và trạng thái vận hành.
              Báo cáo công khai vẫn dùng được mà không cần đăng nhập.
            </Text>
            <PrimaryButton label="Đăng nhập" icon="log-in" onPress={onAccount} />
          </Card>
          <Card>
            <Text style={styles.lookupTitle}>Tra cứu mã sự cố</Text>
            <TextField
              label="Mã sự cố"
              value={lookup}
              onChangeText={setLookup}
              placeholder="VD: INC-2026-00001"
              autoCapitalize="characters"
            />
            <PrimaryButton
              label="Tra cứu"
              icon="search"
              disabled={!lookup.trim()}
              onPress={() => navigate({ name: 'incident', params: { reference: lookup.trim() } })}
            />
          </Card>
        </>
      )}

      {tab === 'public' && !token ? (
        <Card tone="cyan" style={styles.loginCard}>
          <Text style={styles.loginTitle}>Bạn là đội vận hành?</Text>
          <Text style={styles.loginBody}>Đăng nhập để xem cảnh báo hạ tầng và thông báo nội bộ.</Text>
          <PrimaryButton label="Đăng nhập" icon="log-in" onPress={onAccount} />
        </Card>
      ) : null}
    </Screen>
  );
}

function IncidentCard({ incident, onPress }: { incident: PublicIncident; onPress: () => void }) {
  const meta = severityMeta[normalizeSeverity(incident.severity)];
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.card, pressed && { opacity: 0.82 }]}>
      <View style={styles.cardTop}>
        <View style={[styles.iconBox, { backgroundColor: meta.bg }]}>
          <Ionicons name="warning" size={18} color={meta.color} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={styles.cardTitle} numberOfLines={2}>{incident.title}</Text>
          <Text style={styles.cardMeta}>
            {incident.incident_number || incident.id} · {timeAgo(incident.created_at)}
          </Text>
        </View>
        <Chip label={meta.label} color={meta.color} bg={meta.bg} />
      </View>
      <Text style={styles.cardBody} numberOfLines={2}>{incident.description}</Text>
      <View style={styles.cardFooter}>
        <Chip label={categoryLabel(incident.category)} />
        <Chip label={incidentStatusLabel(incident.status)} color={colors.textMuted} />
        <View style={{ flex: 1 }} />
        <Ionicons name="chevron-forward" size={16} color={colors.textDim} />
      </View>
    </Pressable>
  );
}

function AlertCard({ alert }: { alert: CityAlert }) {
  const meta = severityMeta[normalizeSeverity(alert.severity)];
  return (
    <Card style={[styles.operatorCard, { borderLeftColor: meta.color }]}>
      <View style={styles.cardTop}>
        <View style={[styles.iconBox, { backgroundColor: meta.bg }]}>
          <Ionicons name="pulse" size={18} color={meta.color} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{alert.message}</Text>
          <Text style={styles.cardMeta}>
            {alert.alert_type} · {timeAgo(alert.created_at)} · {alert.status}
          </Text>
        </View>
        <Chip label={meta.label} color={meta.color} bg={meta.bg} />
      </View>
    </Card>
  );
}

function NotificationCard({ notification }: { notification: CityNotification }) {
  return (
    <Card style={!notification.read ? styles.unread : undefined}>
      <View style={styles.cardTop}>
        <View style={[styles.iconBox, { backgroundColor: '#CCFBF1' }]}>
          <Ionicons name="notifications" size={17} color={colors.cyan} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.cardTitle}>{notification.title}</Text>
          <Text style={styles.cardBody}>{notification.message}</Text>
          <Text style={styles.cardMeta}>{timeAgo(notification.created_at)}</Text>
        </View>
        {!notification.read ? <View style={styles.unreadDot} /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  accountBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabs: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 10, borderRadius: 10 },
  tabActive: { backgroundColor: '#CCFBF1' },
  tabText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  tabTextActive: { color: colors.cyan },
  chips: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 13,
    gap: 8,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardTitle: { color: colors.text, fontSize: 13, fontWeight: '700', lineHeight: 18 },
  cardMeta: { color: colors.textDim, fontSize: 9 },
  cardBody: { color: colors.textMuted, fontSize: 10, lineHeight: 16 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  muted: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  loading: { color: colors.textMuted, fontSize: 11 },
  operatorCard: { borderLeftWidth: 3 },
  unread: { borderColor: '#99F6E4' },
  unreadDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.cyan },
  loginCard: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  loginIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  loginTitle: { color: colors.text, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  loginBody: { color: colors.textMuted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  lookupTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
});
