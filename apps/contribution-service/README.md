# SynapseCity contribution service (Rust)

Backend for `https://contribution.synapsecity.sbs`, owned by SynapseCity. The
source was migrated from the OpenInfra reference implementation; OpenInfra is no
longer a deployment source. Production persists through Tier-2 datasets
`city-contribution-features`, `city-contribution-submissions`, and
`city-contribution-sos-reports`.

> **Boundary note:** this is a SynapseCity Tier-3 data-collection edge. The
> legacy `synapseone` SDK/`contribution_*` path is retained only for the one-off
> migration and explicit rollback (`STORAGE_BACKEND=base`). Do not copy direct
> Tier-1 access into `city-service`, the gateway or the console.

## Why

* Single static binary, no Python/uvicorn/gunicorn layer.
* Much lower resident memory on the shared server.
* Same SynapseBase collections and daily SynapseFlow contract.
* Typed request validation and constant-time secret comparison.

## Ownership and deployment

* Source: `SynapseCity/apps/contribution-service`
* UI: `SynapseCity/apps/contribution-console`
* Compose: `SynapseCity/docker-compose.yml` services
  `contribution-service` and `contribution-console`
* Public host: `contribution.synapsecity.sbs`
* The old `openinfra/datacollector` project and the entire OpenInfra checkout
  have been removed; do not recreate them.

The complete endpoint, authentication, validation, error, rate-limit, and
response reference is maintained in
[`docs/CONTRIBUTION_API.md`](../../docs/CONTRIBUTION_API.md). The table below is
only a route inventory.

## Endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/auth/login` | — | 5/min per IP |
| POST | `/api/auth/refresh` | — | 10/min per IP |
| GET | `/api/features` | — | public GeoJSON collection |
| POST | `/api/features` | Bearer | admin |
| DELETE | `/api/features/{id}` | Bearer | 20/min |
| POST | `/api/contributions` | — | public submission |
| GET | `/api/contributions` | Bearer | pending submissions |
| POST | `/api/contributions/{id}/approve` | Bearer | 30/min |
| DELETE | `/api/contributions/{id}` | Bearer | 30/min |
| GET | `/api/leaderboard` | — | public, all organizations |
| POST | `/api/sos` | — | 20/min |
| GET | `/api/sos?status=` | Bearer | operator list |
| POST | `/api/sos/{id}/ack` | Bearer | 30/min |
| POST | `/api/sos/{id}/resolve` | Bearer | 30/min |
| POST | `/api/sync/ack` | `X-Sync-Secret` | daily export acknowledgement |
| GET | `/api/export_csv?types=` | — | streaming-compatible CSV |
| GET | `/api/map/tiles/{z}/{x}/{y}` | — | VietMap proxy |
| GET | `/api/map/config` | — | basemap selection |
| GET | `/health`, `/ready` | — | new probes (internal) |
| GET | `/api/health`, `/api/ready` | — | new probes through nginx |

## Leaderboard response and UI filtering

`GET /api/leaderboard` is anonymous and returns a JSON **array** (not an object).
Only approved, non-anonymous submissions are counted. Rows are grouped by `msv`
and sorted by `count` descending, then `contributor_name` ascending for ties.
Every row has this schema:

| Field | Type | Meaning |
| --- | --- | --- |
| `contributor_name` | string | Contributor display name |
| `msv` | string | Contributor/student identifier and grouping key |
| `unit` | string | Organization/unit; missing stored units fall back to `VKU` |
| `count` | integer | Approved, non-anonymous submission count for that `msv` |

```json
[
  {
    "contributor_name": "Nguyen Van A",
    "msv": "23AI034",
    "unit": "VKU",
    "count": 12
  },
  {
    "contributor_name": "Tran Thi B",
    "msv": "23AI035",
    "unit": "UIT",
    "count": 9
  }
]
```

The API currently returns **all units** and has no organization query parameter.
The React leaderboard fetches the full array, derives its dropdown options from
the `unit` values present, and applies the selected organization filter in the
browser. Empty/missing units use the `VKU` fallback. The visible top three and
table ranks are then recomputed within that selection, with an organization-
specific empty state. This is a client-side presentation feature; the backend
response and aggregation contract are unchanged.

