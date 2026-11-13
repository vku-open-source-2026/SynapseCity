# SynapseCity — Tier 3 city infrastructure product

SynapseCity owns city infrastructure operations. Read
[`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md) before changing code, routes, APIs
or datasets. When working in the workspace, the workspace-level
`FEATURE_BOUNDARY.md` is authoritative.

The repository is split into product parts:

- `apps/gateway`: public API boundary and console proxy;
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
- **Contribution exception:** `apps/contribution-service` currently uses the
  published `synapseone` Rust SDK from crates.io to read/write the `contribution_*` SynapseBase
  collections. This is a scoped legacy exception while those collections move
  to Tier-2 datasets. It must not be copied into `city-service`, the gateway or
  the console; no other City app may call Tier 1 directly.

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
- Data: `contribution_features`, `contribution_submissions`,
  `contribution_sos_reports` (legacy SynapseBase exception; target is Tier-2).
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

`/v1/auth/*` verifies credentials through the Tier-2 auth capability by default
(`CITY_AUTH_MODE=tier2`, Tier-1 IAM backed) and keeps the Tier-1 token inside the
signed City session. It stores no passwords and creates no shared identity or
session table. City roles come from City operator profiles or the
`CITY_BOOTSTRAP_ADMIN_EMAILS` allow-list, never from the request body or an
unverified claim. `CITY_AUTH_MODE=demo` is the explicit development-only shell
and is honoured only with `AUTH_DEMO_MODE=true`. `AUTH_SECRET` is optional and
falls back to an ephemeral start-up secret with a warning. `/v1/users` requires a
City session and must never accept, store or return password fields.

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

Keep: `/`, `/about`, `/docs`, `/map`, `/login`, `/register`, `/asset/$id`,
`/public/report`, `/public/report/$assetId`, `/public/incidents/$incidentId`,
`/admin`, `/admin/map`, `/admin/assets[/$id]`,
`/admin/incidents[/create|/$id]`, `/admin/alerts[/list]`,
`/admin/iot[/create|/$id]`, `/admin/budgets[/create|/$id]`,
`/admin/reports[/create]`, `/admin/users[/create|/$id]`, `/admin/ingest`,
`/admin/settings`, and `/technician[/tasks/$taskId|/maintenance/$id|/settings]`.

Asset registration (`/admin/assets/create`), asset editing
(`/admin/assets/edit/$id`) and GIS coverage analytics (`/admin/analytics`) are
City-owned routes. Never add `/disaster`, `/admin/emergency-center*` or any
hazard, EOP, dispatch, SITREP, AAR or command-centre page. `routeTree.gen.ts`
must contain only owned routes.

## Commands

```bash
npm ci
npm run check:release
npm run build
npm test
npm run start:service                              # city service
npm run dev --workspace=@synapsecity/console       # console dev server
npm run dev:contribution                           # contribution UI dev server
npm run build:contribution                         # contribution UI build
(cd apps/contribution-service && cargo test)       # contribution backend tests
docker compose up -d --build                       # production stack
docker compose -p synapsecity up -d --no-deps --build contribution-service contribution-console
```

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
