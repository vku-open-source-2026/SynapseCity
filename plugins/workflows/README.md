# City workflow artifacts (operation migration source)

Status: **create and status-transition flows are source-ready, engine-tested,
pinned in production DX and representative operations were live-tested on
2026-11-14.** The public-only redirects are deployed. Individual form coverage
and the remaining action gap below are still tracked; this is not a claim that
every operation is migrated.

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
  rules). The dataset and `publish` flag are derived server-side. Incident
  creates/updates are written with `publish:false`; the City service is the
  only publisher and allocates the incident number/redacted projection.
  `maintenance → city-maintenance`, publish `false`. A submitted
  datasource/dataset/id is never accepted.
- The public incident-create and generic incident schemas do not contain
  internal fields (`assigned_to`, `reporter_type`, `resolution_notes`).
  Status-transition artifacts keep their existing fields but every incident
  PATCH is sent with `publish:false`, so those records never enter the public
  projection until the City service publishes a redacted copy.
- The generic `users` schema cannot set `role` or `permissions_json`; workflow
  registrations create citizen profiles only. Role elevation remains in City
  `/v1/users` administration.
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

## Third source batch (City parity)

The operations the archived coded console offered that the generic dispatcher
cannot express are now dedicated workflow sources:

| Operation | Artifact | Dataset |
| --- | --- | --- |
| `incidents.comment` (structured, internal visibility) | `city-incident-comment.workflow.json` | `city-incidents` |
| `incidents.visibility` | `city-incident-visibility.workflow.json` | `city-incidents` |
| `incidents.upvote` (idempotent per reporter) | `city-incident-upvote.workflow.json` | `city-incidents` |
| `incidents.merge` (multi-record close + primary annotation) | `city-incident-merge.workflow.json` | `city-incidents` |
| `maintenance.schedule` (recurring preventive schedule) | `city-maintenance-schedule.workflow.json` | `city-maintenance` |
| `maintenance.scheduleCheck` (idempotent due scan → work orders) | `city-maintenance-schedule-check.workflow.json` | `city-maintenance` |
| `iotReadings.batch` (CSV → validated reading rows + job record) | `city-iot-batch.workflow.json` | `city-iot-readings` |
| `assets.document` (file metadata → asset attachment entry) | `city-asset-document.workflow.json` | `city-assets` |

`city-incident-merge` closes each duplicate with
`resolution_type:duplicate`/`merged_into` and only extends
`merged_reporter_ids` with duplicates that actually closed; a missing
duplicate is reported as failed and never blocks the merge. `upvote` refuses a
second entry per reporter. `schedule-check` is idempotent by a schedule-run
marker so re-running does not duplicate work orders.

File and approval reads inside these workflows send `X-Workspace-App: city`.
Files uploaded through the workspace form are stored under the app-scoped
common tenant (`<org>:common:city`); a workflow that omits the header reads
the org tenant and gets `404 file_not_found`. This applies to every workflow
node that calls a common capability (`files`, `forms`, `approvals`,
`comments`, …), not to dataset reads.

## Remaining action gap

Regenerated from the artifact files in this directory (23 workflows):
incident create/acknowledge/assign/close/reject/resolve/verify plus the third
batch above, maintenance create/assign/start/complete/cancel/schedule/
schedule-check, CSV ingest (`city-csv-import`), report generation
(`city-generate-report`), IoT batch (`city-iot-batch`) and the generic
create/update/delete/execute dispatcher (`city-workspace-actions`, which also
covers assets, IoT sensors/readings, alerts, budgets, transactions, reports,
users, geofences, ingest jobs, files and notifications). Still without a
dedicated workflow:

- maintenance **photos** — attaching a file to a maintenance record is not yet
  bound (asset documents use the same files pattern and can be copied once the
  maintenance record shape is agreed).
- geospatial operations (coverage, validation, reverse geocode).

Large-file ingest: workspace file fields declare an explicit `maxBytes`
(10 MiB for CSV/documents today). The DX edge allows 25 MiB
(`client_max_body_size 25m`) and the files capability defaults to 25 MiB, so
raising a form's `maxBytes` up to 25 MiB needs no infrastructure change; larger
files would require a chunked upload contract (not implemented).

## Deferred

- **People → IAM provisioning.** Provisioning login identities is a Tier-2/DX
  capability (IAM SDK), not a City dataset write. `city-people-admin` stays
  dataset-backed until the DX member-identity wave adds the SDK operation and
  the form; this is an explicit deferral tracked with the DX workspace
  program, not a silent gap.

The DX action vocabulary declares `create|update|delete|execute`; the status
transitions above are bound with `action=update` and `workflowRef` in the
plugin bundles (see `actions.design.json`).

## Workflow pins

Every bundle form pins its workflow with `workflowRef.checksum` equal to the
**DX portable checksum** DX will store on the imported artifact: sha256 over the
canonical `{nodes, connections, settings}` *including the mandatory
`settings.access.mode=owner-only` policy DX injects on a managed import*. A
stale pin fails the live import with `409 workflow_artifact_not_found`, so the
sources declare the policy themselves and
`npm run plugins:pins` (or `node scripts/workflow-pins.mjs --fix`) verifies and
repairs the pins offline. The artifact test suite enforces the invariant.

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