See the [full Contribution Portal API reference](../../docs/CONTRIBUTION_API.md#leaderboard)
for the complete leaderboard contract and every other endpoint.

## Configuration

Same variables as the Python backend, plus:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDR` | `0.0.0.0:8000` | listen address |
| `STORAGE_BACKEND` | `dx` | `dx`/`tier2`, legacy `base`/`tier1`, or dev-only `json` |
| `SYNAPSEDX_BASE_URL` | `https://synapsedx.sbs` | public HTTPS Tier-2 endpoint |
| `SYNAPSEDX_API_KEY` / `SYNAPSEDX_TOKEN` | — | Tier-2 credential; at least one required for `dx` |
| `SYNAPSEDX_TIMEOUT_SECS` | `20` | clamped to 5–120 seconds |
| `SYNAPSEONE_BASE_URL` | `https://api.synapseone.space` | legacy migration/rollback only |
| `SYNAPSEONE_API_KEY` | — | required only for `base` |
| `SYNC_SHARED_SECRET` | — | `X-Sync-Secret` for `/api/sync/ack` |
| `JWT_SECRET_KEY` | — | ≥32 chars, required |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / — | single admin login |
| `CORS_ORIGINS` | `https://contribution.synapsecity.sbs` | comma-separated |
| `VIETMAP_API_KEY` | — | enables the tile proxy |
| `TRUST_PROXY_HEADERS` | `true` | read `X-Forwarded-For` behind nginx |
| `JSON_STORAGE_DIR` | `.` | dev JSON fallback directory |
| `BODY_LIMIT_BYTES` | `26214400` | 25 MB |
| `REQUEST_TIMEOUT_SECS` | `60` | per-request timeout |

Production fails fast on a short JWT secret, `STORAGE_BACKEND=json`, missing
credentials for the selected backend, the default admin password, or an
`http://`/private/credential-bearing dependency URL. `ALLOW_LOCAL_DEPENDENCIES`
is refused in production; outside production it permits loopback only, never
RFC1918/ULA/link-local/private Docker hosts.

## Build and test

```bash
cd SynapseCity/apps/contribution-service
cargo test
cargo build --release

# local run against JSON storage
STORAGE_BACKEND=json JSON_STORAGE_DIR=/tmp/contribution \
JWT_SECRET_KEY=0123456789abcdef0123456789abcdef \
ADMIN_PASSWORD=test-password-123 \
SYNC_SHARED_SECRET=testsecret \
./target/release/contribution-backend
```

The crate resolves `synapsedx = "0.7.0"` and legacy `synapseone = "0.9.0"` from
crates.io. No sibling checkout or `path` dependency is required.

## Tier-1 to Tier-2 migration

Build/run `migrate_base_to_dx` with `SYNAPSEONE_API_KEY` and either
`SYNAPSEDX_API_KEY` or `SYNAPSEDX_TOKEN`. Feature IDs are deterministic hashes of
`contribution_features:<legacy id>`, retain `legacy_id`/`legacy_source`, and do
not reuse City asset IDs. After an ambiguous timeout the migration queries for
the committed record before retrying. A rerun therefore leaves one feature per
legacy ID. Records without legacy IDs fail closed rather than receiving random
IDs.

## Docker

Build from the repository root (the Docker context includes project notices):

```bash
docker build -f apps/contribution-service/Dockerfile \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  -t synapsecity-contribution-service:latest .
```

The service is part of the SynapseCity stack:

```bash
cd /home/phamngoclananh30032009/OLP_OSS_2026/SynapseCity
docker compose -p synapsecity up -d --no-deps --build contribution-service contribution-console
```

## Parity notes

* API shapes, field names, status codes and rate-limit windows follow the
  Python backend.
* Missing bearer credentials return **403** (`Not authenticated`), invalid
  tokens return **401**, matching FastAPI's `HTTPBearer`.
* The CSV export writes a **single** UTF-8 BOM. The Python version prepended a
  BOM to every streamed chunk, which is treated as a bug here.
* The JSON dev leaderboard now returns `contributor_name` (the Python JSON
  fallback returned `name`, which the React page did not read).
* `/health`, `/ready`, `/api/health` and `/api/ready` are new.
* Password comparison is constant-time.
* `STORAGE_BACKEND=json` is a development fallback only; production uses Tier-2
  `dx`. `base` is legacy migration/rollback only.
* Tier-2 reads page to completion using cursors when available, with offset
  fallback and no silent 10,000-record cap.
* The service is SynapseCity-owned; the OpenInfra checkout has been removed.

## Tests

* `tests/api.rs` — auth, rate limiting, contributions, approval, leaderboard,
  features, sync ack, CSV, map config.
* `tests/base_storage.rs` — legacy collection bootstrap and migration fallback.
* `tests/dx_storage.rs` — Tier-2 bootstrap, >10,000-record pagination, and
  concurrent-insert cursor behavior.
* Migration unit tests — deterministic IDs and post-commit/lost-response reruns.
* Configuration unit tests — production HTTPS, credential, private IPv4/IPv6,
  Docker hostname, and local opt-in rules for both dependency settings.
* Unit tests for the rate limiter and CSV builder.

## Memory

The release binary is a few MB; the process has no Python runtime, uvicorn
workers, `node_modules`, or Mongo driver. Runtime memory is dominated by the
HTTP client connection pool and the requested feature list.
