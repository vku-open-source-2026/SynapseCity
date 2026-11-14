# Changelog

All notable changes to SynapseCity are documented here. Entries follow the
Keep a Changelog format and version tags use Semantic Versioning.

## [Unreleased]

### Added
- Full City work-page catalog (14 portable bundles): operations command center,
  asset registry, incident desk, maintenance workshop, alert center, IoT
  network, budget office, report studio, GIS workspace, people directory, data
  ingest, manager review, technician work and volunteer desk. The catalog
  covers every non-public City role and mirrors the retired admin/technician
  surfaces with declarative widgets.
- Generic `city-workspace-actions` workflow dispatcher plus its checked-in
  generator. It supports allowlisted create/update/delete/execute actions for
  assets, incidents, maintenance, IoT sensors/readings, alerts, budgets,
  transactions, reports, users, geofences, ingest jobs, files and notifications
  through the Tier-2 records API with the organization technical credential.
- Portable City workspace plugin bundles under `plugins/` with
  `scripts/plugin-bundle.mjs` for strict validation, checksum verification and
  HTTPS DX export/import/sync (`docs/PLUGIN_SYNC.md`).
- Product-owned Tier-1 workflow artifacts under `plugins/workflows/` for
  incidents.create/assign/resolve and maintenance.create/assign/start/complete: create HTTP POST, transition GET(`includeInput:true`) → domain merge →
  conditional PATCH (`ifVersion`), AAR-before-event-close. Auth is the portable
  `synapsedx-organization` credentialRef; plugin bundles bind forms with
  `workflowRef`/action create|update. Source-ready and engine-tested, inactive
  until DX binds the credential/pins.
- `plugins/source/` preserves the exact pre-migration City route and page source
  (with revision and SHA-256 manifest) as reference; it is outside the build.

### Changed
- DX repository export is now published-only; a draft answers `409
  plugin_not_published`. `plugin-bundle.mjs sync` compares `source` provenance
  as well as the plugin checksum, so a path/repository-only change is written
  instead of being reported as `in-sync`.
- Tier 3 is public presentation only (2026-11-14 workspace contract). Login,
  registration, operations dashboards and the technician portal moved to
  `https://synapsedx.sbs/workspace`; `/login`, `/register`, `/admin/**`,
  `/technician/**` and `/workspace/**` return `308` (nginx and client root
  route). Public map, asset detail, public reports and contribution intake stay.
- `/v1/auth/*` answers `410 workspace_moved` with `workspace_url` before any
  credential handling; production ignores `TIER3_AUTH_MODE=legacy`.
- Mobile app: new Synapse logo system (app icon, adaptive/monochrome icon,
  splash, notification icon); Android version 0.1.1 (versionCode 2).
- The public gateway is now a Rust/Axum service (`apps/gateway/src/main.rs`);
  it keeps the existing City boundary, auth gate, console proxy, CORS,
  correlation-ID and binary-body behavior.

## [0.3.0] - 2026-11-10

### Added
- Public GHCR images for `city-service`, `gateway` and `console` with
  `vX.Y.Z`, `latest` and `sha-<commit>` tags, plus a self-host guide covering
  `docker compose pull` and building from source.

### Added

- `npm run import:openinfra` migrates the legacy JSON export through the Tier-2
  capabilities API. It imports assets, sensors and every master record in full,
  samples the unbounded readings/alerts collections, keeps reporter PII in the
  private incident sidecar, never writes password hashes, and resumes from a
  checkpoint. SOS-owned collections are explicitly skipped.

### Fixed

- Incident sidecars now use `internal-<incidentId>` because Tier-2 record ids
  are unique across datasets; the operator view still merges the sidecar and
  reads the legacy id as a fallback.
- IoT reading endpoints query Tier-2 by sensor/asset instead of loading the
  first 5000 records, so every sensor keeps its history after a large import.
- The public gateway forwards `x-total-count`, `etag`, `x-dataset-version` and
  `content-disposition`, restoring console pagination and download metadata.
- The public map and admin map load the complete asset inventory instead of the
  first 100/500 rows. The public projection accepts `include_inactive=true`
  (and still hides deleted/explicitly private records), so retired assets stay
  addressable by code and appear on the full map.
- Map markers use the real `feature_code`; the public projection previously
  assigned `asset_code` to that field, which made every marker fall back to one
  generic icon.
