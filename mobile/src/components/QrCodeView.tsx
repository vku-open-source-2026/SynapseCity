// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import QRCode from 'qrcode';
import { colors } from '../lib/format';

export function QrCodeView({ value, size = 200 }: { value: string; size?: number }) {
  const matrix = useMemo(() => {
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
      return { size: qr.modules.size, data: qr.modules.data };
    } catch {
      return null;
    }
  }, [value]);

  if (!matrix) {
    return <View style={[styles.placeholder, { width: size, height: size }]} />;
  }

  const quiet = 8;
  const cell = Math.max(2, Math.floor((size - quiet * 2) / matrix.size));
  const actual = cell * matrix.size + quiet * 2;
  const rows = Array.from({ length: matrix.size }, (_, row) => row);

  return (
    <View style={[styles.frame, { width: actual, height: actual, padding: quiet }]}>
      {rows.map((row) => (
        <View key={row} style={styles.row}>
          {rows.map((column) => (
            <View
              key={column}
              style={{
                width: cell,
                height: cell,
                backgroundColor: matrix.data[row * matrix.size + column] ? '#06121C' : '#F8FAFC',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { backgroundColor: '#F8FAFC', borderRadius: 10, overflow: 'hidden' },
  row: { flexDirection: 'row' },
  placeholder: { backgroundColor: colors.cardAlt, borderRadius: 10 },
});
