// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
// DX workspace code widget: live water-culvert card.
// Runs in the isolated worker: studio.query() reads declared data widgets,
// studio.render() updates sanitized HTML. No network/DOM/storage access.
const PREFERRED = 'cong-nc-001-wl';
const DEPTH_CM = 220;

const number = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const fmt = (value, digits = 1) => {
  const n = number(value);
  return n === null ? '—' : n.toFixed(digits);
};
const time = (iso) => {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('vi-VN');
};
const bucket = (value) => Math.round(Math.max(0, Math.min(100, value)));

function levelClass(value) {
  if (value === null) return '';
  if (value >= 190) return 'bad';
  if (value >= 150) return 'warn';
  return '';
}

function levelLabel(value) {
  if (value === null) return 'Chưa có dữ liệu';
  if (value >= 190) return 'Nguy hiểm · ngập';
  if (value >= 150) return 'Cảnh báo · nước cao';
  return 'Bình thường · đang giám sát';
}

async function load() {
  const sensorPage = await studio.query('iot-table', { limit: 20, search: 'CONG-NC-001' });
  const sensors = Array.isArray(sensorPage && sensorPage.rows) ? sensorPage.rows : [];
  const sensor =
    sensors.find((row) => row.id === PREFERRED) ||
    sensors.find((row) => row.sensor_type === 'water_level') ||
    sensors[0] ||
    null;
  const sensorId = (sensor && sensor.id) || PREFERRED;

  const readingPage = await studio.query('readings-table', {
    limit: 100,
    sortBy: 'timestamp',
    sortDirection: 'desc',
  });
  const rows = (Array.isArray(readingPage && readingPage.rows) ? readingPage.rows : [])
    .filter((row) => row.sensor_id === sensorId)
    .map((row) => ({ value: number(row.value), timestamp: row.timestamp, id: row.id }))
    .filter((row) => row.value !== null)
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  const values = rows.map((row) => row.value);
  const last = values.length ? values[values.length - 1] : number(sensor && sensor.last_reading);
  const avg = values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
  const max = values.length ? Math.max(...values) : null;
  const lastSeen = (rows.length && rows[rows.length - 1].timestamp) || (sensor && sensor.last_seen);
  const cls = levelClass(last);
  const width = last === null ? 0 : bucket((last / DEPTH_CM) * 100);
  const recent = rows.slice(-48);
  const bars = recent
    .map((row) => {
      const height = Math.max(2, bucket((row.value / DEPTH_CM) * 100));
      return (
        '<div class="cw-col" title="' +
        fmt(row.value) +
        ' cm"><span class="cw-bar ' +
        levelClass(row.value) +
        ' h' +
        height +
        '"></span></div>'
      );
    })
    .join('');

  studio.render(
    '<section class="cw">' +
      '<div class="cw-head">' +
        '<div><h2>Cống nước · Live</h2>' +
        '<p>' +
        (sensor ? (sensor.sensor_code || sensor.id) + ' · ' + (sensor.measurement_unit || 'cm') : PREFERRED) +
        ' · cập nhật ' +
        time(lastSeen) +
        '</p></div>' +
        '<span class="cw-pill"><span class="cw-dot ' +
        cls +
        '"></span>' +
        levelLabel(last) +
        '</span>' +
      '</div>' +
      '<div class="cw-grid">' +
        '<div class="cw-card">' +
          '<div class="k">Mực nước hiện tại</div>' +
          '<div class="cw-value">' +
          (last === null ? '—' : last.toFixed(0)) +
          ' <span>cm</span></div>' +
          '<div class="cw-track"><div class="cw-fill ' +
          cls +
          ' w' +
          width +
          '"></div></div>' +
          '<div class="cw-legend"><span>0 cm</span><span>đáy cống ' +
          DEPTH_CM +
          ' cm</span></div>' +
        '</div>' +
        '<div class="cw-card"><div class="k">Trung bình 24h</div><strong>' +
        fmt(avg) +
        ' cm</strong><div class="cw-muted">' +
        values.length +
        ' điểm gần nhất</div></div>' +
        '<div class="cw-card"><div class="k">Cao nhất 24h</div><strong>' +
        fmt(max) +
        ' cm</strong><div class="cw-muted">ngưỡng 150 / 190 cm</div></div>' +
      '</div>' +
      '<div class="cw-card cw-mt">' +
        '<div class="k">48 điểm gần nhất</div>' +
        '<div class="cw-bars">' +
        (bars || '<div class="cw-muted">Chưa có reading</div>') +
        '</div>' +
        '<div class="cw-legend"><span>cũ</span><span>mới nhất</span></div>' +
      '</div>' +
      '<div class="cw-note">Nguồn: Tier-2 <strong>city-iot-readings</strong> · topic <strong>city/sensors/' +
      sensorId +
      '/data</strong> · tự làm mới 15 giây.</div>' +
    '</section>'
  );
}

load().catch((error) => {
  studio.render(
    '<div class="cw-err">Không tải được dữ liệu cống: ' +
      String((error && error.message) || error) +
      '</div>'
  );
});

setInterval(() => {
  load().catch(() => {});
}, 15000);
