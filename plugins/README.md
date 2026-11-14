# City workspace plugins (Tier 3 source → Tier 2 DX runtime)

Status: 2026-11-14 workspace contract. Tier 3 is public presentation only.

SynapseCity no longer serves login, registration, operations dashboards or the
technician portal. All work interfaces live in the Tier-2 SynapseDX workspace at
`https://synapsedx.sbs/workspace`, where an organization administrator installs
these product plugins for the organization. This directory is the source of
truth for the City plugin artifacts that an administrator imports into DX.

| File | Audience | Roles | Purpose |
| --- | --- | --- | --- |
| `city-operations-overview.plugin.json` | admin | `admin`, `manager` | Operations command center: assets, incidents, maintenance, alerts, IoT, budgets, reports and operators |
| `city-asset-registry.plugin.json` | admin | `admin`, `manager` | Asset lifecycle, registration, update and retirement with geofence context |
| `city-incident-desk.plugin.json` | admin | `admin`, `manager` | Incident intake, assignment, acknowledge, resolve, verify, reject and close |
| `city-maintenance-workshop.plugin.json` | admin | `admin`, `manager` | Work-order planning, assignment, start, complete, cancel and review |
| `city-alert-center.plugin.json` | admin | `admin`, `manager` | Alert feed, creation, acknowledgement, resolution and dismissal |
| `city-iot-network.plugin.json` | admin | `admin`, `manager` | Sensor registry, sensor lifecycle and reading ingest |
| `city-budget-office.plugin.json` | admin | `admin`, `manager` | Budgets, transactions, approvals and rejection review |
| `city-report-studio.plugin.json` | admin | `admin`, `manager` | Report requests, status transitions and report history |
| `city-gis-workspace.plugin.json` | admin | `admin`, `manager` | Asset, incident and geofence location context |
| `city-people-admin.plugin.json` | admin | `admin` | City operator directory and profile lifecycle |
| `city-data-ingest.plugin.json` | admin | `admin`, `manager` | Ingest job queue, progress and file references |
| `city-manager-review.plugin.json` | admin | `admin`, `manager` | Cross-domain approval and incident-verification lane |
| `city-technician-work.plugin.json` | member | `technician` | Technician work queue, asset context and work notes |
| `city-volunteer-desk.plugin.json` | member | `volunteer` | Volunteer incident/alert picture and public-style incident reporting |

The declarative bundles contain metrics, tables and **workflow-bound form
widgets**. A form carries `workflowRef` (portable) and `action`
(`create`/`update`); DX resolves the ref at import/install/publish to
`workflowArtifactId` + revision/checksum pins and reports `canSubmit`. An
unbound form is rejected with `409 mutation_not_supported`, never a fake
success.

Operation migration is in `plugins/workflows/`:

- **Creates**: `manualTrigger` → domain validation of the DX envelope →
  `httpRequest` POST to the Tier-2 records API with `{ data, publish }`.
- **Transitions**: `manualTrigger` → validation → **GET with
  `includeInput:true`** → code state/invariant check + full-record merge →
  **PATCH `{ data, ifVersion }`** (optimistic CAS). This covers
  incidents.assign/resolve and maintenance assign/start/complete.
- Datasets/publish are server-derived; no submitted datasource/id is accepted.
- Auth is the portable `{credentialRef:"synapsedx-organization",
  header:"X-API-Key"}`; DX binds it to the per-org owner-only encrypted
  api-key, rebinds on export and verifies runtime artifact checksums.
- Tier-2 PATCH returns `409 version_conflict` on a stale `ifVersion`; the
  engine fails the run instead of silently overwriting. There is no
  multi-record transaction (event close creates the AAR draft first).

`npm run test:workflow-engine` executes the definitions in the real Tier-1
engine with fake HTTP and proves creates, transition merge/PATCH, AAR-before-
event-patch, terminal refusal, CAS conflict propagation and malformed-form
zero-call behavior.

Still not migrated: approve/merge/verify flows, budget/alert/report/IoT/user/
ingest/geospatial actions, and the remaining SOS approval/publication actions.
They have no workflow/action binding yet; do not treat the current bundles as
full replacement. Do not deploy the public-only redirects or retire production
work pages until the bound actions are verified end to end.

## Bundle format

```json
{
  "format": "synapsedx-plugin",
  "formatVersion": 1,
  "plugin": {
    "product": "city",
    "name": "City operations overview",
    "slug": "city-operations-overview",
    "audience": "admin",
    "roles": ["admin", "manager"],
    "widgets": []
  },
  "source": {
    "repository": "https://github.com/vku-open-source-2026/SynapseCity",
    "path": "plugins/city-operations-overview.plugin.json",
    "revision": "2026-11-14"
  },
  "checksum": "sha256:<64 lowercase hex>"
}
```

