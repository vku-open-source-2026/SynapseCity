# SynapseCity — product boundary

Status: repo-local reference for the 2026-11-03 feature split. The authoritative
workspace contract is `FEATURE_BOUNDARY.md` at the workspace root (outside this
repository).

## Identity

| Field | Value |
| --- | --- |
| Product | SynapseCity |
| Tier | 3 |
| Domain | City infrastructure operations |
| Public URL | `https://synapsecity.sbs` |
| Console | `https://synapsecity.sbs` (served through the gateway) |
| Optional console alias | `https://cloud.synapsecity.sbs` (same console/gateway; operator-managed DNS/TLS) |
| API | `https://synapsecity.sbs/v1` |
| Sibling product | SynapseCitySOS at `https://sos.synapsecity.sbs` |
| License | Apache-2.0 (`LICENSE`, `NOTICE`, `THIRD-PARTY.md`) |

## Dependency contract

```text
SynapseCity -> @synapsedx/capabilities -> @synapseone/sdk -> SynapseOne
```

- Tier 2 only: `https://synapsedx.sbs`, through `@synapsedx/capabilities`.
- No `@synapseone/sdk` import, SynapseOne call, Tier-1 service access or Tier-2
  database access from this repository.
- No database, queue, cache or filesystem fallback. Domain records are written
  through the Tier-2 records API; public projections are read through the
  Tier-2 publication API.
- No call to SynapseCitySOS. A public HTTPS link to SOS is navigation only.

## Owned capabilities

- Infrastructure asset registry, GIS geometry, lifecycle and health.
- City infrastructure incidents and citizen incident reports.
- IoT sensor metadata, readings and status.
- Maintenance work orders, preventive maintenance and the technician portal.
- Infrastructure alerts.
- Budgets and budget transactions.
- Operational reports.
- City operators and user administration.
- Geofences and CSV/data ingestion.
- Public asset map, public asset lookup and public incident reporting.
- Map tiles, geocoding, reverse geocoding and nearby/polygon search.
- AI capability instance for this product.

## Not owned

SynapseCity does **not** own:

- flood, storm, landslide or other hazard feeds (including VNDMS live data);
- emergency events or public emergency projection;
- emergency operations plans (EOP);
- dispatch orders or responder assignment;
- emergency resource units;
- situation reports (SITREP) or deltas;
- after-action reports (AAR);
- the live hazard SSE stream;
- the emergency command centre, phase boards or rescue operation view;
- the public hazard/emergency map.

These belong to SynapseCitySOS. The only permitted reference is a public HTTPS
navigation link to `https://sos.synapsecity.sbs`; never an API call, shared
dataset or embedded data source.

## API namespace ownership

Owned:

```text
GET  /health, /ready
GET  /v1/city
*    /v1/auth
*    /v1/assets
*    /v1/incidents
*    /v1/maintenance
*    /v1/iot
*    /v1/alerts
*    /v1/budgets
*    /v1/reports
*    /v1/notifications
*    /v1/users
*    /v1/geofences
*    /v1/geo
*    /v1/ingest
*    /v1/map
*    /v1/ai
GET  /v1/public/assets
GET  /v1/public/incidents
```

Foreign namespaces must return HTTP `404` with `{ "error": "not_found" }`
before any handler or Tier-2 call:

```text
/v1/emergency*
/v1/hazards*
/v1/sos*
```

`GET /v1/city` advertises the owned features above and explicitly lists the
not-owned emergency features. `/v1/users` is City operator administration; it
is never an identity source for SOS responders. `/v1/users` requires a City
session; passwords are never accepted, stored or published.

### Auth shell

`/v1/auth/*` is a stateless HMAC-SHA256 session shell for the console:
login, register, refresh, logout, change-password, me and verify. It does not
store passwords or create a user/session table. In production, SynapseCity must
stay behind the Tier-1 IAM/API gateway and the shell must only adapt that
identity; set `AUTH_SECRET` for stable sessions. The demo login accepts any
non-empty credentials, so it must not be exposed directly to the Internet.
`/v1/users` and `/v1/auth/me` derive the principal from the signed session, not
from the first row of a dataset.

## Dataset ownership

Every dataset uses the `city-` prefix. A `sos-` dataset is foreign and must
never be read or written. The service fails at start-up if a configured dataset
does not use the City prefix.

Only `city-assets` and `city-incidents` are public projections. Every other
dataset (including `city-users`, operational alerts, budgets, reports,
notifications, geofences and ingest jobs) is private and must not be published
to the open-data layer. Existing public projections created before this rule
must be revoked in Tier-2 by the operator.

```text
city-assets                 city-incidents
city-maintenance            city-iot-sensors
city-iot-readings           city-alerts
city-budgets                city-budget-transactions
city-reports                city-notifications
city-users                  city-geofences
city-ingest-jobs
```

## Console route ownership

Owned:

```text
/                              city landing
/about                         city product
/docs                          city API docs
/map                           public city asset map
/login /register               auth shell
/asset/$id                     public asset detail
/public/report                 citizen incident report
/public/report/$assetId        report about an asset
/public/incidents/$incidentId  public incident lookup
/admin                         city operations dashboard
/admin/map                     internal asset map
/admin/assets[/$id]            asset registry
/admin/incidents[/create|/$id] city incidents
/admin/alerts[/list]           infrastructure alerts
/admin/iot[/create|/$id]       IoT sensors
/admin/budgets[/create|/$id]   budgets
/admin/reports[/create]        operational reports
/admin/users[/create|/$id]     city operators
/admin/ingest                  data ingestion
/admin/settings                self-service profile
/technician[/tasks/$taskId|/maintenance/$id|/settings] technician portal
```

Never add:

```text
/disaster
/admin/emergency-center*
any hazard, EOP, dispatch, SITREP, AAR or command-centre page
```

SOS responders are SOS resource units, not City users. Do not add an SOS
resource, dispatch or hazard page to this console.

## Cross-product rules

- Allowed: a public HTTPS link to `https://sos.synapsecity.sbs` in navigation
  or documentation.
- Forbidden: calling an SOS endpoint, importing SOS modules or types, reading
  an SOS dataset, sharing a queue/cache/database, or proxying SOS traffic
  through the City gateway.
- Auth, login, register and profile settings are shared **shell code** only.
  They are copied per product and never share a user table or session store.

## Change checklist

1. The feature belongs to the owned list above.
2. The API path is in the City namespace list and uses `city-*` datasets.
3. The console route is in the owned route list.
4. No import, URL or type comes from SynapseCitySOS.
5. `npm run build`, `npm test` and the gateway 404 tests pass.
6. `README.md`, `AGENTS.md` and this file stay consistent.
