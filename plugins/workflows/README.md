# City workflow artifacts (operation migration source)

Status: **create and status-transition flows are source-ready and
engine-tested; credential binding and deployment are not done.** No production
redirect or page retirement is deployed.

| Operation | Artifact | Tier-2 dataset | Status |
| --- | --- | --- | --- |
| `incidents.create` | `city-incident-create.workflow.json` | `city-incidents` | source-ready |
| `maintenance.create` | `city-maintenance-create.workflow.json` | `city-maintenance` | source-ready |
| `incidents.assign` | `city-incident-assign.workflow.json` | `city-incidents` | source-ready |
| `incidents.resolve` | `city-incident-resolve.workflow.json` | `city-incidents` | source-ready |
| `maintenance.assign/start/complete` | `city-maintenance-{assign,start,complete}.workflow.json` | `city-maintenance` | source-ready |

## Functional create flow

`manualTrigger` → sandboxed `code` validation → `httpRequest`:
`POST https://synapsedx.sbs/v1/capabilities/datasets/<dataset>/records`.

- Input is the real DX helper envelope
  `{pluginId,widgetId,product,resource,submittedBy,submittedAt,fields}`; unknown
  envelope/field keys and wrong product/resource are rejected.
- Domain validation mirrors the City service (title/category/asset/priority
  rules). The dataset and `publish` flag are derived server-side
  (`incidents → city-incidents`, publish `true`; `maintenance →
  city-maintenance`, publish `false`). A submitted datasource/dataset/id is
  never accepted.
- Body is `{ data: <domain record>, publish: <boolean> }` (Tier-2 records
  create contract). No Base SDK, no LDS projection, no Tier-3 API.
- Auth is `parameters.auth = {credentialRef: "synapsedx-organization", header:
  "X-API-Key", allowedOrigins: ["https://synapsedx.sbs"]}`. The source stores
  only the **credentialRef**; DX must resolve it to a same-org API-key
  credential (workflow worker owns binding) and pin the artifact before
  activation. The workflow engine's credential destination protection requires
  the exact origin allowlist; it contains no path or wildcard.

## CredentialRef convention (proposed to the workflow worker)

- Source value: `synapsedx-organization` (portable placeholder only; no
  deployment credential id or secret exists in this repository).
- `allowedOrigins` is limited to the exact `https://synapsedx.sbs` origin; the
  engine enforces it before resolving the credential. This is owned by the
  workflow agent's credential-origin protection; City sources only declare the
  destination.
- DX import binds it to the organization's technical **owner-only encrypted**
  api-key credential; the binding is stored server-side per organization.
- DX export rewrites the bound deployment credential into the portable source
  reference (export rebinding), so a repository bundle never contains a
  deployment id or secret.
- DX verifies the artifact graph checksum/revision pins at execution (runtime
  checksum) and rejects drift.
- Tier-2 gateway user-key identity is the authorization boundary; the workflow
  does not carry a user token and does not call Tier-3.

## Engine test (local only)

```bash
npm run test:workflow-engine
```

This runs the real Tier-1 `runWorkflow` engine with a fake `fetch` transport
(no network, no real credential): it asserts the exact POST URL, `X-API-Key`
from an in-memory api-key resolver, `{data,publish}` body, validated domain
fields, the audit object, transition GET(`includeInput`)→merge→PATCH with
`ifVersion`, terminal refusal, `409` CAS propagation, AAR-before-event-close,
and that a malformed form fails before any HTTP call.

The machine-readable transition design is `actions.design.json` in this
directory (operations, required fields, allowed states, patch, invariants and
the engine blocker).

## Status transitions (implemented source)

Each transition uses `manualTrigger` → validation → **GET with
`includeInput:true`** → a `code` node that checks the current state and merges
the action patch over the full record → **PATCH with `{data, ifVersion}`**.

- `includeInput` returns `{statusCode, body, input}` where `input` is the
  validated action payload, so the merge node can combine it with the fetched
  record without erasing unrelated fields.
- Terminal/state guards: incidents cannot be assigned/resolved from
  `resolved`/`closed`; maintenance cannot transition from
  `completed`/`cancelled`, and completion requires `in_progress`; record
  versions must be present.
- **Concurrency contract:** Tier-2 `PATCH .../records/:id` supports optimistic
  CAS via `If-Match`/`ifVersion`; the workflow sends the version read in the
  preceding GET. A concurrent write returns `409 version_conflict`, which the
  engine surfaces as an error — never a silent lost update. There is no
  multi-record transaction.
- **Notifications** remain separate Tier-2 actions, not silent side effects.

## Second source batch (staged manifest sync)

Incident lifecycle and maintenance cancellation are implemented as workflow
sources with the same validation/CAS pattern:

| Operation | Artifact | Dataset |
| --- | --- | --- |
| `incidents.acknowledge` | `city-incident-acknowledge.workflow.json` | `city-incidents` |
| `incidents.close` | `city-incident-close.workflow.json` | `city-incidents` |
| `incidents.reject` | `city-incident-reject.workflow.json` | `city-incidents` |
| `incidents.verify` | `city-incident-verify.workflow.json` | `city-incidents` |
| `maintenance.cancel` | `city-maintenance-cancel.workflow.json` | `city-maintenance` |

They are listed under `lifecycleWorkflows`/`lifecycleActions` in the manifest and
action design. Canonical `workflows` merge and the tooling/harness update are a
repo-sync handoff (repo-sync owns `scripts/**` and exact-list tests), so these
sources do not silently change the existing manifest contract. Invariants:
terminal states refused, `ifVersion` CAS, full-record merge, no invalid fields.

## Remaining action gap

Everything except the two creates has no executable workflow: incident
merge/verify, maintenance approve/reject/cancel/photos, asset lifecycle/
documents/delete, IoT, alerts, budgets, reports, users, geofences, CSV ingest,
notifications and geospatial actions. The widget vocabulary also only declares
`action:'create'`; non-create actions need a DX action design.

## Validation

```bash
npm run test:workflow-artifacts
npm run test:workflow-engine
npm run workflows:validate
```

## Provenance

Repository `https://github.com/vku-open-source-2026/SynapseCity`, revision
`2026-11-14`. Tier-3 API paths (`POST /v1/incidents`, `POST /v1/maintenance`)
are provenance only and are not called by the workflow or DX.
