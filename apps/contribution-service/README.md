# SynapseCity contribution service (Rust)

Backend for `https://contribution.synapsecity.sbs`, owned by SynapseCity. The
source was migrated from the OpenInfra reference implementation; OpenInfra is no
longer a deployment source. It keeps the public contribution-portal HTTP
contract and persists through the SynapseBase collections
`contribution_features`, `contribution_submissions` and
`contribution_sos_reports`.

> **Boundary note:** this is a SynapseCity Tier-3 data-collection edge. The
> direct `synapseone` SDK dependency is a scoped legacy exception while the
> contribution collections move to Tier-2 datasets. Do not copy this pattern
> into `city-service`, the gateway or the console.

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
* The old `openinfra/datacollector` project is reference-only and must stay
  stopped.

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
| GET | `/api/leaderboard` | — | public |
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

## Configuration

Same variables as the Python backend, plus:

| Variable | Default | Purpose |
| --- | --- | --- |
| `BIND_ADDR` | `0.0.0.0:8000` | listen address |
| `STORAGE_BACKEND` | `base` | `base` or `json` (dev only) |
| `SYNAPSEONE_BASE_URL` | `https://api.synapseone.space` | Tier-1 gateway |
| `SYNAPSEONE_API_KEY` | — | Base API key (`base:*` scopes) |
| `SYNC_SHARED_SECRET` | — | `X-Sync-Secret` for `/api/sync/ack` |
| `JWT_SECRET_KEY` | — | ≥32 chars, required |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / — | single admin login |
| `CORS_ORIGINS` | `https://contribution.synapsecity.sbs` | comma-separated |
| `VIETMAP_API_KEY` | — | enables the tile proxy |
| `TRUST_PROXY_HEADERS` | `true` | read `X-Forwarded-For` behind nginx |
| `JSON_STORAGE_DIR` | `.` | dev JSON fallback directory |
| `BODY_LIMIT_BYTES` | `26214400` | 25 MB |
| `REQUEST_TIMEOUT_SECS` | `60` | per-request timeout |

Production fails fast on a short JWT secret, `STORAGE_BACKEND=json`, a missing
Base key, the default admin password, or an `http://`/private dependency URL.
Set `ALLOW_LOCAL_DEPENDENCIES=true` only for local tests.

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

The crate depends on the local `synapseone` SDK at
`SynapseOne/sdks/sdk-rust`. After the SDK is published, replace the `path`
dependency with `synapseone = "0.9"`.

## Docker

Build from the **workspace root** (the Rust SDK is a sibling repository):

```bash
cd /home/phamngoclananh30032009/OLP_OSS_2026
docker build \
  -f SynapseCity/apps/contribution-service/Dockerfile \
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
* `STORAGE_BACKEND=json` is a development fallback only; production uses Base.
* The service is SynapseCity-owned; `openinfra/` is reference material only.

## Tests

* `tests/api.rs` — auth, rate limiting, contributions, approval, leaderboard,
  features, sync ack, CSV, map config.
* `tests/base_storage.rs` — collection bootstrap, query normalisation, feature
  defaults, batch sync against a mock SynapseBase.
* Unit tests for the rate limiter and CSV builder.

## Memory

The release binary is a few MB; the process has no Python runtime, uvicorn
workers, `node_modules`, or Mongo driver. Runtime memory is dominated by the
HTTP client connection pool and the requested feature list.