- Both the City map and the contribution portal cluster by screen cell at low
  zoom, show the total plus per-type counts, and reveal individual type icons
  at zoom 17+. Cluster/icon HTML is cached and the City map computes clusters
  from projected coordinates, so panning does not rebuild them.
- The admin map route now uses the shared `MapComponent` and the complete
  `getAssets` query instead of a duplicate renderer capped at 100 records.

## [Unreleased] - 2026-11-07

### Fixed
- Console UI audit: removed fabricated map online/offline status, escaped
  Leaflet popup text, removed the fake VNeID flow, wired the incident/alert
  filters, fixed list pagination via `x-total-count`, added the report-create
  action and query polling, replaced placeholder dashboard actions and the
  incorrect operational-rate KPI, preserved incident coordinates/map links,
  and removed internal tier/architecture copy from operator screens.

## [Unreleased] - 2026-11-06

### Fixed
- **Admin AI assistant on `/admin/map`**: public AI routes bypass the operator
  middleware, so `capabilitiesFromRequest` forwarded the City HMAC session
  token to Tier-2 and got `invalid_credential` (503). It now decodes the City
  session itself and forwards only the user-scoped Tier-2 token, falling back
  to the deployment service credential for anonymous callers. `/v1/ai/status`
  reports `ready` and `/v1/ai/chat` returns real model output for administrators.
- Desktop sign-in no longer offers biometric enrolment; WebAuthn is only
  exposed on mobile/tablet devices (iPadOS touch devices included).
- The login transition no longer loops `/v1/auth/refresh`: `ProtectedRoute`
  refreshes at most once per mount, so the rotating token cannot retrigger the
  effect.
- A 401 from a secondary endpoint (for example notifications) no longer clears
  the whole session or redirects to the landing page. Only auth-endpoint 401s
  invalidate a session, and they redirect to `/login`.
- “Bỏ qua” on the biometric setup screen now lands on `/admin` and stays there.
- The public citizen-map AI assistant now works without a City session:
  `/v1/ai/status` and `/v1/ai/chat` are proxied with the deployment's Tier-2
  service credential and protected by a per-IP limiter
  (`PUBLIC_AI_RATE_LIMIT`/`PUBLIC_AI_RATE_WINDOW_MS`, default 20/min), so the
  widget shows "AI sẵn sàng" and answers instead of the misleading
  "chưa khả dụng" message.

### Security
- `AUTH_SECRET` must be set in production: the service now fails fast instead
  of silently generating an ephemeral session secret (which would invalidate
  every session on restart).
- Rate limiting trusts the last `X-Forwarded-For` hop appended by the edge,
  not the client-controlled first entry.
- The console ships a Content-Security-Policy (self + Turnstile + map tiles)
  plus HSTS/nosniff/frame/referrer headers; the gateway adds the same security
  headers and sanitizes echoed correlation IDs.
- Public gateway ports are bound to 127.0.0.1; the public edge is the TLS
  nginx only.


### Fixed

- AI assistant works end-to-end through the published Tier-2 inference
  capability: the console probes `/v1/ai/status` and reflects ready /
  degraded / unavailable in the header pill and welcome message, sends
  authenticated requests through the shared axios client (the previous fetch
  never carried the Bearer token, so even signed-in users got 401), reads the
  `message` field the City service returns, and renders typed upstream errors
  with their dependency link. The dead WebSocket path is removed; the REST
  route is the published contract.

### Security

- The service now logs a loud production warning when `TURNSTILE_SECRET_KEY`
  is not configured, making it explicit that anonymous `/v1/public/*` report
  endpoints run without bot protection until the operator supplies the
  Cloudflare Turnstile secret (and optionally `REQUIRE_TURNSTILE=true`).

## [Unreleased] - 2026-11-05

### Changed

- Header links and buttons keep their place when the language changes, so a
  click lands on the intended item.
- Public website (home, about, open API docs, header, footer) is bilingual
  (Vietnamese / English) and supports light, dark and system themes. The
  home page no longer hotlinks a stock photo or shows a placeholder asset
  count when the API is unreachable.

### Added

- CI hardening: CodeQL, dependency review on pull requests, actionlint,
  CycloneDX SBOM artifact, npm audit gate, Dependabot, PR template and
  concurrency controls. Tier-2 HITL adoption is tracked in issue #30.

