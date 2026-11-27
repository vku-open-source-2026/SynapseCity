<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/console/public/brand/logo-lockup-dark.png">
    <img src="apps/console/public/brand/logo-lockup-light.png" width="420" alt="SynapseCity">
  </picture>
</p>

# SynapseCity — city infrastructure operations (Tier 3)

## OLP 2026 demo

A reproducible 15-minute DX-Lab story lives in [`docs/DEMO_PACK.md`](docs/DEMO_PACK.md). Seed/reset with `npm run demo:seed` and `npm run demo:reset` (requires `CITY_DEMO_TOKEN`).


![CI](https://github.com/vku-open-source-2026/SynapseCity/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/vku-open-source-2026/SynapseCity/actions/workflows/release.yml/badge.svg)

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
apps/gateway        public HTTPS API boundary and console proxy (Rust/Axum, port 8080)
apps/city-service   city infrastructure domain backend (port 8083)
apps/console        city operations console
apps/contribution-service  public data-contribution backend (contribution.synapsecity.sbs)
apps/contribution-console  public data-contribution UI
infra/              public-edge snippets and deployment material
```

Dependency direction:

```text
SynapseCity -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne
```

The service is configured with `https://synapsedx.sbs` and calls the Tier-2
capabilities API. It has no database, queue connection or direct SynapseOne
client. Domain records are created through the Tier-2 records API; public
projections are read through Tier-2 SynapseLDS publication. `/v1/geo` calls the
shared Tier-2 geocoder by default; `/v1/map` and `/v1/ai` are City-owned
instances. None of them proxy SOS.

## Features

- infrastructure asset registry, GIS geometry, lifecycle and health;
- city infrastructure incidents and citizen reports;
- IoT sensor metadata, readings and status;
- maintenance work orders, preventive maintenance and the technician portal;
- infrastructure alerts;
- budgets and budget transactions;
- operational reports;
- city operators and user administration;
- public data-contribution portal (submissions, moderation, organization-filtered
  leaderboard, CSV export, map proxy);
- geofences and CSV/data ingestion;
- public asset map, public asset lookup and public incident reporting;
- map tiles, geocoding, reverse geocoding, nearby and polygon search;
- AI capability instance for City.

Not owned by this repository: hazards and VNDMS, emergency events, EOP,
dispatch, emergency resource units, SITREP, AAR, live hazard streaming, the
emergency command centre and the public hazard map. Those are SynapseCitySOS
features.

## Contribution portal

The public data-contribution portal is served at
**https://contribution.synapsecity.sbs** by `apps/contribution-service` (Rust/Axum)
and `apps/contribution-console` (React/Vite). It supports infrastructure feature
submissions, administrator moderation, CSV export, map configuration/tiles, and a
legacy citizen SOS intake that is not an emergency-operations API.

The leaderboard's organization dropdown is a **client-side filter**. The console
fetches `GET /api/leaderboard`, builds “Tất cả tổ chức” plus the organizations
present in the returned `unit` values, and uses `VKU` for missing/empty units. The
top three and table ranks restart at 1 within the selected organization, and an
organization-specific empty state is shown when there are no matching rows. The
API still returns all units and accepts no organization query parameter.

The complete public API reference—including every Rust route, admin Bearer and
sync-secret authentication, request validation, response schemas, status codes,
and fixed-window rate limits—is available in
[English](docs/CONTRIBUTION_API.md) and
[Tiếng Việt](docs/vi/CONTRIBUTION_API.md). The service-specific route inventory
and leaderboard schema are in
[`apps/contribution-service/README.md`](apps/contribution-service/README.md).

> **Tiếng Việt:** Xem [tài liệu tham khảo API đầy đủ bằng tiếng Việt](docs/vi/CONTRIBUTION_API.md)
> hoặc [tiếng Anh](docs/CONTRIBUTION_API.md) để biết mọi tuyến, quy tắc xác thực,
> kiểm tra yêu cầu, schema phản hồi, mã trạng thái và giới hạn tốc độ.

## Android app and home-screen widget

The `mobile/` directory contains the SynapseCity Android client and a native
4×3 home-screen widget. It talks directly to `https://synapsecity.sbs/v1`:
nearby asset radar/map (GPS), QR/NFC asset lookup, public incident reporting,
optional operator alerts, and a widget with nearest asset, status, mini-map,
scan and refresh actions. The UI is light-first, using the production web
console's teal/white palette. See [`mobile/README.md`](mobile/README.md) and the
verification record in [`docs/MOBILE_AUDIT.md`](docs/MOBILE_AUDIT.md).

```bash
cd mobile
npm ci
npm run typecheck && npm test
npm run verify
npm run build:android
```

Release APK (public, served from Tier-1 SynapseOCS through Tier-2):
<https://synapsedx.sbs/v1/capabilities/public/files/synapsecity-android-0.1.1-arm64-x86_64/content>

GitHub release: <https://github.com/vku-open-source-2026/SynapseCity/releases/tag/mobile-v0.1.1>

SHA-256: `dce9b691ef578d81370b86d7ef767b3eb12aa96e7c149cd7001698a6c0515aa5`

> **Resolved (verified 2026-11-16):** production public asset-detail lookup by
> asset code (`GET /v1/public/assets/:code`) returns `200`; the service tries
> the record id first and then falls back to the asset/feature code. The
> earlier 0.1.1 APK note is kept only for release history.

CI builds an unsigned APK; the production release job signs it with the
protected keystore and publishes it through the Tier-2 files capability. See
[`mobile/RELEASING.md`](mobile/RELEASING.md).

## Run

The Tier-2 client is published on npm as
`@synapsedx/capabilities@^0.3.0`, so a clean clone builds without a sibling
SynapseDX checkout:

```bash
npm ci
npm run check:release
npm run build
SYNAPSEDX_BASE_URL=https://synapsedx.sbs npm run start:service
```

`npm run start:service` runs the production Rust service
(`cargo run` in `apps/city-service`, the same binary the Dockerfile ships).
The legacy TypeScript server is test-only: `npm run start:service:legacy`.

`npm run check:release` verifies that the dependency is a registry semver
release and rejects `file:`/sibling-checkout dependencies.

Console development:

```bash
npm run dev --workspace=@synapsecity/console
```

The production stack is reproducible with `docker compose up -d --build`; the
Docker build installs the published npm package and needs no sibling repository.

## Self-host

Every release publishes three Apache-2.0 images to the public GitHub Container
Registry (no registry login required):

- `ghcr.io/vku-open-source-2026/synapsecity-city-service`
- `ghcr.io/vku-open-source-2026/synapsecity-gateway`
- `ghcr.io/vku-open-source-2026/synapsecity-console`

> If `docker pull` returns `unauthorized`, the GHCR packages have not been
> switched to public yet. An organization admin must add a `GHCR_PAT` secret
> (package admin) and run the `packages-public` workflow in the SynapseOne
> repository once.

City is Tier 3: point `SYNAPSEDX_BASE_URL` at a Tier-2 SynapseDX deployment and
set a scoped `SYNAPSEDX_API_KEY` issued for this product account. The default
`https://synapsedx.sbs` is the public demo.

### 1. Run the published images (recommended)

```bash
git clone https://github.com/vku-open-source-2026/SynapseCity.git
cd SynapseCity
cp .env.example .env       # set SYNAPSEDX_BASE_URL / API key and AUTH_SECRET
export SYNAPSECITY_VERSION=v0.3.0   # or latest

docker compose pull
docker compose up -d --no-build
curl http://127.0.0.1:8085/health
```

The gateway is bound to loopback; terminate TLS at your own edge and proxy
`/v1` to the gateway (see `infra/nginx/synapsecity.conf`).

### 2. Build from source

Requirements: Node.js 20+, Docker Engine 24+ and Compose v2.24+.

```bash
git clone https://github.com/vku-open-source-2026/SynapseCity.git
cd SynapseCity
cp .env.example .env
npm ci
npm run check:release
npm run build
npm test
docker compose build
docker compose up -d --no-build
```

`docker compose up -d --build` combines the last two steps. Local builds use
the same GHCR image names, so `pull` and `build` are interchangeable.

### Legacy OpenInfra data migration (removed)

The `import:openinfra` script and its `../nhan_tmp_data` export source have
been removed: the `openinfra/` checkout is not a deployment source and must
not be recreated, and the default data directory no longer exists outside the
repository. Records imported before the removal live on in the `city-*`
Tier-2 datasets; new demo data comes from `npm run demo:seed`, which writes
through the public City API only.

## API

### Public open API (documented at `/docs`)

Only the read-only public projection is public:

```text
GET  /v1/public/assets
GET  /v1/public/assets/:code
GET  /v1/public/assets/:code/qr-code
GET  /v1/public/assets/:code/maintenance-summary
GET  /v1/public/incidents
GET  /v1/public/incidents/:incidentId
POST /v1/public/incidents/drafts
POST /v1/public/incidents
POST /v1/public/incidents/:incidentId/photos
POST /v1/public/files
GET  /v1/public/files/:id/content
```

These routes are anonymous and expose only published/`public_visible` records.
Pre-report photos use a two-phase flow: `POST /v1/public/incidents/drafts`
validates the complete report and returns a 30-minute draft upload capability;
`POST /v1/public/files` requires that capability (or a report edit capability),
keeps draft files private, caps each draft/report at 10 photos, and expired
unbound draft uploads are swept on later draft creation. The final report must
present the same body-bound draft capability, which atomically binds each photo
to the new report before it becomes public. Category, severity and Point
location/address input are validated server-side. `POST /v1/public/incidents`
returns a one-time `edit_token` to the creator; photo appends require it plus a
Turnstile token, accept only public file ids uploaded for that report, and cap
the total at 10 photos. External URLs and unbound public uploads are rejected.
The response is a stable City JSON object, **not** NGSI-LD: assets return
`{ id, asset_code, name, feature_type, feature_code, category, status,
location: { address, coordinates?, geometry? }, qr_code, public_url }`.
`location.coordinates` is omitted (not `null`) when the asset has no usable
point. Incidents return the public projection with reporter contact details,
internal comments and assignee identity removed. Soft-deleted, decommissioned and
`public_visible:false` assets are excluded from every public route, including
the QR-code and maintenance-summary lookups. `maintenance-summary` exposes
aggregate counts and the last completed maintenance type only; public pages
never call the private maintenance namespace.

The public documentation intentionally omits every operator, auth/session, CRUD
and administrative endpoint.

### Internal console API (not public, not documented at `/docs`)

The gateway also owns the console/operator namespaces below. They are internal
product APIs, not part of the open-data contract:

```text
GET  /health, /ready
GET  /v1/city
*    /v1/assets          *    /v1/incidents
*    /v1/maintenance     *    /v1/preventive-maintenance
*    /v1/files           *    /v1/hitl
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

### Authorization

Operator namespaces are not a supported public client surface after the
public-only migration; their work interfaces live in SynapseDX. The gateway
still rejects an operator request without an `Authorization` header before
proxying, and the service independently verifies a legacy session and the
role-derived permission when one is presented. Deny-by-default: an unknown
operator action requires a valid session and then returns `404`.

| Permission | admin | manager | technician | volunteer | citizen |
| --- | --- | --- | --- | --- | --- |
| `assets:read` / `assets:write` | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / – | – / – |
| `incidents:read` / `incidents:write` / `incidents:verify` | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ / – / – | ✓ / – / – | – / – / – |
| `maintenance:read` / `maintenance:write` / `maintenance:approve` | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | ✓ / ✓ / – | – / – / – | – / – / – |
| `approvals:read` / `approvals:decide` | ✓ / ✓ | ✓ / ✓ | – / – | – / – | – / – |
| `iot:read` / `iot:write` | ✓ / ✓ | ✓ / ✓ | ✓ / – | – / – | – / – |
| `alerts:read` / `alerts:write` | ✓ / ✓ | ✓ / ✓ | ✓ / – | – / – | – / – |
| `budgets:read` / `budgets:write` / `budgets:approve` | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | – / – / – | – / – / – | – / – / – |
| `reports:read` / `reports:write` / `reports:generate` | ✓ / ✓ / ✓ | ✓ / ✓ / ✓ | – / – / – | – / – / – | – / – / – |
| `notifications:read` / `notifications:write` | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / – | – / – |
| `files:read` / `files:write` | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | ✓ / – | – / – |
| `users:read` / `users:admin` | ✓ / ✓ | ✓ / – | – / – | – / – | – / – |
| `geofences:read` / `geofences:write` | ✓ / ✓ | ✓ / ✓ | – / – | ✓ / – | – / – |
| `ingest:write` | ✓ | ✓ | – | – | – |
| `geo:read` / `ai:use` | ✓ / ✓ | ✓ / ✓ | ✓ / – | ✓ / – | – / – |

`/v1/users/me` requires a session but no additional permission. A technician
only sees work orders assigned to their own principal. Maintenance
`approve`/`reject` actions require `maintenance:approve`; technicians cannot
approve their own work, and production approval always requires an approved
HITL decision even when `CITY_HITL_REQUIRED` is false. Anonymous surfaces are
`/health`, `/ready`, `/metrics` (optional token), `/v1/city`, `/v1/auth/*`
(which returns `410`), `/v1/public/*`, `/v1/map/*` and the anonymous assistant
routes `/v1/ai/status` + `/v1/ai/chat` (public map widget; shared `public-ai`
per-IP budget, default 20/min via `PUBLIC_AI_RATE_LIMIT`).

`/v1/users` requires a Bearer session and never accepts, stores or returns
password fields.

**Tier-3 auth is retired (2026-11-14 workspace contract).** Every
`/v1/auth/*` request returns `410` with
`{ "error": "workspace_moved", "workspace_url": "https://synapsedx.sbs/workspace" }`
before credential handling. Login, registration, session management and role
assignment belong to SynapseDX. The remaining session code is reachable only in
non-production test runs via `TIER3_AUTH_MODE=legacy`; production always ignores
that variable and answers 410. Remove the code with the Rust migration.

Autocomplete, forward geocoding and reverse geocoding use the shared,
provider-neutral Tier-2 `geo` capability by default (`CITY_GEO_PROVIDER=tier2`);
City holds no provider key on that path. `CITY_GEO_PROVIDER=vietmap` is an
explicit legacy opt-in for map **tiles** (`VIETMAP_API_KEY`,
`VIETMAP_TILE_STYLE=tm|lm|dm|hm|st`); the key is never sent to the browser. A
Tier-2 provider outage is surfaced as `503 geocoder_unavailable`, not hidden by
a silent fallback (`CITY_GEO_FALLBACK_VIETMAP=true` opts into one).

### Reports, files, AI and notifications

- Operational reports are generated synchronously into real **CSV** or **JSON**
  bytes from City assets, incidents and maintenance. The bytes are stored on the
  report record and `GET /v1/reports/:id/download` streams them with the correct
  content type and `Content-Disposition`. `pdf`/`excel` return
  `415 unsupported_report_format`. The synchronous decision and the conditions
  for adopting the Tier-2 runner are documented in [`docs/REPORTS.md`](docs/REPORTS.md).
- Photos and documents are uploaded through the Tier-2 **files** capability
  (Tier-1 object storage):
  - `POST /v1/files/upload` (raw bytes) and `PUT /v1/files/:id/content` (proxy
    upload) store the bytes in Tier-1 and keep only metadata in `city-files`;
  - `POST /v1/files` starts a create/presign flow, `POST /v1/files/:id/presign`
    returns a signed URL when the backend supports it (otherwise
    `501 presign_unsupported`), and `POST /v1/files/:id/complete` finalizes it;
  - `GET /v1/files/:id/content` streams the object and
    `GET /v1/public/files/:id/content` serves public report photos;
  - MIME allow-lists, size limits (`CITY_FILES_MAX_BYTES`,
    `CITY_PHOTO_MAX_BYTES`), SHA-256 checksums and owner/tenant checks are
    enforced before any Tier-2 write. `data:` URLs and inline base64 are
    rejected (`415`).
- `/v1/ai/status` and `/v1/ai/chat` proxy the Tier-2 AI capability
  (`ai.status`/`ai.chat`). Missing provider or contract returns a typed 503 and
  the widget shows the error; no canned answer is ever returned.
- Notifications are produced on real City transitions (citizen report, incident
  assignment/resolution, critical/high alert, work-order assignment/completion,
  report ready) and delivered **in-app** through the `city-notifications`
  projection. When `CITY_NOTIFY_EXTERNAL=true`, the same event is sent through
  the Tier-2 `notifications` capability using City templates, the recipient's
  City profile addresses, an idempotency key and Tier-2 preferences; each
  channel's receipt is stored on the projection. With no configured channel the
  status is `not_configured`, never `delivered`.

### Abuse controls and observability

`/v1/auth/*`, anonymous reporting, public reads, the anonymous assistant
and operator-sensitive writes (budgets approve, HITL decide, users) are rate
limited (`429` with `Retry-After`): public reports default to
40/10min, public reads to 300/min, `/v1/ai/*` to 20/min (`PUBLIC_AI_RATE_LIMIT`)
and operator-sensitive paths to 120/min (`OPERATOR_RATE_LIMIT`). The gateway
injects the TCP peer into `x-forwarded-for` when the header is absent, and the
service keys limiters on the last forwarded entry (falling back to the socket
peer, never a shared bucket).
Retried creates for operator incidents, maintenance, budget transactions,
IoT batch ingest and public reports may send `Idempotency-Key` (or
`X-Idempotency-Key`); the service replays the stored `201` body for 24h
instead of duplicating the record. Entries are scoped by authenticated subject
(or anonymous client address), method, path and request-body hash; reuse with a
different body in the same scope returns `409 idempotency_body_mismatch`, and a
per-scope singleflight lock prevents concurrent duplicate creates. Tier-2 has
no native upsert, so this is a process-local safety net; the follow-up is a
Tier-2 idempotent create/upsert.
When `TURNSTILE_SECRET_KEY` is configured, the Turnstile token
sent in `CF-Turnstile-Response` is verified server-side; `REQUIRE_TURNSTILE=true`
fails closed when the secret is missing. `/health` and `/ready` report
per-capability state (datasets/records, files, AI, notifications, identity,
geo and jobs),
`/metrics` exposes Prometheus-style counters (optionally protected by
`METRICS_TOKEN`), and requests emit structured JSON logs with the correlation
id.

### GIS analytics

`POST /v1/geo/coverage` computes coverage gaps by area and asset type with
population and open-incident weighting (see `apps/city-service/src/analytics.ts`
for the exact formula), and the console exposes it at `/admin/analytics`.

## Console

The City console is **public presentation only** (2026-11-14 workspace
contract). Login, registration, operations dashboards and the technician portal
moved to the Tier-2 SynapseDX workspace at `https://synapsedx.sbs/workspace`.
The console serves these public routes:

```text
/                              city landing
/about /docs                   product and API docs
/map                           public city asset map
/asset/$id                     public asset detail
/public/report                 citizen incident report
/public/report/$assetId        report about an asset
/public/incidents/$incidentId  public incident lookup
```

The retired paths `/login`, `/register`, `/admin/**`, `/technician/**` and
`/workspace/**` return `308` to `https://synapsedx.sbs/workspace` from the
console nginx and the public edge, and the console root route redirects
client-side. No local dashboard can be mounted from a deep link.

**Release gate (closed for representative operations, 2026-11-14):** all 28
workspace pages across City and SOS loaded in production DX with zero page,
console or HTTP errors; City incident and generic alert create/update executed
against production and the records were removed; SOS event, dispatch and
resource create/update also executed. Every one of the 107 forms was not
submitted individually; the remaining action gap is tracked in
`plugins/workflows/README.md`. Product-specific policy, approvals and pins stay
in the owning workflows.

Tier-3 work interfaces are product plugins in DX; their portable source
artifacts live in `plugins/` and are validated/synced with
`npm run plugins:check` and `docs/PLUGIN_SYNC.md`. The exact pre-migration route
source is archived under `plugins/source/` as reference, not built or executed.

`/v1/auth/*` answers `410 workspace_moved` (with `workspace_url`) before any
credential handling, so no Tier-3 session can be created. There is no
`/disaster` route and no `/admin/emergency-center` route. Never add hazard,
EOP, dispatch, SITREP, AAR or command-centre pages to this console.

## Public edge

The public edge routes `synapsecity.sbs` to the gateway. The gateway proxies
`/v1` to `city-service` and serves the console for browser routes. See
`infra/nginx/synapsecity.conf`.

## DX-OS 2026

City is a Tier-3 domain application in the OLP 2026 DX-OS model: it owns city
assets, incidents, maintenance and budget rules, and consumes reusable H-P-D-I
capabilities from SynapseDX over the public API. It never imports the Tier-1
SDK or calls a Tier-1 service directly. The tier matrix, HITL contract and OLP
evidence checklist are in
[`SynapseDX/docs/DX_OS_TIER_MODEL_2026-11-04.md`](https://github.com/vku-open-source-2026/SynapseDX/blob/main/docs/DX_OS_TIER_MODEL_2026-11-04.md).

## PoF project checklist

- Source license: Apache-2.0 (`LICENSE`) with per-source SPDX headers and attribution in `NOTICE`.
- Data license: **PDDL 1.0** (Open Data Commons Public Domain Dedication and License) for published City datasets.
- Build from source: `npm ci && npm run build` using Node.js 20+; Docker builds are reproducible with `docker compose build`.
- Issue tracker: [GitHub Issues](https://github.com/vku-open-source-2026/SynapseCity/issues).
- Change history: [`CHANGELOG.md`](CHANGELOG.md). Versioned release tags are published on GitHub.
- Dependency inventory: [`THIRD-PARTY.md`](THIRD-PARTY.md); dependencies are not modified or bundled into the repository.

## Brand

Logo, icon and social-preview assets live in [`apps/console/public/brand`](apps/console/public/brand). The console serves the favicon, web app manifest and icons from `apps/console/public`.

To set the GitHub repository social preview, upload [`apps/console/public/brand/social-preview.png`](apps/console/public/brand/social-preview.png) in **Settings → Social preview**.
