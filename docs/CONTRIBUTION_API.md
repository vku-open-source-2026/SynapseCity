# Contribution Portal API reference

**Language / Ngôn ngữ:** [English](CONTRIBUTION_API.md) | [Tiếng Việt](vi/CONTRIBUTION_API.md)

Base URL: **https://contribution.synapsecity.sbs**

This document describes the HTTP contract implemented by the Rust Axum router in
[`apps/contribution-service/src/routes`](../apps/contribution-service/src/routes).
It covers public reads and citizen intake, the portal's single-admin JWT flow,
moderation endpoints, the internal export acknowledgement, CSV export, map
configuration/tiles, and health probes.

The contribution portal is a SynapseCity Tier-3 data-collection service. Its
legacy `/api/sos` routes collect citizen reports and let the portal administrator
change their intake status; they are **not** the SynapseCitySOS operations API.
No endpoint here provides dispatch, EOP, SITREP, AAR, hazard-feed, or emergency
command-centre operations.

## Conventions

- Paths below are relative to the base URL. The public edge forwards `/api/*` to
  this service; `/health` and `/ready` are also available internally.
- Successful JSON responses use HTTP **200**, including creates and moderation
  actions. This service does not return 201 for successful writes.
- Request bodies use `Content-Type: application/json` unless an endpoint says
  otherwise. Path parameters are strings; URL-encode them when necessary.
- JSON object key order is not significant. Array order is meaningful where
  documented (pending submissions, SOS reports, and the leaderboard).
- IDs are opaque strings. Do not construct them; use IDs returned by list
  endpoints.
- Contribution `timestamp` values are naive UTC strings such as
  `2026-11-26T10:20:30.123456`. Storage-generated `created_at`, `updated_at`, and
  `city_synced_at` values are RFC 3339 UTC strings with a `+00:00` suffix.
- The default request-body limit is **25 MiB** (`BODY_LIMIT_BYTES=26214400`).
  Larger bodies return **413**. The default whole-request timeout is **60
  seconds** (`REQUEST_TIMEOUT_SECS`); a timeout returns **408**.
