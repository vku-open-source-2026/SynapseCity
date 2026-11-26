// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors } from '../lib/format';

export function PageHeader({
  title,
  subtitle,
  onBack,
  right,
  eyebrow,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  right?: React.ReactNode;
  eyebrow?: string;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.brandBar}>
        <View style={styles.brandTile}>
          <Ionicons name="business" size={17} color="#FFFFFF" />
        </View>
        <View style={styles.brandText}>
          <Text style={styles.brandName}>SynapseCity</Text>
          <Text style={styles.brandTag}>Hạ tầng đô thị Đà Nẵng</Text>
        </View>
      </View>
      <View style={styles.header}>
        {onBack ? (
          <Pressable onPress={onBack} style={styles.back} accessibilityLabel="Quay lại">
            <Ionicons name="arrow-back" size={20} color={colors.text} />
          </Pressable>
        ) : null}
        <View style={styles.textWrap}>
          {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text> : null}
        </View>
        {right}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12 },
  /** Brand lockup theo web console: khối tối #123c4a + tên SP + mô tả ngắn. */
  brandBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: colors.header,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  brandTile: {
    width: 32,
    height: 32,
    borderRadius: 8,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandText: { flex: 1, gap: 1 },
  brandName: { color: '#FFFFFF', fontSize: 15, fontWeight: '800', letterSpacing: 0.2 },
  brandTag: { color: 'rgba(255,255,255,0.72)', fontSize: 10, fontWeight: '500' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 50,
  },
  back: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: colors.border,
    shadowColor: '#0F172A',
    shadowOpacity: 0.05,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  textWrap: { flex: 1, gap: 2 },
  eyebrow: { color: colors.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  title: { color: colors.text, fontSize: 24, fontWeight: '800', letterSpacing: -0.6 },
  subtitle: { color: colors.textMuted, fontSize: 11, lineHeight: 16 },
});
