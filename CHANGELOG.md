# Changelog

All notable changes to SynapseCity are documented here. Entries follow the
Keep a Changelog format and version tags use Semantic Versioning.

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
