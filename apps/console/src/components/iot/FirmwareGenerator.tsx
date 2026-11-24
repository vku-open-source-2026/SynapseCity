// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import { useEffect, useMemo, useState } from 'react';
import { iotApi } from '../../api/iot';
import type { FirmwareResponse, IoTCatalog } from '../../types/iot';

interface Props { sensorId: string; assetType?: string; defaultSensorType?: string }

function guessSensor(catalog: IoTCatalog | null, assetType?: string, sensorType?: string): string {
  if (!catalog) return sensorType || 'water_level_jsn';
  const hay = `${assetType || ''} ${sensorType || ''}`.toLowerCase();
  if (/drain|culvert|sewer|canal|cong|cống|ngap|ngập/.test(hay)) return 'water_level_jsn';
  if (/pump|bom|bơm/.test(hay)) return 'pressure';
  if (/reservoir|tank|bể|be/.test(hay)) return 'water_level_jsn';
  if (/bridge|cau|cầu/.test(hay)) return 'vibration';
  if (/park|green|cay|cây/.test(hay)) return 'soil';
  // Ưu tiên gợi ý đầu tiên của catalog khi không khớp.
  const flat = Object.values(catalog.suggestions || {}).flat();
  return sensorType && catalog.sensors.some((s) => s.id === sensorType) ? sensorType : (flat[0] || 'water_level_jsn');
}

export default function FirmwareGenerator({ sensorId, assetType, defaultSensorType }: Props) {
  const [catalog, setCatalog] = useState<IoTCatalog | null>(null);
  const [mcu, setMcu] = useState('esp32');
  const [sensor, setSensor] = useState(defaultSensorType || 'water_level_jsn');
  const [wifiSsid, setWifiSsid] = useState('');
  const [wifiPass, setWifiPass] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [intervalSeconds, setIntervalSeconds] = useState(60);
  const [result, setResult] = useState<FirmwareResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mockLoading, setMockLoading] = useState(false);
  const [mockMsg, setMockMsg] = useState('');

  useEffect(() => {
    iotApi.getCatalog().then((c) => {
      setCatalog(c);
      setSensor(guessSensor(c, assetType, defaultSensorType));
      if (c.mcus?.length) setMcu(c.mcus[0].id);
    }).catch(() => undefined);
  }, [assetType, defaultSensorType]);

  const sensorHint = useMemo(() => {
    if (!catalog) return '';
    const found = catalog.sensors.find((s) => s.id === sensor);
    return found ? `${found.label} — ${found.description || ''} (${found.unit})` : '';
  }, [catalog, sensor]);

  const generate = async () => {
    setError(''); setResult(null);
    if (!wifiSsid.trim()) { setError('Nhập WiFi SSID mà ESP32 sẽ kết nối.'); return; }
    if (!apiKey.trim()) { setError('Dán device-scoped X-API-Key (quyền iot:write). Không dùng service key.'); return; }
    setLoading(true);
    try {
      const out = await iotApi.generateFirmware(sensorId, {
        mcu, sensor, wifi_ssid: wifiSsid.trim(), wifi_pass: wifiPass,
        api_key: apiKey.trim(), interval_seconds: intervalSeconds, mock_fallback: true,
      });
      setResult(out);
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message || 'Sinh firmware thất bại';
      setError(String(msg));
    } finally { setLoading(false); }
  };

  const mock = async () => {
    setMockMsg(''); setMockLoading(true);
    try {
      const out = await iotApi.mockReadings(sensorId, { count: 48, interval_seconds: 300 });
      setMockMsg(`Đã tạo ${out.ingested} điểm mock để vẽ chart demo.`);
    } catch { setMockMsg('Tạo mock thất bại.'); }
    finally { setMockLoading(false); }
  };

  return (
    <div className="rounded border p-4 space-y-3">
      <h3 className="font-semibold">Nạp firmware ESP32</h3>
      {assetType?.match(/drain|culvert|sewer|canal|cong|cống|ngập|ngap/i) ? (
        <p className="text-sm text-sky-700">Cống nước → đề xuất <b>JSN-SR04T chống nước</b> đo mực nước + cảm biến mưa, kèm phao tràn dự phòng.</p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm">MCU
          <select className="w-full border rounded p-1" value={mcu} onChange={(e) => setMcu(e.target.value)}>
            {(catalog?.mcus || [{ id: 'esp32', label: 'ESP32 DevKit V1' }]).map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Cảm biến
          <select className="w-full border rounded p-1" value={sensor} onChange={(e) => setSensor(e.target.value)}>
            {(catalog?.sensors || []).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      {sensorHint ? <p className="text-xs text-slate-600">{sensorHint}</p> : null}
      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm">WiFi SSID<input className="w-full border rounded p-1" value={wifiSsid} onChange={(e) => setWifiSsid(e.target.value)} placeholder="TenWiFi" /></label>
        <label className="text-sm">WiFi pass<input type="password" className="w-full border rounded p-1" value={wifiPass} onChange={(e) => setWifiPass(e.target.value)} placeholder="mat-khau-wifi" /></label>
      </div>
      <label className="text-sm block">Device API key (iot:write)
        <input type="password" className="w-full border rounded p-1" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="synapseone_..." />
      </label>
      <label className="text-sm block">Chu kỳ gửi (giây)
        <input type="number" min={5} max={3600} className="w-full border rounded p-1" value={intervalSeconds} onChange={(e) => setIntervalSeconds(Number(e.target.value) || 60)} />
      </label>
      {error ? <p className="text-sm text-red-600">{error}</p> : null}
      <div className="flex gap-2">
        <button disabled={loading} onClick={generate} className="px-3 py-1 rounded bg-slate-900 text-white text-sm">{loading ? 'Đang sinh...' : 'Generate .ino'}</button>
        <button disabled={mockLoading} onClick={mock} className="px-3 py-1 rounded border text-sm">{mockLoading ? 'Đang tạo...' : 'Tạo mock data'}</button>
      </div>
      {mockMsg ? <p className="text-xs text-green-700">{mockMsg}</p> : null}
      {result ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <b className="text-sm">{result.filename}</b>
            <a className="text-sm underline" href={`data:text/plain;charset=utf-8,${encodeURIComponent(result.code)}`} download={result.filename}>Tải .ino</a>
          </div>
          <pre className="text-xs bg-slate-950 text-slate-100 p-2 rounded overflow-auto max-h-96">{result.code}</pre>
          {result.warning ? <p className="text-xs text-amber-700">{result.warning}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
