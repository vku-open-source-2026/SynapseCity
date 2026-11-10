// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { PublicAsset } from '../api/types';
import { assetCoordinates, pointInDirection } from '../lib/geo';
import { assetStatusMeta, colors } from '../lib/format';
import type { AppLocation } from '../hooks/useLocation';

interface RadarMapProps {
  location: AppLocation;
  assets: PublicAsset[];
  size?: number;
  radiusMeters?: number;
  showLabels?: boolean;
}

export function RadarMap({
  location,
  assets,
  size = 220,
  radiusMeters = 3_000,
  showLabels = true,
}: RadarMapProps) {
  const center = size / 2;
  const innerRadius = center - 16;
  const visible = assets
    .map((asset) => {
      const coordinates = assetCoordinates(asset);
      if (!coordinates) return null;
      const position = pointInDirection(
        { latitude: location.latitude, longitude: location.longitude },
        coordinates,
        radiusMeters,
      );
      return { asset, ...position };
    })
    .filter(
      (entry): entry is {
        asset: PublicAsset;
        x: number;
        y: number;
        distance: number;
      } => Boolean(entry),
    )
    .slice(0, 30);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <View style={[styles.ring, { width: size - 12, height: size - 12, borderRadius: size / 2 }]} />
      <View
        style={[
          styles.ring,
          {
            width: size * 0.66,
            height: size * 0.66,
            borderRadius: size * 0.33,
            opacity: 0.65,
          },
        ]}
      />
      <View
        style={[
          styles.ring,
          {
            width: size * 0.33,
            height: size * 0.33,
            borderRadius: size * 0.17,
            opacity: 0.45,
          },
        ]}
      />
      <View style={[styles.axisH, { width: innerRadius * 2 }]} />
      <View style={[styles.axisV, { height: innerRadius * 2 }]} />
      {visible.map((entry) => {
        const status = assetStatusMeta(entry.asset.status);
        const left = center + entry.x * innerRadius - 7;
        const top = center + entry.y * innerRadius - 7;
        return (
          <View
            key={`${entry.asset.asset_code}-${entry.distance}`}
            style={[
              styles.dot,
              {
                left,
                top,
                backgroundColor: status.color,
                opacity: entry.distance > radiusMeters ? 0.35 : 1,
              },
            ]}
          />
        );
      })}
      <View style={[styles.userHalo, { left: center - 14, top: center - 14 }]} />
      <View style={[styles.userDot, { left: center - 6, top: center - 6 }]} />
      {showLabels ? (
        <>
          <Text style={styles.north}>B</Text>
          <Text style={styles.radiusLabel}>{Math.round(radiusMeters / 1000)} km</Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    borderRadius: 999,
    backgroundColor: '#F0FDFA',
    borderWidth: 1,
    borderColor: '#CCFBF1',
  },
  ring: {
    position: 'absolute',
    borderWidth: 1,
    borderColor: 'rgba(15, 159, 154, 0.16)',
  },
  axisH: {
    position: 'absolute',
    height: 1,
    backgroundColor: '#D9E8EA',
  },
  axisV: {
    position: 'absolute',
    width: 1,
    backgroundColor: '#D9E8EA',
  },
  dot: {
    position: 'absolute',
    width: 14,
    height: 14,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  userHalo: {
    position: 'absolute',
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(15, 159, 154, 0.15)',
  },
  userDot: {
    position: 'absolute',
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.cyan,
    borderWidth: 2,
    borderColor: '#FFFFFF',
  },
  north: {
    position: 'absolute',
    top: 4,
    color: colors.textDim,
    fontSize: 10,
    fontWeight: '700',
  },
  radiusLabel: {
    position: 'absolute',
    bottom: 6,
    right: 12,
    color: colors.textDim,
    fontSize: 9,
    fontWeight: '600',
  },
});
