# Plugin source sync (City)

Status: 2026-11-14. Applies to the portable City plugin bundles in `plugins/`.
The authoritative contract is the workspace `WORKSPACE_PLUGIN_CONTRACT.md`; the
runtime is the Tier-2 SynapseDX workspace.

## Page catalog and action source

The repository tracks 14 non-public work pages (admin/member roles) plus the
product-owned workflow source they bind. The catalog resource keys are
`assets, incidents, maintenance, iot, iotReadings, alerts, budgets, budgetTransactions, reports, users, geofences, ingest, files, notifications`. Forms bind either a reviewed domain workflow
(create/transition) or the generic `city-workspace-actions` dispatcher, which accepts only the
allowlisted create/update/delete/execute vocabulary for those resources and
writes through the Tier-2 records API with the organization technical
credential. No Tier-3 API is called at runtime.

## Why bundles live in this repository

City owns its product domain source. A plugin bundle is a **portable artifact**,
not a second product implementation:

- it never contains tenant ids, tokens, membership, audit or server metadata;
- it never imports SOS code, roles or resources;
- it never contains JavaScript, HTML, SQL, URLs or credentials (a
  `wsp_`-shaped runtime token in any text field is rejected);
- the DX renderer maps `resource` keys to its own Tier-2 data bindings and the
  signed-in member's server-side role.

An organization administrator imports the bundle into DX, reviews it as a
DRAFT, installs it for the organization and assigns member roles. Tier 3 does
not install, publish or execute anything.

## Commands

```bash
npm run plugins:check
npm run plugins:test
npm run plugins:reseal -- --dry-run
npm run plugins:sync -- --id <dxPluginId> --dry-run
npm run plugins:import -- --file plugins/city-technician-work.plugin.json --dry-run
```

| Command | Network | Effect |
| --- | --- | --- |
| `check` | no | Validates every `plugins/*.plugin.json` (strict schema, provenance, roles, resources, checksum) |
| `reseal` | no | Recomputes the `plugin` checksum after a reviewed edit; optional `--dry-run` |
| `export` | yes (GET) | Writes a DX export snapshot to the tracked `plugins/` path |
| `sync` | yes (GET) | Pulls the published snapshot, writes it only when the checksum changed |
| `import` | yes (POST) | Creates a DRAFT in DX from a validated local bundle |

DX refuses the default export/sync for a plugin that is not published
(`409 plugin_not_published`). Publish and review the plugin first. The DX
console's **Export draft** action uses an explicit authoring query and is not a
repository sync source. `GET /plugins/:id/build` is the canonical published
artifact; it has the same bundle shape and the sync CLI validates it identically.

`--dry-run` performs the same validation and reports what would change without
writing or posting. `check --json` writes a single JSON document to stdout;
warnings and errors stay on stderr.

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `SYNAPSEDX_BASE_URL` | no | Defaults to `https://synapsedx.sbs`; HTTPS only |
| `SYNAPSEDX_TOKEN` | remote commands | DX administrator **session access token**; env only |

The CLI never accepts a token argument (it would leak through process lists),
never prints it, and redacts remote responses to a status code and error code.

## Network contract

- `GET /v1/capabilities/workspaces/plugins/:id/export` returns the bundle
  `{format,formatVersion,plugin,source?,checksum}`. A wrapper object is rejected.
- `POST /v1/capabilities/workspaces/import` accepts the bundle as the request
  body and returns the created DRAFT plugin (id/slug/status).
- Authorization is `Bearer $SYNAPSEDX_TOKEN`; `credentials` and cookies are not
  sent.
- Only public HTTPS base URLs are accepted. `localhost`, `.local`, single-label
  intranet/Docker names, loopback, link-local, IPv6 ULA and RFC1918 addresses
  are rejected so the CLI cannot be pointed at a private service.
- The client refuses HTTP redirects (a redirect could move the bearer token to
  another origin) and caps a response at 2 MiB.
- Remote error codes are restricted to a short safe charset and the token is
  stripped before anything is printed.

## Checksum

The checksum covers the portable **`plugin` definition only**, which is exactly
what DX stores on import and returns on export:

```text
payload   = plugin
canonical = object keys sorted, arrays in order, no whitespace
checksum  = "sha256:" + sha256(utf8(canonical))
```

`source`, `format` and `formatVersion` are envelope/provenance data; bumping a
revision does not change the layout identity. A stale pre-2026-11-14 checksum
that covered the whole wrapper is rejected with a hint; reseal it:

