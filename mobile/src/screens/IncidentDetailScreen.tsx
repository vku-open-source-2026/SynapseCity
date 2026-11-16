// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { errorMessage } from '../api/client';
import type { AppRoute } from '../lib/deepLink';
import {
  categoryLabel,
  colors,
  formatDateTime,
  incidentStatusLabel,
  normalizeSeverity,
  severityMeta,
  timeAgo,
} from '../lib/format';
import { usePublicIncident } from '../hooks/useCityData';
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

interface IncidentDetailScreenProps {
  reference: string;
  location: AppLocation;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}

export function IncidentDetailScreen({
  reference,
  location,
  navigate,
  onBack,
}: IncidentDetailScreenProps) {
  const query = usePublicIncident(reference);
  const incident = query.data;

  if (query.isLoading) {
    return (
      <Screen>
        <PageHeader title="Đang tải sự cố" onBack={onBack} />
        <Card><Text style={styles.muted}>Đang truy vấn production…</Text></Card>
      </Screen>
    );
  }

  if (query.error || !incident) {
    return (
      <Screen>
        <PageHeader title="Không tìm thấy sự cố" onBack={onBack} />
        <ErrorNotice message={errorMessage(query.error)} onRetry={() => query.refetch()} />
        <Card>
          <Text style={styles.muted}>
            Sự cố có thể đã bị ẩn công khai hoặc mã tra cứu chưa đúng. Bạn có thể thử mã dạng
            INC-2026-00001.
          </Text>
        </Card>
      </Screen>
    );
  }

  const severity = severityMeta[normalizeSeverity(incident.severity)];
  const coords = incident.location?.coordinates;
  const referenceCode = incident.incident_number || incident.incident_code || incident.id;
  const comments = (incident.comments ?? []).filter((comment) => !comment.is_internal);

  return (
    <Screen>
      <PageHeader
        eyebrow={referenceCode}
        title={incident.title}
        subtitle={`${timeAgo(incident.created_at)} · ${incidentStatusLabel(incident.status)}`}
        onBack={onBack}
      />

      <Card tone={incident.severity === 'critical' ? 'danger' : 'default'} style={styles.hero}>
        <View style={styles.heroTop}>
          <View style={[styles.iconBox, { backgroundColor: severity.bg }]}>
            <Ionicons name="warning" size={24} color={severity.color} />
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={styles.heroLabel}>Mức độ</Text>
            <Text style={[styles.heroValue, { color: severity.color }]}>{severity.label}</Text>
          </View>
          <Chip label={incidentStatusLabel(incident.status)} />
        </View>
        <Divider />
        <Text style={styles.description}>{incident.description}</Text>
      </Card>

      <View style={styles.metaGrid}>
        <Meta icon="pricetag" label="Loại" value={categoryLabel(incident.category)} />
        <Meta icon="time" label="Xảy ra" value={formatDateTime(incident.occurredAt || incident.reported_at)} />
        <Meta icon="thumbs-up" label="Đồng tình" value={String(incident.upvotes ?? 0)} />
        <Meta icon="eye" label="Hiển thị" value={incident.public_visible === false ? 'Nội bộ' : 'Công khai'} />
      </View>

      <SectionHeader title="Vị trí" icon="location" />
      <Card>
        <Text style={styles.address}>
          {incident.location?.address || incident.location?.description || 'Chưa có địa chỉ công khai'}
        </Text>
        <Text style={styles.coords}>
          {coords
            ? `${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)}`
            : 'Chưa có toạ độ công khai'}
        </Text>
        <PrimaryButton
          label="Chỉ đường tới vị trí"
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
      </Card>

      <SectionHeader title={`Cập nhật công khai (${comments.length})`} icon="chatbubbles" />
      {comments.length === 0 ? (
        <Card><Text style={styles.muted}>Chưa có cập nhật công khai cho sự cố này.</Text></Card>
      ) : (
        comments.map((comment) => (
          <Card key={comment.id} style={styles.comment}>
            <View style={styles.commentTop}>
              <Ionicons name="shield-checkmark" size={15} color={colors.cyan} />
              <Text style={styles.commentWho}>Đội vận hành SynapseCity</Text>
              <Text style={styles.commentTime}>{timeAgo(comment.posted_at || comment.created_at)}</Text>
            </View>
            <Text style={styles.commentBody}>{comment.comment}</Text>
          </Card>
        ))
      )}

      <PrimaryButton
        label="Xem vị trí trên bản đồ"
        icon="map"
        onPress={() => navigate({ name: 'map' })}
      />
      <Text style={styles.note}>
        Báo cáo công khai đã được loại bỏ thông tin liên hệ và bình luận nội bộ. Nếu sự cố nguy
        hiểm tức thời, hãy gọi 113/114/115.
      </Text>
    </Screen>
  );
}

function Meta({
  icon,
  label,
  value,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  value: string;
}) {
  return (
    <View style={styles.meta}>
      <Ionicons name={icon} size={16} color={colors.textMuted} />
      <View style={{ flex: 1 }}>
        <Text style={styles.metaLabel}>{label}</Text>
        <Text style={styles.metaValue} numberOfLines={2}>{value}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { gap: 12 },
  heroTop: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  iconBox: {
    width: 48,
    height: 48,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heroLabel: { color: colors.textDim, fontSize: 9, fontWeight: '700', letterSpacing: 0.4 },
  heroValue: { fontSize: 16, fontWeight: '800' },
  description: { color: colors.text, fontSize: 12, lineHeight: 19 },
  metaGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  meta: {
    width: '48%',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: colors.border,
    padding: 10,
  },
  metaLabel: { color: colors.textDim, fontSize: 8, fontWeight: '700' },
  metaValue: { color: colors.text, fontSize: 10, fontWeight: '700', marginTop: 2 },
  address: { color: colors.text, fontSize: 12, fontWeight: '700' },
  coords: { color: colors.textMuted, fontSize: 10, marginBottom: 2 },
  muted: { color: colors.textMuted, fontSize: 11, lineHeight: 17 },
  comment: { gap: 7 },
  commentTop: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  commentWho: { color: colors.textMuted, fontSize: 10, fontWeight: '700', flex: 1 },
  commentTime: { color: colors.textDim, fontSize: 9 },
  commentBody: { color: colors.text, fontSize: 11, lineHeight: 17 },
  note: { color: colors.textDim, fontSize: 9, lineHeight: 14, textAlign: 'center' },
});
