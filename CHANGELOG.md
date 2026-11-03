# Changelog

All notable changes to SynapseCity are documented here. Entries follow the
Keep a Changelog format and version tags use Semantic Versioning.

## [Unreleased] - 2026-11-03

### Changed

- Split SynapseCity from SynapseCitySOS. SynapseCity now owns only city
  infrastructure operations: assets/GIS/lifecycle/health, city incidents and
  citizen reports, IoT, maintenance and the technician portal, infrastructure
  alerts, budgets, operational reports, city operators, geofences, ingest, the
  public asset map and City map/geocode/AI.
- Renamed and documented the public boundary as `https://synapsecity.sbs`.
- Updated `README.md`, `AGENTS.md`, `MIGRATION.md`, `CONTRIBUTING.md`, the new
  `PRODUCT_BOUNDARY.md` and the console documentation to describe the split.

### Removed

- Foreign SOS console routes and pages: `/disaster` and
  `/admin/emergency-center*`, including phase boards and rescue operations.
- SOS API handlers, service modules, client functions, types and navigation
  entries from the City gateway, service and console.
- SOS datasets and seeds from the City configuration.

### Added

- Gateway guards that return `404` with `{ "error": "not_found" }` for foreign
  `/v1/emergency*`, `/v1/hazards*` and `/v1/sos*` namespaces before any
  upstream call.
- Service start-up guard and tests that reject any dataset without the `city-`
  prefix.
- `GET /v1/city` feature metadata that advertises owned City features and lists
  the SOS features as not owned.

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
