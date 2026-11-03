# SynapseCity — city infrastructure operations (Tier 3)

SynapseCity is the city infrastructure product of the Synapse platform. It owns
the day-to-day lifecycle of physical infrastructure: assets and GIS data, city
incidents and citizen reports, IoT sensors, maintenance and technician work,
infrastructure alerts, budgets, operational reports, geofences and data
ingestion, city operators, and the public asset map.

The public product boundary is `https://synapsecity.sbs`. The API is served at
`https://synapsecity.sbs/v1`.

SynapseCity is a **sibling** of SynapseCitySOS (`https://sos.synapsecity.sbs`),
the emergency operations product. SynapseCity does not own hazard feeds,
emergency events, EOP, dispatch, emergency resource units, SITREP, AAR, the
emergency command centre or the public hazard map. A link to SOS is a public
HTTPS navigation link only; there is no City-to-SOS API call.

The authoritative matrix is the workspace `FEATURE_BOUNDARY.md` at the workspace
root. The repo-local summary is [`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md).

## Architecture

```text
apps/gateway        public HTTPS API boundary and console proxy (port 8080)
apps/city-service   city infrastructure domain backend (port 8083)
apps/console        city operations console
infra/              public-edge snippets and deployment material
```

Dependency direction:

```text
SynapseCity -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne
```

The service is configured with `https://synapsedx.sbs` and calls the Tier-2
capabilities API. It has no database, queue connection or direct SynapseOne
client. Domain records are created through the Tier-2 records API; public
projections are read through Tier-2 SynapseLDS publication. `/v1/geo`,
`/v1/map` and `/v1/ai` are City-owned instances and do not proxy SOS.

## Features

- infrastructure asset registry, GIS geometry, lifecycle and health;
- city infrastructure incidents and citizen reports;
- IoT sensor metadata, readings and status;
- maintenance work orders, preventive maintenance and the technician portal;
- infrastructure alerts;
- budgets and budget transactions;
- operational reports;
- city operators and user administration;
- geofences and CSV/data ingestion;
- public asset map, public asset lookup and public incident reporting;
- map tiles, geocoding, reverse geocoding, nearby and polygon search;
- AI capability instance for City.

Not owned by this repository: hazards and VNDMS, emergency events, EOP,
dispatch, emergency resource units, SITREP, AAR, live hazard streaming, the
emergency command centre and the public hazard map. Those are SynapseCitySOS
features.

## Run

Build the Tier-2 SDK first; the workspace-local dependency is intentional for
development:

```bash
cd ../SynapseDX/sdks/capabilities-js && npm install && npm run build
cd ../../SynapseCity && npm ci && npm run build
SYNAPSEDX_BASE_URL=https://synapsedx.sbs npm run start:service
```

Console development:

```bash
npm run dev --workspace=@synapsecity/console
```

The production stack is reproducible with `docker compose up -d --build`. For a
registry release, replace the `file:` dependency with the published
`@synapsedx/capabilities` version after the package has been released.

## API

### Public open API (documented at `/docs`)

Only the read-only NGSI-LD projection is public:

```text
GET /v1/public/assets
GET /v1/public/incidents
```

These are GET-only, require no API key and expose only published/`public_visible`
records. The public documentation intentionally omits every operator,
auth/session, CRUD and administrative endpoint.

### Internal console API (not public, not documented at `/docs`)

The gateway also owns the console/operator namespaces below. They are internal
product APIs, not part of the open-data contract:

```text
GET  /health, /ready
GET  /v1/city
*    /v1/assets          *    /v1/incidents
*    /v1/maintenance     *    /v1/preventive-maintenance
*    /v1/iot             *    /v1/alerts
*    /v1/budgets         *    /v1/reports
*    /v1/notifications   *    /v1/users
*    /v1/geofences       *    /v1/geo
*    /v1/ingest          *    /v1/map
*    /v1/ai              *    /v1/auth
POST /v1/public/incidents   (citizen report UI only)
```

`GET /v1/city` advertises the owned feature list and the not-owned SOS feature
list. Foreign namespaces `/v1/emergency*`, `/v1/hazards*` and `/v1/sos*`
return `404` with `{ "error": "not_found" }` before any handler or Tier-2 call.
The API intentionally does not expose generic platform primitives; those stay
behind SynapseDX and SynapseOne.

`/v1/users` requires a Bearer session. The City service ships a stateless
HMAC-SHA256 session shell for the console: it never validates or stores
passwords, `/v1/auth/*` issues signed access/refresh tokens, and `/v1/users/me`
returns the token principal. This is a demo identity adapter — production
identity must be delegated to the Tier-1 IAM service. Set `AUTH_SECRET` to keep
sessions across restarts; otherwise an ephemeral secret is generated at startup.

Map tiles, autocomplete, forward geocoding and reverse geocoding are proxied
through the City backend. Set `VIETMAP_API_KEY` and optionally
`VIETMAP_TILE_STYLE=tm|lm|dm|hm|st` in the server `.env`; the key is never sent
to the browser.

## Console

The City console serves these owned routes:

```text
/                              city landing
/about /docs                   product and API docs
/map                           public city asset map
/login /register               auth shell
/asset/$id                     public asset detail
/public/report                 citizen incident report
/public/report/$assetId        report about an asset
/public/incidents/$incidentId  public incident lookup
/admin                         city operations dashboard
/admin/map /admin/assets       internal map and asset registry
/admin/incidents /admin/alerts city incidents and infrastructure alerts
/admin/iot /admin/budgets      sensors and budgets
/admin/reports /admin/users    reports and city operators
/admin/ingest /admin/settings  ingestion and profile
/technician[/tasks|/maintenance|/settings] technician portal
```

There is no `/disaster` route and no `/admin/emergency-center` route. Never add
hazard, EOP, dispatch, SITREP, AAR or command-centre pages to this console.

## Public edge

The public edge routes `synapsecity.sbs` to the gateway. The gateway proxies
`/v1` to `city-service` and serves the console for browser routes. See
`infra/nginx/synapsecity.conf`.

## PoF project checklist

- License: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution in `NOTICE`.
- Build from source: `npm ci && npm run build` using Node.js 20+; Docker builds are reproducible with `docker compose build`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseCity/issues).
- Change history: [`CHANGELOG.md`](CHANGELOG.md). Versioned release tags are published on GitHub.
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md); dependencies are not modified or bundled into the repository.