```bash
node scripts/plugin-bundle.mjs reseal            # rewrite changed checksums atomically
node scripts/plugin-bundle.mjs reseal --dry-run  # show what would change
```

`reseal` validates the schema and provenance first, then rewrites only the
`checksum` field. `check --require-checksum` fails when the field is missing; a
present checksum that does not match is always an error. `sync` compares the DX
snapshot checksum **and provenance** with the local file and reports `in-sync`
only when both match; a provenance-only change is written as `updated`.

`plugins/README.md` is owned by the plugin content authors and may still
describe the retired full-payload checksum; this document and
`scripts/plugin-bundle.mjs` are authoritative for sync and validation.

## Provenance and repository matching

- `source.repository` must be this product's public GitHub repository
  (`https://github.com/vku-open-source-2026/SynapseCity`). `.git` and trailing
  slash variants are accepted. A bundle naming the SOS repository is rejected,
  so `sync` can only write a City bundle into the City repo.
- `source.path` must be a `plugins/<name>.plugin.json` path and must equal the
  tracked file. `check` fails on a mismatch; it is not a warning.
- `export`/`sync` target: `--out`, else `source.path`, else
  `plugins/<slug>.plugin.json`. If DX stores a different path, the command
  refuses to write; either use the matching `--out` or pass `--remap-source`,
  which rewrites only `source.path` (the plugin checksum is unchanged).
- A DX export without `source` is accepted on a first export: the CLI adds
  `{repository, path}` for the target file before validating.
- `source.revision` is a short provenance label (`A-Za-z0-9._-`, 1..100).

## Failure modes

- Invalid bundle: non-zero exit, every error printed, nothing written/imported.
- Path outside `plugins/`, absolute path, `..` or `.` segment, backslash or
  symlink escape: rejected before any file is read or written.
- Cross-product or foreign-repository provenance: rejected; no file is written.
- Tampered checksum: rejected. Review the diff, then `reseal` only if the change
  is intentional.
- Token-shaped text: rejected; nothing is written and no token is ever printed.
- Missing token: exit code 2 with a reminder; no request is made.
- DX returns non-2xx: only the status and a short error code are printed.
- Network error, redirect or oversized response: exit 1; the token is never
  included in output.

## Writes are workflow-bound, not Tier-3 API calls

The declarative bundles are read-only until the persistence connector and
end-to-end binding exist. The widget schema already supports workflow binding:
a portable bundle may carry `workflowRef`, which DX resolves to
`workflowArtifactId` plus `workflowArtifactRevision`/`workflowArtifactChecksum`
pins. A form is submittable only when DX reports `canSubmit: true`; an unbound
form returns `409 mutation_not_supported`, never a fake success. A form without
`workflowRef` is schema-valid and explicitly non-submittable in DX.

Source artifacts live in `plugins/workflows/`. Creates POST to the Tier-2
records API; transitions use the Tier-1 `httpRequest` `includeInput:true` option
(GET returns `{statusCode,body,input}`) to merge the action into the full record
and PATCH with `ifVersion` optimistic CAS. Event close creates the AAR draft
before resolving the event. Auth is the portable
`credentialRef:synapsedx-organization` / `X-API-Key`; DX binds it to the per-org
owner-only encrypted api-key, rebinds on export and checks the runtime artifact
checksum.

Plugin bundles bind forms with `workflowRef` and action `create`/`update`; DX
resolves pins and exposes `canSubmit`, rejecting unbound forms. Run
`npm run test:workflow-artifacts`, `npm run test:workflow-engine` and
`npm run workflows:validate`.

Do **not** deploy the public-only redirects or retire the production work pages
until that binding is verified end to end.

## Repository workflow

1. Edit the bundle (or `sync` a DX export), then `npm run plugins:check`.
2. If the plugin definition changed, run `npm run plugins:reseal` and re-review
   the diff. Provenance-only edits do not change the checksum.
3. Run `node scripts/plugin-bundle.mjs check --require-checksum`.
4. Review the diff, then commit through the normal repository process.
5. Import/install/publish in DX through the DX UI (the CLI only creates drafts).

The CLI does not run git, commit, push, deploy or open a network listener. It
does not execute bundle or TSX content. Source provenance for the retired
Tier-3 work routes is archived in `plugins/source/`.
