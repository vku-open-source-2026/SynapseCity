// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import NfcManager, { NfcTech } from 'react-native-nfc-manager';
import { cityApi } from '../api/city';
import type { PublicAsset } from '../api/types';
import { errorMessage } from '../api/client';
import { parseAssetCode, parseNfcRecords } from '../lib/scan';
import { colors } from '../lib/format';
import type { AppRoute } from '../lib/deepLink';
import { Card, Chip, ErrorNotice, PrimaryButton, Screen, SectionHeader, TextField } from '../components/ui';
import { PageHeader } from '../components/PageHeader';

interface ScanScreenProps {
  navigate: (route: AppRoute) => void;
  onBack: () => void;
}

type Mode = 'qr' | 'nfc';

export function ScanScreen({ navigate, onBack }: ScanScreenProps) {
  const [permission, requestPermission] = useCameraPermissions();
  const [mode, setMode] = useState<Mode>('qr');
  const [manualCode, setManualCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nfcState, setNfcState] = useState<'idle' | 'reading' | 'unsupported' | 'disabled'>('idle');
  const [scanned, setScanned] = useState<string | null>(null);
  const lock = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      NfcManager.cancelTechnologyRequest().catch(() => undefined);
    };
  }, []);

  const resolve = useCallback(
    async (raw: string) => {
      if (lock.current) return;
      const code = parseAssetCode(raw);
      if (!code) {
        setError('Mã quét được không phải tài sản SynapseCity hợp lệ.');
        return;
      }
      lock.current = true;
      setBusy(true);
      setError(null);
      setScanned(code);
      try {
        const asset: PublicAsset = await cityApi.getPublicAsset(code);
        if (!mounted.current) return;
        navigate({ name: 'asset', params: { code: asset.asset_code } });
        setTimeout(() => {
          lock.current = false;
          setBusy(false);
        }, 500);
      } catch (lookupError) {
        if (!mounted.current) return;
        setError(
          `Đã đọc mã ${code} nhưng không tìm thấy tài sản công khai. ${errorMessage(lookupError)}`,
        );
        lock.current = false;
        setBusy(false);
      }
    },
    [navigate],
  );

  const onBarcode = useCallback(
    (result: { data?: string }) => {
      if (result.data) resolve(result.data).catch(() => undefined);
    },
    [resolve],
  );

  const startNfc = useCallback(async () => {
    setError(null);
    setScanned(null);
    try {
      const supported = await NfcManager.isSupported();
      if (!supported) {
        setNfcState('unsupported');
        return;
      }
      const enabled = await NfcManager.isEnabled();
      if (!enabled) {
        setNfcState('disabled');
        return;
      }
      await NfcManager.start();
      setNfcState('reading');
      NfcManager.requestTechnology(NfcTech.Ndef)
        .then(async () => {
          const tag = await NfcManager.getTag();
          const code = parseNfcRecords(tag?.ndefMessage);
          if (code) {
            await resolve(code);
          } else {
            setError('Đã chạm thẻ nhưng thẻ không chứa mã tài sản SynapseCity.');
          }
        })
        .catch((nfcError: unknown) => {
          if (mounted.current) {
            setError(
              nfcError instanceof Error
                ? `Không đọc được thẻ NFC: ${nfcError.message}`
                : 'Không đọc được thẻ NFC.',
            );
          }
        })
        .finally(() => {
          NfcManager.cancelTechnologyRequest().catch(() => undefined);
          if (mounted.current) setNfcState('idle');
        });
    } catch {
      setNfcState('unsupported');
    }
  }, [resolve]);

  useEffect(() => {
    if (mode === 'nfc') {
      startNfc().catch(() => undefined);
    } else {
      NfcManager.cancelTechnologyRequest().catch(() => undefined);
      setNfcState('idle');
    }
  }, [mode, startNfc]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && mode === 'nfc' && nfcState === 'disabled') {
        startNfc().catch(() => undefined);
      }
    });
    return () => subscription.remove();
  }, [mode, nfcState, startNfc]);

  return (
    <Screen>
      <PageHeader
        eyebrow="NHẬN DIỆN"
        title="Quét QR / NFC"
        subtitle="Quét mã trên tài sản hoặc chạm thẻ NFC để mở hồ sơ công khai."
        onBack={onBack}
      />

      <View style={styles.modeRow}>
        <Pressable
          onPress={() => setMode('qr')}
          style={[styles.mode, mode === 'qr' && styles.modeActive]}
        >
          <Ionicons name="qr-code" size={18} color={mode === 'qr' ? colors.cyan : colors.textMuted} />
          <Text style={[styles.modeText, mode === 'qr' && { color: colors.text }]}>QR code</Text>
        </Pressable>
        <Pressable
          onPress={() => setMode('nfc')}
          style={[styles.mode, mode === 'nfc' && styles.modeActive]}
        >
          <Ionicons name="radio" size={18} color={mode === 'nfc' ? colors.cyan : colors.textMuted} />
          <Text style={[styles.modeText, mode === 'nfc' && { color: colors.text }]}>Thẻ NFC</Text>
        </Pressable>
      </View>

      {mode === 'qr' ? (
        <Card style={styles.cameraCard}>
          {!permission ? (
            <View style={styles.cameraPlaceholder}>
              <Text style={styles.placeholderText}>Đang kiểm tra quyền camera…</Text>
            </View>
          ) : permission.granted ? (
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'ean13'] }}
              onBarcodeScanned={busy ? undefined : onBarcode}
            />
          ) : (
            <View style={styles.cameraPlaceholder}>
              <Ionicons name="camera-outline" size={32} color={colors.textMuted} />
              <Text style={styles.placeholderText}>
                Cần quyền camera để quét mã QR gắn trên tài sản.
              </Text>
              <PrimaryButton label="Cấp quyền camera" onPress={() => requestPermission()} />
            </View>
          )}
          <View style={styles.scanFrame} pointerEvents="none">
            <View style={styles.cornerTL} />
            <View style={styles.cornerTR} />
            <View style={styles.cornerBL} />
            <View style={styles.cornerBR} />
          </View>
        </Card>
      ) : (
        <Card tone="cyan" style={styles.nfcCard}>
          <View style={styles.nfcIcon}>
            <Ionicons
              name={nfcState === 'reading' ? 'radio' : 'wifi'}
              size={34}
              color={colors.cyan}
            />
          </View>
          <Text style={styles.nfcTitle}>
            {nfcState === 'reading'
              ? 'Đang chờ thẻ NFC…'
              : nfcState === 'unsupported'
                ? 'Thiết bị không hỗ trợ NFC'
                : nfcState === 'disabled'
                  ? 'NFC đang tắt'
                  : 'Chạm thẻ NFC'}
          </Text>
          <Text style={styles.nfcBody}>
            {nfcState === 'reading'
              ? 'Đưa thẻ hoặc điện thoại lại gần đầu đọc. Ứng dụng sẽ tự mở hồ sơ tài sản.'
              : nfcState === 'disabled'
                ? 'Bật NFC trong Cài đặt Android rồi thử lại.'
                : 'Thẻ NFC của tài sản chứa URL SynapseCity. Ứng dụng chỉ đọc, không ghi thẻ.'}
          </Text>
          <PrimaryButton
            label={nfcState === 'reading' ? 'Đang đọc…' : 'Thử lại NFC'}
            icon="radio"
            loading={nfcState === 'reading'}
            onPress={() => startNfc()}
            tone="ghost"
          />
        </Card>
      )}

      <SectionHeader title="Nhập mã thủ công" icon="keypad" />
      <Card>
        <TextField
          label="Mã tài sản"
          value={manualCode}
          onChangeText={setManualCode}
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder="VD: TRA-A65B10"
          hint="Có thể dán URL đầy đủ từ mã QR."
        />
        <PrimaryButton
          label="Tra cứu tài sản"
          icon="search"
          loading={busy}
          disabled={!manualCode.trim()}
          onPress={() => resolve(manualCode).catch(() => undefined)}
        />
      </Card>

      {scanned ? <Chip label={`Đã đọc: ${scanned}`} color={colors.cyan} icon="checkmark-circle" /> : null}
      {error ? <ErrorNotice message={error} /> : null}

      <Card>
        <Text style={styles.helpTitle}>Mẹo quét nhanh</Text>
        <Text style={styles.help}>
          • Giữ camera cách mã QR 10–20 cm, đủ sáng, không rung.{'\n'}
          • QR của SynapseCity có dạng https://synapsecity.sbs/asset/MÃ.{'\n'}
          • Với NFC, đặt điện thoại sát phần trên của thẻ và giữ 1–2 giây.
        </Text>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  modeRow: {
    flexDirection: 'row',
    backgroundColor: colors.card,
    borderRadius: 14,
    padding: 4,
    borderWidth: 1,
    borderColor: colors.border,
  },
  mode: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 10,
    borderRadius: 11,
  },
  modeActive: { backgroundColor: '#CCFBF1' },
  modeText: { color: colors.textMuted, fontSize: 12, fontWeight: '700' },
  cameraCard: { padding: 0, overflow: 'hidden', minHeight: 300 },
  camera: { width: '100%', height: 320 },
  cameraPlaceholder: {
    height: 300,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 24,
  },
  placeholderText: { color: colors.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 18 },
  scanFrame: {
    position: 'absolute',
    top: '22%',
    left: '20%',
    width: '60%',
    height: '56%',
  },
  cornerTL: {
    position: 'absolute', top: 0, left: 0, width: 24, height: 24,
    borderTopWidth: 3, borderLeftWidth: 3, borderColor: colors.cyan, borderTopLeftRadius: 8,
  },
  cornerTR: {
    position: 'absolute', top: 0, right: 0, width: 24, height: 24,
    borderTopWidth: 3, borderRightWidth: 3, borderColor: colors.cyan, borderTopRightRadius: 8,
  },
  cornerBL: {
    position: 'absolute', bottom: 0, left: 0, width: 24, height: 24,
    borderBottomWidth: 3, borderLeftWidth: 3, borderColor: colors.cyan, borderBottomLeftRadius: 8,
  },
  cornerBR: {
    position: 'absolute', bottom: 0, right: 0, width: 24, height: 24,
    borderBottomWidth: 3, borderRightWidth: 3, borderColor: colors.cyan, borderBottomRightRadius: 8,
  },
  nfcCard: { alignItems: 'center', gap: 10, paddingVertical: 24 },
  nfcIcon: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#CCFBF1',
    alignItems: 'center',
    justifyContent: 'center',
  },
  nfcTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  nfcBody: { color: colors.textMuted, fontSize: 11, textAlign: 'center', lineHeight: 17, paddingHorizontal: 12 },
  helpTitle: { color: colors.text, fontSize: 12, fontWeight: '700' },
  help: { color: colors.textMuted, fontSize: 10, lineHeight: 17 },
});
