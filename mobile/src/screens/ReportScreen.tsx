// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { cityApi } from '../api/city';
import { errorMessage } from '../api/client';
import type { PublicIncident, Severity } from '../api/types';
import type { AppRoute } from '../lib/deepLink';
import { categoryLabel, colors, severityMeta } from '../lib/format';
import type { AppLocation } from '../hooks/useLocation';
import {
  Card,
  Chip,
  ErrorNotice,
  PrimaryButton,
  Screen,
  SectionHeader,
  TextField,
} from '../components/ui';
import { PageHeader } from '../components/PageHeader';

const categories = ['damage', 'malfunction', 'safety_hazard', 'vandalism', 'other'];
const severities: Severity[] = ['low', 'medium', 'high', 'critical'];

interface ReportScreenProps {
  location: AppLocation;
  navigate: (route: AppRoute) => void;
  onBack: () => void;
  initialAssetCode?: string;
}

export function ReportScreen({ location, navigate, onBack, initialAssetCode }: ReportScreenProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [address, setAddress] = useState('');
  const [category, setCategory] = useState('damage');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<PublicIncident | null>(null);

  const assetQuery = useQuery({
    queryKey: ['city', 'asset', initialAssetCode || 'none'],
    queryFn: () => cityApi.getPublicAsset(initialAssetCode as string),
    enabled: Boolean(initialAssetCode),
    retry: 0,
  });

  const asset = assetQuery.data;
  const validation = useMemo(() => {
    if (title.trim().length < 5) return 'Tiêu đề cần ít nhất 5 ký tự.';
    if (description.trim().length < 10) return 'Mô tả cần ít nhất 10 ký tự.';
    return null;
  }, [title, description]);

  const submit = async () => {
    if (validation) {
      setError(validation);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const incident = await cityApi.createPublicIncident({
        title: title.trim(),
        description: description.trim(),
        category,
        severity,
        ...(asset ? { asset_id: asset.id || asset.asset_code } : {}),
        location: {
          address: address.trim() || asset?.location?.address || 'Vị trí hiện tại',
          coordinates: {
            latitude: location.latitude,
            longitude: location.longitude,
          },
          geometry: {
            type: 'Point',
            coordinates: [location.longitude, location.latitude],
          },
        },
      });
      setCreated(incident);
    } catch (submitError) {
      setError(errorMessage(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <Screen>
        <PageHeader eyebrow="ĐÃ GỬI" title="Báo cáo đã được ghi nhận" onBack={onBack} />
        <Card tone="cyan" style={styles.successCard}>
          <View style={styles.successIcon}>
            <Ionicons name="checkmark" size={34} color="#FFFFFF" />
          </View>
          <Text style={styles.successTitle}>{created.title}</Text>
          <Text style={styles.successCode}>
            {created.incident_number || created.incident_code || created.id}
          </Text>
          <Text style={styles.successBody}>
            Báo cáo đã vào hàng chờ của đội vận hành SynapseCity. Bạn có thể tra cứu lại bằng mã
            sự cố ở mục Sự cố.
          </Text>
        </Card>
        <PrimaryButton
          label="Xem sự cố vừa gửi"
          icon="open-outline"
          onPress={() =>
            navigate({
              name: 'incident',
              params: { reference: created.incident_number || created.id },
            })
          }
        />
        <PrimaryButton
          label="Gửi báo cáo khác"
          tone="ghost"
          onPress={() => {
            setCreated(null);
            setTitle('');
            setDescription('');
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen>
      <PageHeader
        eyebrow="CÔNG DÂN"
        title="Báo sự cố hạ tầng"
        subtitle="Gửi tới đội vận hành SynapseCity. Không cần tài khoản."
        onBack={onBack}
      />

      {asset ? (
        <Card tone="cyan" style={styles.assetCard}>
          <Ionicons name="cube" size={22} color={colors.cyan} />
          <View style={{ flex: 1 }}>
            <Text style={styles.assetName}>{asset.name}</Text>
            <Text style={styles.assetMeta}>
              {asset.asset_code} · {asset.location?.address || 'Chưa có địa chỉ'}
            </Text>
          </View>
        </Card>
      ) : null}

      <Card>
        <TextField
          label="Tiêu đề"
          value={title}
          onChangeText={setTitle}
          placeholder="VD: Nắp hố ga bị bật trên đường"
          maxLength={140}
        />
        <TextField
          label="Mô tả"
          value={description}
          onChangeText={setDescription}
          placeholder="Mô tả hiện tượng, mức độ nguy hiểm và vị trí cụ thể…"
          multiline
          maxLength={2000}
        />
        <TextField
          label="Địa chỉ / mốc tham chiếu"
          value={address}
          onChangeText={setAddress}
          placeholder={asset?.location?.address || 'VD: gần ngã tư Nguyễn Tất Thành'}
        />
      </Card>

      <SectionHeader title="Loại sự cố" icon="pricetags" />
      <View style={styles.chips}>
        {categories.map((value) => (
          <Chip
            key={value}
            label={categoryLabel(value)}
            active={category === value}
            onPress={() => setCategory(value)}
          />
        ))}
      </View>

      <SectionHeader title="Mức độ" icon="speedometer" />
      <View style={styles.chips}>
        {severities.map((value) => {
          const meta = severityMeta[value];
          return (
            <Pressable
              key={value}
              onPress={() => setSeverity(value)}
              style={[
                styles.severity,
                { borderColor: severity === value ? meta.color : colors.border },
                severity === value && { backgroundColor: meta.bg },
              ]}
            >
              <View style={[styles.severityDot, { backgroundColor: meta.color }]} />
              <Text style={[styles.severityText, severity === value && { color: meta.color }]}>
                {meta.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Card>
        <View style={styles.locationRow}>
          <Ionicons name="location" size={18} color={colors.cyan} />
          <View style={{ flex: 1 }}>
            <Text style={styles.locationTitle}>Vị trí gửi kèm</Text>
            <Text style={styles.locationText}>
              {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
              {location.isFallback ? ' · vị trí mặc định Đà Nẵng' : ''}
            </Text>
          </View>
        </View>
        {location.isFallback ? (
          <Text style={styles.locationWarn}>
            Chưa có vị trí GPS chính xác. Đang dùng trung tâm Đà Nẵng; báo cáo vẫn gửi được nhưng nên
            bật GPS để đội kỹ thuật đến đúng chỗ.
          </Text>
        ) : null}
      </Card>

      {error ? <ErrorNotice message={error} /> : null}
      <PrimaryButton
        label="Gửi báo cáo tới SynapseCity"
        icon="send"
        loading={submitting}
        onPress={() => submit().catch(() => undefined)}
      />
      <Text style={styles.disclaimer}>
        Báo cáo công khai sẽ hiển thị cho cộng đồng; thông tin liên hệ cá nhân không được gửi kèm.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  assetCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  assetName: { color: colors.text, fontSize: 13, fontWeight: '800' },
  assetMeta: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  severity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  severityDot: { width: 7, height: 7, borderRadius: 4 },
  severityText: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },
  locationRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  locationTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  locationText: { color: colors.textMuted, fontSize: 10, marginTop: 2 },
  locationWarn: { color: colors.amber, fontSize: 10, lineHeight: 15 },
  disclaimer: { color: colors.textDim, fontSize: 9, textAlign: 'center', lineHeight: 14 },
  successCard: { alignItems: 'center', paddingVertical: 28, gap: 8 },
  successIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.green,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successTitle: { color: colors.text, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  successCode: { color: colors.cyan, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  successBody: { color: colors.textMuted, fontSize: 11, textAlign: 'center', lineHeight: 17 },
});