- Tier-2 files capability adoption: `POST /v1/files`, `POST /v1/files/upload`,
  `PUT /v1/files/:id/content`, `GET /v1/files/:id/content`,
  `POST /v1/files/:id/presign`, `POST /v1/files/:id/complete`,
  `DELETE /v1/files/:id`, `GET /v1/files/quota`, anonymous
  `POST /v1/public/files` and `GET /v1/public/files/:id/content`. Binary bytes
  live in Tier-1 storage through Tier-2; `city-files` keeps metadata only.
  MIME/size/checksum/owner checks are enforced before the write, and public
  photos are restricted to files explicitly marked public.
- Tier-2 notifications adoption: external email/SMS/push sends through
  `notifications.send` with deterministic City templates, variables,
  idempotency keys and Tier-2 preferences. Per-channel receipts are stored on
  the `city-notifications` in-app projection; unconfigured/suppressed channels
  are never reported as delivered. New producers: citizen report, work-order
  assignment, report ready, plus the existing assignment/resolution/alert ones.
  `GET/PUT /v1/notifications/preferences` and
  `GET /v1/notifications/:id/delivery` expose preference and receipt state.
- Tier-2 identity adoption: `CITY_AUTH_MODE=tier2` verifies credentials through
  the Tier-2 auth capability, keeps the Tier-1 token inside the City session,
  supports refresh/logout/password change and optional
  `CITY_AUTH_EXCHANGE` delegated tokens. City roles come from operator
  profiles or `CITY_BOOTSTRAP_ADMIN_EMAILS`, never from the request.
- Tier-2 geo adoption: address search/geocode/reverse use the shared
  provider-neutral `geo` capability by default; `CITY_GEO_PROVIDER=vietmap`
  remains an explicit legacy opt-in and fallback is disabled by default.
- `@synapsedx/capabilities@^0.3.0` from the public npm registry; the City
  service needs no sibling SynapseDX checkout or vendored tarball.
  `npm run check:release` enforces a registry semver dependency.
- `docs/REPORTS.md` documents why report generation stays synchronous and when
  to adopt the Tier-2 `report.generate` runner.

### Changed


### Security

- Every operator namespace now requires a signed City session and a role-derived
  permission. Anonymous operator requests return `401`; a session without the
  action permission returns `403`. The gateway also rejects operator requests
  without an `Authorization` header before proxying. The permission matrix is in
  `README.md` and enforced by `authz.test.ts`.
- Demo credential login is refused in production unless `AUTH_DEMO_MODE=true`.
  The demo role is `AUTH_DEMO_ROLE` server configuration; the request body can
  never choose a role or permission, and token permissions are always derived
  from the signed role.
- Logout revokes the presented access/refresh token. Console tokens are stored in
  tab-scoped `sessionStorage`; biometric metadata no longer persists bearer
  tokens in `localStorage`.
- Added fixed-window rate limits for `/v1/auth/*` and anonymous reporting, and
  server-side Turnstile verification when `TURNSTILE_SECRET_KEY` is set.
- `data:` URLs and raw base64 uploads are rejected. Attachments must reference
  Tier-2 file storage (`415 data_url_not_supported` / `503` capability error).

### Changed

- Changed the published City data license from CC-BY-4.0/OGL to **PDDL 1.0**
  (Open Data Commons Public Domain Dedication and License 1.0). Source code
  remains Apache-2.0.
- Split SynapseCity from SynapseCitySOS. SynapseCity now owns only city
  infrastructure operations: assets/GIS/lifecycle/health, city incidents and
  citizen reports, IoT, maintenance and the technician portal, infrastructure
  alerts, budgets, operational reports, city operators, geofences, ingest, the
  public asset map and City map/geocode/AI.
- Renamed and documented the public boundary as `https://synapsecity.sbs`.
- Updated `README.md`, `AGENTS.md`, `MIGRATION.md`, `CONTRIBUTING.md`, the new
  `PRODUCT_BOUNDARY.md` and the console documentation to describe the split.
- The documented public contract is a stable City JSON projection, not NGSI-LD.
  Soft-deleted, decommissioned and `public_visible:false` assets are excluded
  from every public route; public pages use `/v1/public/*` only, including a new
  aggregate maintenance summary.