- `plugin` uses only contract fields. `id`, `status`, `version`, tenant and
  membership fields are server-owned and rejected on import.
- `source.repository` must be a public GitHub HTTPS URL. `source.path` must be a
  safe repository-relative `plugins/*.json` path. `revision` is a short
  provenance label.
- Widgets use only `text`, `metric`, `table` and `form`, and bind a City catalog
  key (`assets`, `incidents`, `maintenance`, `iot`, `iotReadings`, `alerts`,
  `budgets`, `budgetTransactions`, `reports`, `users`, `geofences`, `ingest`,
  `files`, `notifications`) — never a URL.
- A `form` widget may carry a portable `workflowRef` (`{name, slug?, checksum?}`);
  DX resolves it to server-owned `workflowArtifactId` + revision/checksum pins.
  `workflowArtifactId`, `workflowArtifactRevision` and `workflowArtifactChecksum`
  are rejected in portable bundles.
- Roles are limited to non-public City roles: `admin`, `manager`, `technician`,
  `volunteer`. `citizen`/anonymous is rejected: the workspace is for members,
  not the public.
- Text is plain text: angle brackets and control characters are rejected, so a
  bundle cannot smuggle HTML/script. Resources, columns and field names are
  identifiers, so a bundle cannot inject SQL/URLs.

### Checksum

`checksum` is optional and verifies content integrity:

1. take the portable `plugin` definition only; `format`, `formatVersion`,
   `source` and the `checksum` field are **not** part of the payload, so a
   provenance-only edit does not change layout identity;
2. serialize deterministically: object keys sorted lexicographically, no
   whitespace, arrays in order (see `canonicalJson` in
   `scripts/lib/plugin-bundle.mjs`);
3. SHA-256 the UTF-8 bytes and write `sha256:<lowercase hex>`.

The CLI verifies a checksum when present, `check --require-checksum` demands it,
and `export`/`sync` report the checksum of the DX snapshot. DX may export the
same optional field; a mismatch is a hard error, never a warning.

## CLI

```bash
npm run plugins:check                       # validate every plugins/*.plugin.json
node scripts/plugin-bundle.mjs check --file plugins/city-technician-work.plugin.json --require-checksum
npm run plugins:test                        # CLI + validator tests

# Pull the published snapshot from DX into this repository (HTTPS, admin token)
export SYNAPSEDX_TOKEN=...                  # env only; never passed as an argument
npm run plugins:sync -- --id <dxPluginId> --dry-run
npm run plugins:sync -- --id <dxPluginId>

# Import a local bundle as a DRAFT (never auto-installs/publishes)
npm run plugins:import -- --file plugins/city-technician-work.plugin.json
npm run plugins:export -- --id <dxPluginId> --out plugins/city-operations-overview.plugin.json --force
```

Rules enforced by the CLI:

- Remote base URL is HTTPS only, with no credentials, query or fragment. It
  rejects `localhost`, `.local` and private IP ranges.
- `--file`, `--out` and `source.path` resolve inside this repository's
  `plugins/` directory. Absolute paths, `..`, backslashes and symlink escapes
  are rejected.
- The administrator token comes only from `SYNAPSEDX_TOKEN` and is never
  printed, logged or embedded in a bundle. HTTP responses are summarised by
  status/code, not dumped.
- The CLI never runs git, never commits, never pushes and never deploys.
- Bundles are declarative JSON. The CLI never imports, evaluates or executes
  bundle or TSX content.

## Retired route source

`plugins/source/` is an exact snapshot from git HEAD of the Tier-3 route files
that were replaced by redirects (login, register, admin and technician routes),
with `manifest.json` (revision, original path, SHA-256 per file) and this
provenance. The console build does not import or mount it; the files are
reference source for migrating business UI into declarative widgets. See
`plugins/source/README.md`.

The page/component modules those routes rendered (for example
`apps/console/src/pages/admin/*`) remain in the console source tree as
**unmounted** modules: no route references them, nginx and the root route
redirect the old paths, and the production bundle never mounts them.

## Boundary

These bundles are City-only. They must not reference SOS resources, roles,
datasets or APIs, and no SOS code or bundle is imported here. DX installs the
plugin for an organization and enforces membership role server-side; the widget
renderer never grants rights, impersonates a user or calls a Tier-3 API for
domain mutations.
