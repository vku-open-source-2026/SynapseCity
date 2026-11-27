# SynapseCity — Tier 3 city infrastructure product

SynapseCity owns city infrastructure operations. Read
[`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md) before changing code, routes, APIs
or datasets. When working in the workspace, the workspace-level
`FEATURE_BOUNDARY.md` is authoritative.

The repository is split into product parts:

- `apps/gateway`: public API boundary and console proxy (Rust/Axum);
- `apps/city-service`: Tier-3 city infrastructure backend;
- `apps/console`: city operations console;
- `apps/contribution-service`: Rust backend for the public contribution portal;
- `apps/contribution-console`: React UI for the contribution portal;
- `infra`: edge/deployment files.

## Dependency contract

- Import the Tier-2 `@synapsedx/capabilities` client from the public npm
  registry (`^0.3.0` or later). Do not use a `file:` sibling checkout or a
  vendored tarball. `npm run check:release` enforces a registry semver range.
- Default Tier-2 URL is `https://synapsedx.sbs`. Set `SYNAPSEDX_BASE_URL` only
  to another public HTTPS endpoint. Do not call SynapseOne, a private service
  port, localhost or a database from this repository.
- Persist city records through the Tier-2 records API. Read public projections
  through the Tier-2 publication/entity API. Queueing and persistence remain
  owned by Tiers 1 and 2.
- Do not call, import or proxy SynapseCitySOS. A link to
  `https://sos.synapsecity.sbs` is public navigation only.
- Do not add cross-product imports or API calls anywhere in the workspace.
- **Contribution Tier-2 (2026-11-26):** `apps/contribution-service` persists
  through Tier-2 (`synapsedx` Rust SDK, `city-contribution-*` datasets) at
  `https://synapsedx.sbs`. Direct Tier-1 (`synapseone`, `contribution_*`
  collections) is legacy migration/rollback only (`STORAGE_BACKEND=base`).
  No other City app may call Tier 1 directly.

## Contribution portal

The public data-contribution portal at `https://contribution.synapsecity.sbs`
is owned by this repository. It was migrated from the OpenInfra reference
implementation; the `openinfra/` checkout has been removed and must not be recreated.

- Backend: `apps/contribution-service` (Rust/Axum).
- UI: `apps/contribution-console` (React/Vite).
- Compose: services `contribution-service` and `contribution-console` in
  `docker-compose.yml`; aliases `contribution-backend` and
  `contribution-frontend` on the shared edge network.
- Env prefix: `CONTRIBUTION_*` in `.env` / `.env.example`.
- Data: `city-contribution-features`, `city-contribution-submissions`,
  `city-contribution-sos-reports` (Tier-2 datasets, PDDL-1.0). Legacy
  `contribution_*` Tier-1 collections are migration/rollback only.
- The portal may collect public citizen infrastructure submissions and SOS
  reports, but it is **not** the SOS operations product. It must not add
  dispatch, EOP, SITREP, AAR, hazard feeds or emergency command-centre
  features. SOS operations remain in SynapseCitySOS.

## Feature ownership

Owned: assets/GIS/lifecycle/health, city incidents and citizen reports, IoT
sensors and readings, maintenance/work orders/technician portal, infrastructure
alerts, budgets/transactions, operational reports, city operators, geofences,
CSV/data ingest, public asset map, public incident lookup, map/geocode/AI for
this product.

Not owned: hazard feeds (including VNDMS), emergency events, EOP, dispatch,
emergency resource units, SITREP, AAR, live hazard SSE, emergency command
centre/phase boards/rescue operations, public hazard map. Never add these
modules, routes, types or datasets here.

## API namespace ownership

The contribution portal is a separate public surface on
`https://contribution.synapsecity.sbs` (`/api/*`). It does not add routes to the
`/v1/city` operations API.

Owned:

```text
GET  /health, /ready
GET  /v1/city
*    /v1/assets        *    /v1/incidents
*    /v1/maintenance   *    /v1/iot
*    /v1/preventive-maintenance
*    /v1/files         *    /v1/hitl
*    /v1/auth
*    /v1/alerts        *    /v1/budgets
*    /v1/reports       *    /v1/notifications
*    /v1/users         *    /v1/geofences
*    /v1/geo           *    /v1/ingest
*    /v1/map           *    /v1/ai
GET  /v1/public/assets
GET  /v1/public/incidents
```

The gateway must return `404` with `{ "error": "not_found" }` for
`/v1/emergency*`, `/v1/hazards*` and `/v1/sos*` before proxying. `/v1/users` is
City operator administration; it is never an SOS identity source.

Tier-3 login/session management is retired. Every `/v1/auth/*` path answers
`410 workspace_moved`; login, registration and sessions belong to SynapseDX.
City stores no password or shared identity table. `/v1/users` is City operator
administration and must never accept, store or return password fields.

Every operator namespace requires a session **and** a role-derived permission
(`assets:write`, `budgets:approve`, `files:write`, `users:admin`, ...). Deny by
default; a missing session is `401` and a missing permission is `403`. Keep the
permission matrix in `README.md` and the tests in `authz.test.ts` in sync when
adding a route.

## Dataset ownership

Use only `city-*` datasets:

The contribution portal uses the legacy `contribution_*` SynapseBase
collections; those are an explicit exception, not `city-*` datasets. Do not
reuse them from `city-service`. Migration target: `city-contribution-*`
datasets through Tier 2.

```text
city-assets                 city-incidents
city-maintenance            city-iot-sensors
city-iot-readings           city-alerts
city-budgets                city-budget-transactions
city-reports                city-notifications
city-users                  city-geofences
city-ingest-jobs            city-files
```

Never read or write a `sos-*` dataset. Keep the start-up prefix guard and its
test when adding datasets. Register every City dataset with the `PDDL-1.0` data
license; source code remains Apache-2.0. Only `city-assets` and `city-incidents`
are public projections; `city-users` and every operational dataset must stay
private and must not be published to the open-data layer.

## Console route ownership

Tier 3 is **public presentation only** (2026-11-14 workspace contract). Keep:
`/`, `/about`, `/docs`, `/map`, `/asset/$id`, `/public/report`,
`/public/report/$assetId`, `/public/incidents/$incidentId`.

Retired work surfaces redirect to `https://synapsedx.sbs/workspace`:
`/login`, `/register`, `/workspace/**`, `/admin/**`, `/technician/**`. They
return `308` from `apps/console/nginx.conf` and `infra/nginx/`, and the root
route redirects client-side. Retired route modules exist only as redirect
stubs (immediate client-side redirect to the DX workspace) or static
retirement notices — never mount a local dashboard, login form or technician
portal again.
Every `/v1/auth/*` path answers `410 workspace_moved`; there is no legacy
session surface. DX owns login and sessions.

**Release gate (closed for representative operations, 2026-11-14):** the
redirects are deployed after production DX verification of all 28 pages and
representative City/SOS create/update flows. Individual form coverage and the
remaining action gap are tracked in `plugins/workflows/README.md`; do not
re-open a local dashboard to work around a missing binding.

Work interfaces are product plugins in DX; portable bundles live in `plugins/`
with `npm run plugins:check` / `npm run plugins:test` and
`docs/PLUGIN_SYNC.md`. Pre-migration route source is archived (not built) in
`plugins/source/`. Never add `/disaster`, `/admin/emergency-center*` or any
hazard, EOP, dispatch, SITREP, AAR or command-centre page. `routeTree.gen.ts`
must contain only owned routes.

## Commands

```bash
npm ci
npm run check:release
npm run build
npm test
(cd apps/city-service && cargo run)                  # city service (production Rust binary)
npm run start:service:legacy                        # legacy TS reference server (tests only)
npm run dev --workspace=@synapsecity/console       # console dev server
npm run dev:contribution                           # contribution UI dev server
npm run build:contribution                         # contribution UI build
(cd apps/gateway && cargo test)                    # Rust gateway tests
(cd apps/city-service && cargo test)               # city backend tests (Rust + legacy TS)
(cd apps/contribution-service && cargo test)       # contribution backend tests
docker compose up -d --build                       # production stack
docker compose -p synapsecity up -d --no-deps --build contribution-service contribution-console
```

City-service note: the shipped backend is the Rust binary in
`apps/city-service` — `cargo run` in development, the Dockerfile entrypoint in
production. The Express server in `apps/city-service/src/server.ts` is kept
only as the behavioural reference for the test suite
(`npm run start:service:legacy`); it is never deployed. Because two backends
exist, a fix landed in only one of them reads as done while the other drifts -
implement API changes in the Rust service first, and keep the TS reference in
step (or record the divergence here) when its tests cover the same behaviour.

Before release, verify:

```bash
grep -rniE "emergency|hazard|eop|dispatch|sitrep|after.?action" \
  README.md AGENTS.md PRODUCT_BOUNDARY.md apps/console/README.md
```

Every match must be an explicit not-owned statement or a public navigation
link. Also check that no source file imports SOS modules or calls SOS APIs.

## Release order

1. SynapseOne and its SDK at `https://api.synapseone.space`.
2. SynapseDX capabilities SDK/API at `https://synapsedx.sbs`.
3. SynapseCity at `https://synapsecity.sbs`, configured with the public Tier-2
   URL.

SynapseCity does not wait for SynapseCitySOS and must not depend on it.

## Project identity

- Team: VKU.VIC.
- Members: Ho Sy Bao Nhan; Tran Thi Thuy Duong; Vo Thanh Nam.
- Repository license: Apache-2.0. Preserve `LICENSE` and `NOTICE` in all distributions.
