// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AppRouteName } from '../lib/deepLink';
import { colors } from '../lib/format';

const tabs: Array<{
  route: AppRouteName;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
}> = [
  { route: 'home', label: 'Tổng quan', icon: 'grid-outline', activeIcon: 'grid' },
  { route: 'map', label: 'Bản đồ', icon: 'map-outline', activeIcon: 'map' },
  { route: 'scan', label: 'Quét', icon: 'scan-outline', activeIcon: 'scan' },
  { route: 'alerts', label: 'Sự cố', icon: 'notifications-outline', activeIcon: 'notifications' },
  { route: 'account', label: 'Tài khoản', icon: 'person-outline', activeIcon: 'person' },
];

export function TabBar({
  active,
  onNavigate,
}: {
  active: AppRouteName;
  onNavigate: (route: AppRouteName) => void;
}) {
  return (
    <View style={styles.wrapper}>
      <View style={styles.bar}>
        {tabs.map((tab) => {
          const selected = active === tab.route;
          const center = tab.route === 'scan';
          if (center) {
            return (
              <Pressable
                key={tab.route}
                onPress={() => onNavigate(tab.route)}
                accessibilityLabel="Quét mã QR hoặc NFC"
                style={styles.centerWrap}
              >
                <View style={[styles.centerButton, selected && styles.centerButtonActive]}>
                  <Ionicons name={tab.activeIcon} size={24} color="#FFFFFF" />
                </View>
                <Text style={[styles.centerLabel, selected && { color: colors.cyan }]}>{tab.label}</Text>
              </Pressable>
            );
          }
          return (
            <Pressable
              key={tab.route}
              onPress={() => onNavigate(tab.route)}
              accessibilityLabel={tab.label}
              style={styles.tab}
            >
              <Ionicons
                name={selected ? tab.activeIcon : tab.icon}
                size={21}
                color={selected ? colors.cyan : colors.textDim}
              />
              <Text style={[styles.label, selected && styles.labelActive]}>{tab.label}</Text>
              {selected ? <View style={styles.indicator} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 10,
    paddingBottom: 10,
  },
  bar: {
    height: 64,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.97)',
    borderWidth: 1,
    borderColor: colors.border,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    shadowColor: '#0F172A',
    shadowOpacity: 0.10,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 3, height: 56 },
  label: { color: colors.textDim, fontSize: 9, fontWeight: '600' },
  labelActive: { color: colors.cyan },
  indicator: {
    position: 'absolute',
    bottom: 3,
    width: 12,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.cyan,
  },
  centerWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 2 },
  centerButton: {
    width: 50,
    height: 50,
    borderRadius: 18,
    backgroundColor: colors.cyan,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -22,
    borderWidth: 4,
    borderColor: colors.bg,
    shadowColor: colors.cyan,
    shadowOpacity: 0.28,
    shadowRadius: 12,
    elevation: 8,
  },
  centerButtonActive: { backgroundColor: '#0B7F7B' },
  centerLabel: { color: colors.textDim, fontSize: 9, fontWeight: '700', marginTop: -1 },
});
