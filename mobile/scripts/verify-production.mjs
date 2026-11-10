// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
const API = 'https://synapsecity.sbs/v1';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function get(path) {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${API}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'SynapseCity-Mobile-Contract/0.1' },
        signal: AbortSignal.timeout(20_000),
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = text;
      }
      if ([429, 502, 503, 504].includes(response.status) && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      return { response, body };
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastError || new Error(`GET ${path} failed after retries`);
}

const failures = [];

const product = await get('/city');
assert(product.response.ok, `GET /city expected 2xx, got ${product.response.status}`);
assert(product.body?.product === 'synapsecity', 'GET /city product mismatch');
assert(product.body?.tier === 3, 'GET /city tier mismatch');
assert(
  String(product.body?.dependency).includes('synapsedx.sbs'),
  'GET /city does not point at the public Tier-2 URL',
);
assert(Array.isArray(product.body?.notOwned), 'GET /city notOwned missing');
assert(product.body.notOwned.includes('hazards'), 'City boundary does not disclaim hazards');

const assets = await get('/public/assets?limit=200');
assert(assets.response.ok, `GET /public/assets expected 2xx, got ${assets.response.status}`);
assert(Array.isArray(assets.body), 'GET /public/assets must return an array');
assert(assets.body.length > 0, 'No public assets returned from production');
for (const asset of assets.body.slice(0, 10)) {
  assert(typeof asset.asset_code === 'string', 'asset_code missing');
  assert(typeof asset.name === 'string', 'asset name missing');
  assert(typeof asset.status === 'string', 'asset status missing');
  assert(asset.location?.coordinates?.latitude, 'asset coordinates missing');
}
const sample = assets.body.find((asset) => asset.location?.coordinates?.latitude);
const assetDetail = await get(`/public/assets/${encodeURIComponent(sample.asset_code)}`);
assert(assetDetail.response.ok, `GET /public/assets/:code failed (${assetDetail.response.status})`);
assert(assetDetail.body?.asset_code === sample.asset_code, 'asset detail code mismatch');

const incidents = await get('/public/incidents?limit=100');
assert(incidents.response.ok, `GET /public/incidents expected 2xx, got ${incidents.response.status}`);
assert(Array.isArray(incidents.body), 'GET /public/incidents must return an array');
for (const incident of incidents.body.slice(0, 10)) {
  assert(typeof incident.id === 'string', 'incident id missing');
  assert(typeof incident.title === 'string', 'incident title missing');
  assert(typeof incident.severity === 'string', 'incident severity missing');
  assert(incident.public_visible !== false, 'public incident list leaked an invisible record');
}

const map = await get('/map/config');
assert(map.response.ok, `GET /map/config expected 2xx, got ${map.response.status}`);
assert(typeof map.body?.tileUrl === 'string', 'map tileUrl missing');
assert(typeof map.body?.attribution === 'string', 'map attribution missing');
assert(
  map.body.tileUrl.includes('{z}') && map.body.tileUrl.includes('{x}') && map.body.tileUrl.includes('{y}'),
  'map tile template is invalid',
);

const notFound = await get('/public/incidents/DOES-NOT-EXIST');
assert(notFound.response.status === 404, 'unknown public incident must be 404');

const emergency = await get('/emergency');
assert(emergency.response.status === 404, 'City gateway must not expose the SOS emergency namespace');
assert(emergency.body?.error === 'not_found', 'City foreign namespace must return error=not_found');

const boundary = await fetch('https://synapsecity.sbs/v1/hazards', {
  headers: { Accept: 'application/json' },
  signal: AbortSignal.timeout(20_000),
});
assert(boundary.status === 404, 'City gateway must not expose hazards');

console.log(
  JSON.stringify(
    {
      api: API,
      product: product.body.product,
      version: product.body.version,
      assets: assets.body.length,
      incidents: incidents.body.length,
      sampleAsset: sample.asset_code,
      map: map.body.provider,
      boundary: 'ok',
      failures,
    },
    null,
    2,
  ),
);