- `city-incidents` now contains only the public projection. Reporter identity,
  contact data, internal comments and approval/assignee fields live in the
  private `city-incident-internal` sidecar and are redacted before the Tier-2
  write.
- Reports are generated as real CSV/JSON bytes and streamed from
  `/v1/reports/:id/download`; `pdf`/`excel` return `415` instead of a fake URL.
- Geo/list endpoints apply filters, pagination and totals server-side; nearby,
  bounds, polygon, distance and geofence tests use real geometry. Technicians are
  scoped to their own work orders.
- IoT readings are scoped by sensor and time window, statistics are computed,
  and asset IoT data matches the documented object contract. Sensor status is
  derived from the last reading; the console no longer fabricates telemetry or
  calendar entries.
- Preventive maintenance tasks are derived from plans and preventive work
  orders (upcoming/overdue).
- Critical/high alerts create one idempotent maintenance order on acknowledge,
  with a severity SLA and `source_alert_id`.
- AI status/chat proxy the Tier-2 AI capability; missing provider returns a typed
  503 and the widget shows the error instead of a canned answer.
- Incidents, alerts and maintenance transitions produce in-app notifications
  (deduplicated); external channels report `unsupported` until Tier-2 delivery
  lands.
- Health/readiness report per-capability state; `/metrics` and structured logs
  were added.
- Added GIS coverage analytics (`POST /v1/geo/coverage`) with
  population-weighted prioritisation and the `/admin/analytics` console page.

### Removed

- Foreign SOS console routes and pages: `/disaster` and
  `/admin/emergency-center*`, including phase boards and rescue operations.
- SOS API handlers, service modules, client functions, types and navigation
  entries from the City gateway, service and console.
- SOS datasets and seeds from the City configuration.
- No-op asset create/edit buttons and the fabricated dashboard telemetry,
  alerts and maintenance calendar.

### Added

- Gateway guards that return `404` with `{ "error": "not_found" }` for foreign
  `/v1/emergency*`, `/v1/hazards*` and `/v1/sos*` namespaces before any
  upstream call.
- Service start-up guard and tests that reject any dataset without the `city-`
  prefix.
- `GET /v1/city` feature metadata that advertises owned City features and lists
  the SOS features as not owned.
- Asset registration (`/admin/assets/create`) and edit
  (`/admin/assets/edit/$id`) console routes and forms.
- Tests for authorization (401/403/200 across roles), production demo-login
  refusal, public-projection redaction, geo predicates/coverage, reports, IoT,
  preventive maintenance, alert automation, notifications, rate limits,
  Turnstile, metrics and the new console routes.
- An explicit release check for the remaining `file:` Tier-2 dependency
  (`npm run check:release`).

### Fixed

- `apps/console/package-lock.json` is synchronized with `package.json`, so the
  console Docker image builds with `npm ci`.
- `/v1/users` now requires a Bearer session (admin role for operator
  administration), `/v1/users/me` returns the token principal, and passwords are
  never accepted, stored or returned. `city-users` is private and is never
  published.
- Added the City auth session shell (`/v1/auth/login|register|refresh|logout|
  change-password|me|verify`) with HMAC-SHA256 tokens and optional `AUTH_SECRET`.
- Added public asset/incident lookup, anonymous reporting and JSON photo upload.
- Added incident detail and workflow routes (comments, assign, resolve, close,
  reject, approve-cost, verify, merge, related, create-maintenance).
- Fixed static route ordering for `/v1/users/me`, `/v1/users/technicians`,
  `/v1/users/volunteers` and `/v1/maintenance/upcoming`.
- Added asset lifecycle, document, photo, health-score, report and soft-delete
  endpoints.
- Hardened console list handling with `asList`, an admin-map guard and a Vite
  `/v1` development proxy, so a 200 HTML response renders an empty/error state.
- Encoded `/v1` prefixes are rejected with JSON 404 and never reach the SPA.
- CSV ingest now parses asset rows and creates records through Tier-2; the
  leaderboard call and `leaderboardApi` were removed.
- SynapseCity PWA manifest and service-worker cache branding replace OpenInfra.
- The City API docs page lists only implemented endpoints at
  `https://synapsecity.sbs`.

## [0.1.0] - 2026-11-01

- Migrated the OpenInfra infrastructure console and domain API.
- Added public Tier-2 capability integration for city records.
- Added Apache-2.0 licensing and VKU.VIC attribution.
