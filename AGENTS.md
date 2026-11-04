# SynapseCity — Tier 3 city infrastructure product

SynapseCity owns city infrastructure operations. Read
[`PRODUCT_BOUNDARY.md`](PRODUCT_BOUNDARY.md) before changing code, routes, APIs
or datasets. When working in the workspace, the workspace-level
`FEATURE_BOUNDARY.md` is authoritative.

The repository is split into product parts:

- `apps/gateway`: public API boundary and console proxy;
- `apps/city-service`: Tier-3 city infrastructure backend;
- `apps/console`: city operations console;
- `infra`: edge/deployment files.

## Dependency contract

- Import the Tier-2 `@synapsedx/capabilities` client from
  `../SynapseDX/sdks/capabilities-js` during this workspace build; releases must
  resolve the same package from the npm registry.
- Default Tier-2 URL is `https://synapsedx.sbs`. Set `SYNAPSEDX_BASE_URL` only
  to another public HTTPS endpoint. Do not call SynapseOne, a private service
  port, localhost or a database from this repository.
- Persist city records through the Tier-2 records API. Read public projections
  through the Tier-2 publication/entity API. Queueing and persistence remain
  owned by Tiers 1 and 2.
- Do not call, import or proxy SynapseCitySOS. A link to
  `https://sos.synapsecity.sbs` is public navigation only.
- Do not add cross-product imports or API calls anywhere in the workspace.

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

`/v1/auth/*` is a stateless HMAC session shell for the console. It stores no
passwords and creates no shared user/session table. Production identity must be
delegated to the Tier-1 IAM/API gateway; `AUTH_SECRET` is optional and falls
back to an ephemeral start-up secret with a warning. `/v1/users` requires a City
session and must never accept, store or return password fields. The demo shell
accepts any non-empty credentials, so do not expose it directly to the Internet.

## Dataset ownership

Use only `city-*` datasets:

```text
city-assets                 city-incidents
city-maintenance            city-iot-sensors
city-iot-readings           city-alerts
city-budgets                city-budget-transactions
city-reports                city-notifications
city-users                  city-geofences
city-ingest-jobs
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

Never add `/disaster`, `/admin/emergency-center*` or any hazard, EOP, dispatch,
SITREP, AAR or command-centre page. `routeTree.gen.ts` must contain only owned
routes.

## Commands

```bash
npm ci
npm run build
npm test
npm run start:service                              # city service
npm run dev --workspace=@synapsecity/console       # console dev server
docker compose up -d --build                       # production stack
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