- Responses include `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, and `X-XSS-Protection: 1; mode=block`. Production
  responses also include HSTS.

## Authentication

### Anonymous endpoints

No `Authorization` header is required for:

- all health/readiness probes;
- `GET /api/features`;
- `POST /api/contributions`;
- `GET /api/leaderboard`;
- `POST /api/sos`;
- `GET /api/export_csv`;
- both `/api/map/*` endpoints.

`POST /api/auth/login` and `POST /api/auth/refresh` also do not require an
existing token, but login requires the configured administrator credentials.
There is no public registration endpoint.

### Administrator Bearer tokens

The remaining portal administration endpoints require:

```http
Authorization: Bearer <access_token>
```

The service supports one environment-configured administrator account. Access
tokens are HS256 JWTs with `sub`, `exp`, and `type: "access"` claims. The default
access lifetime is 60 minutes (`ACCESS_TOKEN_EXPIRE_MINUTES`); refresh tokens
have `type: "refresh"` and default to 7 days (`REFRESH_TOKEN_EXPIRE_DAYS`).
Refreshing rotates both tokens. These portal credentials are separate from the
retired City `/v1/auth/*` surface and from SynapseDX workspace sessions.

Bearer extractor behavior intentionally matches the former FastAPI contract:

| Condition | Status | Response |
| --- | --- | --- |
| Missing `Authorization` header or value not starting with `Bearer ` | 403 | `{"detail":"Not authenticated"}` |
| Invalid/expired token | 401 | `{"detail":"Could not validate credentials"}` |
| Valid token with the wrong token type | 401 | `{"detail":"Invalid token type"}` |
| Valid token with an empty subject | 401 | `{"detail":"Could not validate credentials"}` |

A 401 includes `WWW-Authenticate: Bearer`. There is no role claim or permission
matrix in this service; a valid access token is the administrator credential for
all Bearer-protected routes.

### Internal sync secret

`POST /api/sync/ack` is a server-to-server endpoint, not a browser/admin-token
endpoint. It requires an exact match for:

```http
X-Sync-Secret: <SYNC_SHARED_SECRET>
```

The comparison is constant-time. If the secret is not configured, the endpoint
returns 503. Cross-origin CORS does not allow `X-Sync-Secret`, so browser clients
must not call this route directly.

## Rate limits and request limits

Route-specific limiters use a **fixed 60-second window per client IP and route
scope**. They are process-local and reset on restart. When
`TRUST_PROXY_HEADERS=true` (the default), the key is the last comma-separated
entry in `X-Forwarded-For`; the trusted edge must append the real peer address.
Otherwise the socket peer is used.

| Scope | Limit |
| --- | --- |
| `login` | 5 requests/minute/IP |
| `refresh` | 10 requests/minute/IP |
| `contribution_create` | 10 requests/minute/IP |
| `feature_delete` | 20 requests/minute/IP |
| `contribution_approve` | 30 requests/minute/IP |
| `contribution_reject` | 30 requests/minute/IP |
| `sos_create` | 20 requests/minute/IP |
| `sos_ack` | 30 requests/minute/IP |
| `sos_resolve` | 30 requests/minute/IP |

Exceeding a scope returns **429** with:

```json
{"detail":"Rate limit exceeded"}
```

The current implementation does **not** emit `Retry-After`. Endpoints without a
route-specific limiter are still subject to the global body-size and request
timeout limits; do not assume they have an unlimited production capacity.

## Errors and status codes

Handler errors use the FastAPI-compatible envelope:

```json
{"detail":"Feature not found"}
```

JSON parse failures and model validation failures return **422** with a Pydantic-
style array:

```json
{
  "detail": [
    {
      "loc": ["body", "geometry"],
      "msg": "geometry must contain type and coordinates",
      "type": "value_error"
    }
  ]
}
```

A malformed JSON body has `loc: ["body"]` and `type: "value_error.json"`.
Missing required model fields are also reported as 422 by the JSON extractor.

Common statuses:

| Status | Meaning |
| --- | --- |
| 200 | Successful JSON response, CSV download, or map tile |
| 400 | Malformed path/query value rejected by Axum |
| 401 | Invalid/expired credentials, wrong token type, or invalid sync secret |
| 403 | Missing/malformed Bearer credentials |
| 404 | Resource not found, or unknown route |
| 405 | Method not allowed for a known route |
| 408 | Whole-request timeout |
| 413 | Request body exceeds `BODY_LIMIT_BYTES` |
| 422 | Malformed JSON or failed model/domain validation |
| 429 | Route-specific fixed-window rate limit exceeded |
| 500 | Storage or upstream request failure |
| 503 | Required optional integration is not configured, such as sync acknowledgement or VietMap tiles |

Storage failures are intentionally generic (`Storage backend request failed`)
and do not expose dependency details.

## Endpoint index

| Method | Path | Authentication | Route limit |
| --- | --- | --- | --- |
| GET | `/health` | Anonymous | — |
| GET | `/ready` | Anonymous | — |
| GET | `/api/health` | Anonymous | — |
| GET | `/api/ready` | Anonymous | — |
| POST | `/api/auth/login` | Admin credentials in body | 5/min |
| POST | `/api/auth/refresh` | Refresh token in body | 10/min |
| GET | `/api/features` | Anonymous | — |
| POST | `/api/features` | Bearer | — |
| DELETE | `/api/features/{feature_id}` | Bearer | 20/min |
| POST | `/api/contributions` | Anonymous | 10/min |
| GET | `/api/contributions` | Bearer | — |
| POST | `/api/contributions/{contribution_id}/approve` | Bearer | 30/min |
| DELETE | `/api/contributions/{contribution_id}` | Bearer | 30/min |
| GET | `/api/leaderboard` | Anonymous | — |
| POST | `/api/sos` | Anonymous | 20/min |
| GET | `/api/sos` | Bearer | — |
| POST | `/api/sos/{report_id}/ack` | Bearer | 30/min |
| POST | `/api/sos/{report_id}/resolve` | Bearer | 30/min |
| POST | `/api/sync/ack` | `X-Sync-Secret` | — |
| GET | `/api/export_csv` | Anonymous | — |
| GET | `/api/map/tiles/{z}/{x}/{y}` | Anonymous | — |
| GET | `/api/map/config` | Anonymous | — |

## Health and readiness

### GET `/health` and GET `/api/health`

Anonymous liveness probe. Always returns 200 without contacting storage.

```json
{
  "status": "ok",
  "service": "contribution-backend",
  "version": "0.1.0"
}
```

`version` is the compiled crate version.

### GET `/ready` and GET `/api/ready`

Anonymous readiness response. Returns 200 and identifies the configured storage
backend; it does not perform a live dependency probe.

```json
{
  "status": "ready",
  "service": "contribution-backend",
  "version": "0.1.0",
  "storage": "dx"
}
```

`storage` is `"dx"` in production. `"base"` is the legacy Tier-1
migration/rollback backend; `"json"` is allowed only in development.

## Authentication endpoints

### POST `/api/auth/login`

Rate limit: **5/minute/IP**. Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `username` | string | Yes | Compared with `ADMIN_USERNAME` |
| `password` | string | Yes | Compared in constant time with `ADMIN_PASSWORD` |

```json
{"username":"admin","password":"<configured-password>"}
```

Success (200):

```json
{
  "access_token": "<jwt>",
  "refresh_token": "<jwt>",
  "token_type": "bearer"
}
```

Incorrect credentials return 401 with
`{"detail":"Incorrect username or password"}`. Missing fields or invalid JSON
return 422. Exceeding the limit returns 429.

### POST `/api/auth/refresh`

Rate limit: **10/minute/IP**. Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `refresh_token` | string | Yes | Must be a valid, unexpired `type: "refresh"` JWT |

```json
{"refresh_token":"<refresh-jwt>"}
```

Success (200) has the same shape as login and contains a newly issued access
and refresh token. Invalid/expired tokens return 401 with
`{"detail":"Could not validate credentials"}`; an access token supplied here
returns 401 with `{"detail":"Invalid token type"}`. Missing/invalid fields return
422; exceeding the limit returns 429.

## Infrastructure features

Features are GeoJSON-like objects in the Tier-2 dataset
`city-contribution-features`.

### GET `/api/features`

Anonymous. No query parameters or pagination. Returns all stored features:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "id": "feature-1",
      "_id": "feature-1",
      "feature_code": "den_duong",
      "properties": {
        "feature_type": "Đèn đường",
        "name": "Street light"
      },
      "geometry": {
        "type": "Point",
        "coordinates": [106.7, 10.7]
      },
      "created_at": "2026-11-26T10:20:30.123456+00:00",
      "city_synced": false
    }
  ]
}
```

Common fields are `type`, `id`, `properties`, and `geometry`. `_id`,
`created_at`, and `city_synced` are storage-added fields and are not guaranteed
to be identical between the production Base backend and the development JSON
backend. `feature_code`, `source_submission_id`, and additional approved-
submission fields may also be present.

### POST `/api/features`

Bearer required. No route-specific rate limit. Request body:

| Field | Type | Required | Default/validation |
| --- | --- | --- | --- |
| `type` | string | No | `"Feature"`; trimmed and HTML-sanitized |
| `id` | string | No | Stored as supplied; generated when omitted |
| `feature_code` | string | No | Trimmed, HTML-sanitized, omitted when empty |
| `properties` | object | Yes | Strings are recursively HTML-sanitized |
| `geometry` | object | Yes | Shared bounded geometry validation below |

When `feature_code` is absent/empty, storage derives it from
`properties.feature_type` by lowercasing and replacing spaces with underscores.
Production storage also adds a creation timestamp and `city_synced: false`.

Success (200):

```json
{"status":"success"}
```

The response does not include the created ID; read `GET /api/features` to obtain
it. Validation failures return 422.

### DELETE `/api/features/{feature_id}`

Bearer required. Rate limit: **20/minute/IP**. No request body. Deletes the
feature with the exact opaque ID.

Success (200):

```json
{
  "status": "success",
  "message": "Feature feature-1 deleted"
}
```

A missing ID returns 404 with `{"detail":"Feature not found"}`.

## Contributions and moderation

### POST `/api/contributions`

Anonymous citizen submission. Rate limit: **10/minute/IP**. Request body:

| Field | Type | Required | Default/validation |
| --- | --- | --- | --- |
| `contributor_name` | string | Conditional | Required with `msv` unless anonymous; max 100 characters after trimming/sanitizing |
| `msv` | string | Conditional | Required with `contributor_name` unless anonymous; max 20 characters |
| `unit` | string | No | Trimmed/sanitized; empty or omitted becomes `"VKU"` |
| `anonymous` | boolean | No | `false`; when true, identity is replaced with anonymous values |
| `properties` | object | Yes | Recursively sanitized; Python-style serialized size must be at most 10,000 characters |
| `geometry` | object | Yes | Shared bounded geometry validation below |

If both `contributor_name` and `msv` are omitted, the contribution is anonymous
even if `anonymous` is false. If `anonymous` is true, stored identity is always
`contributor_name: "Ẩn danh"`, `msv: "ANON"`, and `unit: "Ẩn danh"`. Otherwise
both identity fields are required. Text fields have HTML tags stripped and
entities escaped.

```json
{
  "contributor_name": "Nguyen Van A",
  "msv": "23AI034",
  "unit": "VKU",
  "anonymous": false,
  "properties": {
    "feature_type": "Đèn đường",
    "name": "Street light"
  },
  "geometry": {
    "type": "Point",
    "coordinates": [106.7, 10.7]
  }
}
```

Success (200):

```json
{
  "status": "success",
  "message": "Contribution submitted"
}
```

The submission is stored with `status: "pending"` and does not appear in the
leaderboard until approved. Validation failures return 422; exceeding the limit
returns 429.

### GET `/api/contributions`

Bearer required. No query parameters or route-specific rate limit. Returns only
pending submissions as a JSON array. Production storage orders them by
`timestamp` descending.

Each item commonly contains:

```json
{
  "id": "c1",
  "_id": "c1",
  "contributor_name": "Nguyen Van A",
  "msv": "23AI034",
  "unit": "VKU",
  "anonymous": false,
  "properties": {
    "feature_type": "Đèn đường",
    "name": "Street light"
  },
  "geometry": {
    "type": "Point",
    "coordinates": [106.7, 10.7]
  },
  "status": "pending",
  "timestamp": "2026-11-26T10:20:30.123456",
  "type": "Feature",
  "feature_code": "đèn_đường"
}
```

`feature_code` is added when `properties.feature_type` is a non-empty string.
`_id` and `created_at` are Base-storage additions; the development JSON backend
does not add every production metadata field.

### POST `/api/contributions/{contribution_id}/approve`

Bearer required. Rate limit: **30/minute/IP**. No request body is required.
Approving a pending submission materializes a feature and marks the submission
approved. The feature receives `id: "feature-<contribution_id>"` and
`source_submission_id` so retries cannot create duplicates.

Success (200):

```json
{"status":"success"}
```

Retrying an already approved submission is an idempotent success:

```json
{"status":"success","idempotent":true}
```

A missing or no-longer-pending submission returns 404 with
`{"detail":"Contribution not found"}` (an already approved submission is the
idempotent exception above).

### DELETE `/api/contributions/{contribution_id}`

Bearer required. Rate limit: **30/minute/IP**. No request body. Rejects/deletes
the submission, regardless of its current status.

Success (200):

```json
{"status":"success"}
```

A missing ID returns 404 with `{"detail":"Contribution not found"}`.

## Leaderboard

### GET `/api/leaderboard`

Anonymous. No query parameters, pagination, or route-specific rate limit.
Returns a JSON array sorted by:

1. `count` descending;
2. `contributor_name` ascending when counts are equal.

Only **approved, non-anonymous** submissions are counted. Rows are grouped by
`msv`; pending/rejected submissions and anonymous contributions are excluded.
`unit` is the organization value stored for the grouped contributor, defaulting
to `"VKU"` when a stored record has no unit.

#### Response schema

The response is an array, not an object. Every row has exactly these public
leaderboard fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `contributor_name` | string | Contributor display name |
| `msv` | string | Contributor/student identifier and grouping key |
| `unit` | string | Organization/unit; `"VKU"` is the fallback |
| `count` | integer | Number of approved, non-anonymous submissions for that `msv` |

Example:

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
  },
  {
    "contributor_name": "Le Van C",
    "msv": "23AI036",
    "unit": "VKU",
    "count": 4
  }
]
```

An empty leaderboard is `[]`.

#### Organization filtering is client-side

**The API currently returns all organizations and does not accept a `unit` or
organization query parameter.** The contribution console fetches this complete
array once, derives the organizations present in the response, and filters by
the selected `leader.unit` in the browser. Missing/empty units use the `VKU`
fallback. The UI's “Tất cả tổ chức” option shows the full array.

After filtering, the UI recomputes the visible top three and assigns table ranks
starting at 1 within the selected organization. This is presentation-only
filtering: it does not change counts, aggregate contributors again, or alter the
backend response/API contract.

## Legacy citizen SOS intake

These routes are limited to public report collection and administrator status
updates. They do not dispatch responders or expose emergency operations data.

### POST `/api/sos`

Anonymous. Rate limit: **20/minute/IP**. Request body:

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `contributor_name` | string | Yes | 1–100 characters after trimming/sanitizing |
| `msv` | string | Yes | 1–20 characters |
| `unit` | string | No | Trimmed/sanitized; empty/omitted becomes `"VKU"` |
| `emergency_type` | string | Yes | 2–50 characters; no enum restriction |
| `severity` | string | Yes | Lowercased; one of `low`, `medium`, `high`, `critical` |
| `message` | string | Yes | 5–2,000 characters |
| `district` | string | No | At most 120 characters |
| `ward` | string | No | At most 120 characters |
| `contact_phone` | string | No | At most 30 characters |
| `geometry` | object | No | Must contain string `type` and array `coordinates`; serialized size at most 5,000 characters |

Unlike contribution/feature geometry, SOS geometry is only shape-checked and
size-bounded; this route does not apply the Point/LineString/Polygon coordinate
limits. Optional fields are omitted from storage when not supplied.

```json
{
  "contributor_name": "Nguyen Van A",
  "msv": "23AI034",
  "unit": "VKU",
  "emergency_type": "fire",
  "severity": "HIGH",
  "message": "Smoke near the market",
  "district": "Quan 1",
  "ward": "Ben Nghe",
  "contact_phone": "0900000000",
  "geometry": {
    "type": "Point",
    "coordinates": [106.7, 10.7]
  }
}
```

Success (200):

```json
{
  "status": "success",
  "message": "SOS report submitted"
}
```

The stored report starts at `status: "pending"`, has `source: "datacollector"`,
and receives `created_at`/`updated_at` timestamps. Validation failures return
422; exceeding the limit returns 429.

### GET `/api/sos`

Bearer required. No route-specific rate limit. Optional query parameter:

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `status` | string | No | Exact status filter, for example `pending`, `acknowledged`, or `resolved` |

Returns a JSON array ordered by `created_at` descending. Without `status`, all
reports are returned. The service does not validate `status` against an enum; an
unknown value simply matches no records.

Each item contains `id`, `contributor_name`, `msv`, `unit`, `emergency_type`,
`severity`, `message`, `status`, `created_at`, `updated_at`, and
`source: "datacollector"`. Optional `district`, `ward`, `contact_phone`, and
`geometry` appear only when supplied. Base storage also includes `_id`.

### POST `/api/sos/{report_id}/ack`

Bearer required. Rate limit: **30/minute/IP**. No request body. Sets
`status: "acknowledged"` and updates `updated_at`.

Success (200): `{"status":"success"}`. A missing ID returns 404 with
`{"detail":"SOS report not found"}`.

### POST `/api/sos/{report_id}/resolve`

Bearer required. Rate limit: **30/minute/IP**. No request body. Sets
`status: "resolved"` and updates `updated_at`.

Success (200): `{"status":"success"}`. A missing ID returns 404 with
`{"detail":"SOS report not found"}`. The handler does not enforce an
acknowledged-before-resolved transition.

## Internal daily-export acknowledgement

### POST `/api/sync/ack`

Requires `X-Sync-Secret`; does not accept a Bearer token as a substitute. No
route-specific rate limit. The body may be empty or JSON:

| Field | Type | Required | Default/validation |
| --- | --- | --- | --- |
| `limit` | number or numeric string | No | Default `500`; clamped to `1..1000` |

```http
X-Sync-Secret: <configured-secret>
Content-Type: application/json
```

```json
{"limit":500}
```

Malformed JSON is treated as an empty object, so the default limit applies.
The handler marks up to `limit` unsynced features with `city_synced: true` and a
`city_synced_at` timestamp.

Success (200):

```json
{"status":"success","marked":12}
```

`marked` is the number successfully updated. Missing/invalid secrets return 401
with `{"detail":"Invalid sync secret"}`. If `SYNC_SHARED_SECRET` is not
configured, returns 503 with
`{"detail":"Sync acknowledgement is not configured"}`.

## CSV export

### GET `/api/export_csv`

Anonymous. No route-specific rate limit. Optional query parameter:

| Parameter | Type | Required | Meaning |
| --- | --- | --- | --- |
| `types` | string | No | Comma-separated feature codes or Vietnamese feature types |

Values are deduplicated, Vietnamese diacritics are removed, `đ/Đ` becomes
`d/D`, and spaces become underscores for comparison. A feature matches when
either its `feature_code` or `properties.feature_type` normalizes to a requested
value. Omitting `types` exports all features; a present but empty/whitespace-only
value exports no data rows (the CSV still contains its header).

Built-in display-type fallbacks when `feature_code` is absent:

| Feature type | Code |
| --- | --- |
| Trạm điện | `tram_dien` |
| Cột điện | `cot_dien` |
| Đường ống điện | `duong_ong_dien` |
| Đèn đường | `den_duong` |
| Đèn giao thông | `den_giao_thong` |
| Cống thoát nước | `cong_thoat_nuoc` |
| Ống dẫn nước | `ong_dan_nuoc` |
| Trụ chữa cháy | `tru_chua_chay` |
| Trạm sạc | `tram_sac` |

Success (200) is a downloadable CSV, not JSON:

```http
Content-Type: text/csv; charset=utf-8
Content-Disposition: attachment; filename=features.csv
```

The file has one UTF-8 BOM and CRLF row endings. The first columns are
`feature_type`, `feature_code`, and `geometry`; remaining columns are the union
of feature property keys in sorted order. Geometry is uppercase WKT-style text
such as `POINT [106.7, 10.7]`. Property values may override the three base
columns. Booleans render as `True`/`False`, null as an empty cell, and nested
values use Python-style representations. Cells beginning with `=`, `+`, `-`, or
`@` are prefixed with an apostrophe to prevent spreadsheet formula injection.

## Map configuration and tiles

### GET `/api/map/config`

Anonymous. No parameters or route-specific limit. Returns the browser tile
configuration. When `VIETMAP_API_KEY` is configured:

```json
{
  "tileUrl": "/api/map/tiles/{z}/{x}/{y}",
  "attribution": "&copy; <a href=\"https://vietmap.vn\">VietMap</a> | Hoang Sa and Truong Sa belong to Vietnam 🇻🇳",
  "maxZoom": 20,
  "provider": "vietmap"
}
```

Without a VietMap key:

```json
{
  "tileUrl": "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  "attribution": "&copy; <a href=\"https://openstreetmap.org/copyright\">OpenStreetMap</a> contributors",
  "maxZoom": 20,
  "provider": "osm"
}
```

### GET `/api/map/tiles/{z}/{x}/{y}`

Anonymous. No route-specific limit. Path parameters `z`, `x`, and `y` are signed
32-bit integers. The endpoint requires `VIETMAP_API_KEY`; it is not used when
`/api/map/config` selects OSM.

On success, returns 200 with the upstream image content type (falling back to
`image/png`), `Cache-Control: public, max-age=86400`, and
`Access-Control-Allow-Origin: *`. The service requests VietMap's `@2x` tile and
keeps the API key server-side.

Without a configured key, returns 503 with
`{"detail":"VietMap API key not configured"}`. An unsuccessful upstream HTTP
status is forwarded with `{"detail":"Upstream tile error"}`. Upstream network
or body failures return 500 with the same detail message. The upstream tile
request has a 15-second timeout in addition to the global request timeout.

## Shared bounded geometry validation

`POST /api/features` and `POST /api/contributions` use these geometry rules:

- The value must be an object with string `type` and array `coordinates`.
- Allowed types: `Point`, `LineString`, `Polygon`.
- Each position is an array of `[longitude, latitude]` with an optional third
  finite altitude value.
- Longitude must be finite and within `[-180, 180]`; latitude must be finite and
  within `[-90, 90]`.
- `Point` has one position; `LineString` has at least two; `Polygon` has at
  least one ring and each ring has at least four positions.
- A geometry may contain at most 2,000 total positions and at most 16,000
  serialized characters.
- Ring closure is not separately enforced. Unsupported geometry types such as
  `MultiPoint` and `GeometryCollection` return 422.

## CORS

CORS origins come from `CORS_ORIGINS` (default
`https://contribution.synapsecity.sbs`). The service allows `GET`, `POST`,
`PUT`, `PATCH`, `DELETE`, and `OPTIONS`, credentials, and the request headers
`Authorization`, `Content-Type`, and `X-Requested-With`. Only configured origins
are allowed. `X-Sync-Secret` is intentionally not in the browser CORS allowlist.
